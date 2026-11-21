/**
 * Focused coverage for recordPresenceChange (src/api/presence.ts). The sibling
 * presence helpers already have dedicated suites; this pins only the write
 * path: the batched stream stamp, the serialized fallback, and the final
 * legacy unstamped write for databases without a stream_position column.
 */
import { describe, it, expect } from 'vitest';
import { recordPresenceChange } from '../src/api/presence';

type Bound = { sql: string; args: unknown[] };

interface StubOpts {
  failBatch?: boolean;
  failPositionUpdate?: boolean;
  failStampedInsert?: boolean;
  /** Position row returned by the fallback SELECT. Defaults to { position: 7 }. */
  positionRow?: { position: number } | null;
}

function makeDb(opts: StubOpts = {}) {
  const batchCalls: Bound[][] = [];
  const runs: Bound[] = [];
  const firsts: Bound[] = [];

  function prepare(sql: string) {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.args = args;
        return stmt;
      },
      async run() {
        runs.push({ sql, args: [...stmt.args] });
        if (
          sql.includes(`UPDATE stream_positions SET position = position + 1`) &&
          opts.failPositionUpdate
        ) {
          throw new Error('position update unavailable');
        }
        if (
          sql.includes('INSERT INTO presence') &&
          sql.includes('stream_position') &&
          opts.failStampedInsert
        ) {
          throw new Error('stamped insert unavailable');
        }
        return { meta: { changes: 1 } };
      },
      async first<T>() {
        firsts.push({ sql, args: [...stmt.args] });
        if (sql.includes('SELECT position FROM stream_positions')) {
          return ('positionRow' in opts ? opts.positionRow : { position: 7 }) as T;
        }
        return null as T;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
    };
    return stmt;
  }

  const db = {
    prepare,
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      batchCalls.push(stmts.map((s) => ({ sql: s.sql, args: [...s.args] })));
      if (opts.failBatch) throw new Error('batch unavailable');
      return [];
    },
  };

  return { db: db as unknown as D1Database, batchCalls, runs, firsts };
}

const ROW = {
  userId: '@alice:example.com',
  presence: 'online',
  statusMsg: 'here',
  lastActiveTs: 1_700_000_000_000,
  currentlyActive: true,
};

const BIND_ROW = [ROW.userId, ROW.presence, ROW.statusMsg, ROW.lastActiveTs, 1];

describe('recordPresenceChange — batched stream stamp', () => {
  it('bumps the counter and upserts the stamped row in one batch', async () => {
    const { db, batchCalls, runs, firsts } = makeDb();

    await recordPresenceChange(db, ROW);

    expect(batchCalls).toHaveLength(1);
    const [counter, insert] = batchCalls[0];
    expect(counter.sql).toContain(
      `UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'presence'`
    );
    expect(counter.args).toEqual([]);
    expect(insert.sql).toContain(
      'INSERT INTO presence (user_id, presence, status_msg, last_active_ts, currently_active, stream_position)'
    );
    expect(insert.sql).toContain(`SELECT ?, ?, ?, ?, ?, COALESCE((SELECT position FROM stream_positions WHERE stream_name = 'presence'), 0)`);
    expect(insert.sql).toContain('ON CONFLICT (user_id) DO UPDATE SET');
    expect(insert.args).toEqual(BIND_ROW);
    // A successful batch returns early: no serialized fallback statements.
    expect(runs).toHaveLength(0);
    expect(firsts).toHaveLength(0);
  });

  it('maps currentlyActive=false to 0 and binds a null status message', async () => {
    const { db, batchCalls } = makeDb();

    await recordPresenceChange(db, {
      ...ROW,
      presence: 'offline',
      statusMsg: null,
      currentlyActive: false,
    });

    expect(batchCalls[0][1].args).toEqual([ROW.userId, 'offline', null, ROW.lastActiveTs, 0]);
  });

  it('uses the caller timestamp verbatim rather than the clock', async () => {
    const { db, batchCalls } = makeDb();

    await recordPresenceChange(db, { ...ROW, lastActiveTs: 42 });

    expect(batchCalls[0][1].args[3]).toBe(42);
  });
});

describe('recordPresenceChange — serialized fallback', () => {
  it('reads the bumped position and stamps the row with it', async () => {
    const { db, runs, firsts } = makeDb({ failBatch: true, positionRow: { position: 7 } });

    await recordPresenceChange(db, ROW);

    expect(runs[0].sql).toContain('UPDATE stream_positions SET position = position + 1');
    expect(firsts).toEqual([
      {
        sql: expect.stringContaining('SELECT position FROM stream_positions WHERE stream_name = ?'),
        args: ['presence'],
      },
    ]);
    expect(runs[1].sql).toContain(
      'INSERT INTO presence (user_id, presence, status_msg, last_active_ts, currently_active, stream_position)'
    );
    expect(runs[1].sql).toContain('VALUES (?, ?, ?, ?, ?, ?)');
    expect(runs[1].sql).toContain('ON CONFLICT (user_id) DO UPDATE SET');
    expect(runs[1].args).toEqual([...BIND_ROW, 7]);
  });

  it('falls back to position 1 when the stream position row is missing', async () => {
    const { db, runs } = makeDb({ failBatch: true, positionRow: null });

    await recordPresenceChange(db, ROW);

    expect(runs[1].args).toEqual([...BIND_ROW, 1]);
  });

  it('uses position 0 when the counter update itself throws', async () => {
    const { db, runs, firsts } = makeDb({ failBatch: true, failPositionUpdate: true });

    await recordPresenceChange(db, ROW);

    expect(runs[0].sql).toContain('UPDATE stream_positions SET position = position + 1');
    expect(firsts).toHaveLength(0);
    expect(runs[1].args).toEqual([...BIND_ROW, 0]);
  });

  it('keeps the legacy unstamped write when the stamped INSERT fails', async () => {
    const { db, runs } = makeDb({ failBatch: true, failStampedInsert: true });

    await recordPresenceChange(db, ROW);

    const legacy = runs[runs.length - 1];
    expect(legacy.sql).toContain('INSERT INTO presence (user_id, presence, status_msg, last_active_ts)');
    expect(legacy.sql).toContain('VALUES (?, ?, ?, ?)');
    expect(legacy.sql).toContain('ON CONFLICT (user_id) DO UPDATE SET');
    expect(legacy.sql).not.toContain('stream_position');
    expect(legacy.args).toEqual(BIND_ROW.slice(0, 4));
  });
});
