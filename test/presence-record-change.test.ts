import { describe, it, expect } from 'vitest';
import { recordPresenceChange } from '../src/api/presence';

/** D1 double that keeps the exact SQL and binds each fallback path issues. */
type Stmt = {
  sql: string;
  binds: unknown[];
  bind(...args: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};

type Options = {
  batchError?: boolean;
  counterRow?: { position: number } | null;
  counterError?: boolean;
  stampedError?: boolean;
};

function makeDb(options: Options = {}) {
  const prepared: Stmt[] = [];
  const batches: Stmt[][] = [];
  const runs: Stmt[] = [];

  function prepare(sql: string): Stmt {
    const stmt: Stmt = {
      sql,
      binds: [],
      bind(...args: unknown[]) {
        stmt.binds = args;
        return stmt;
      },
      async run() {
        runs.push(stmt);
        if (options.counterError && sql.includes('UPDATE stream_positions')) {
          throw new Error('counter unavailable');
        }
        if (
          options.stampedError &&
          sql.includes('INSERT INTO presence') &&
          sql.includes('stream_position')
        ) {
          throw new Error('stamped insert unavailable');
        }
        return { meta: { changes: 1 } };
      },
      async first() {
        return (options.counterRow ?? null) as never;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
    };
    prepared.push(stmt);
    return stmt;
  }

  const db = {
    prepare,
    async batch(stmts: Stmt[]) {
      batches.push(stmts);
      if (options.batchError) throw new Error('batch unavailable');
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };

  return { db: db as unknown as D1Database, prepared, batches, runs };
}

const ROW = {
  userId: '@alice:example.com',
  presence: 'online',
  statusMsg: 'at lunch',
  lastActiveTs: 1_700_000_000_000,
  currentlyActive: true,
};

describe('recordPresenceChange', () => {
  it('bumps the stream counter and stamps the row in one D1 batch', async () => {
    const { db, prepared, batches, runs } = makeDb();
    await recordPresenceChange(db, ROW);

    expect(batches).toHaveLength(1);
    const [bump, upsert] = batches[0];
    expect(bump.sql).toContain('UPDATE stream_positions SET position = position + 1');
    expect(bump.sql).toContain("stream_name = 'presence'");
    expect(upsert.sql).toContain('INSERT INTO presence');
    expect(upsert.sql).toContain('COALESCE((SELECT position FROM stream_positions');
    expect(upsert.sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(upsert.binds).toEqual([
      ROW.userId,
      ROW.presence,
      ROW.statusMsg,
      ROW.lastActiveTs,
      1,
    ]);
    expect(prepared).toHaveLength(2);
    expect(runs).toHaveLength(0);
  });

  it('stores currently_active as 0 for an offline write', async () => {
    const { db, batches } = makeDb();
    await recordPresenceChange(db, {
      ...ROW,
      presence: 'offline',
      statusMsg: null,
      currentlyActive: false,
    });
    expect(batches[0][1].binds).toEqual([
      ROW.userId,
      'offline',
      null,
      ROW.lastActiveTs,
      0,
    ]);
  });

  it('falls back to a stamped INSERT when batch is unavailable', async () => {
    const { db, prepared, runs } = makeDb({
      batchError: true,
      counterRow: { position: 42 },
    });
    await recordPresenceChange(db, ROW);

    expect(runs.some((s) => s.sql.includes('UPDATE stream_positions'))).toBe(true);
    expect(
      prepared.some((s) => s.sql.includes('SELECT position FROM stream_positions'))
    ).toBe(true);
    const stamped = runs.find(
      (s) => s.sql.includes('INSERT INTO presence') && s.sql.includes('VALUES (?, ?, ?, ?, ?, ?)')
    );
    expect(stamped?.binds).toEqual([
      ROW.userId,
      ROW.presence,
      ROW.statusMsg,
      ROW.lastActiveTs,
      1,
      42,
    ]);
    expect(
      runs.some((s) =>
        s.sql.includes('INSERT INTO presence (user_id, presence, status_msg, last_active_ts)')
      )
    ).toBe(false);
  });

  it('uses position 1 when the counter row is missing', async () => {
    const { db, runs } = makeDb({ batchError: true, counterRow: null });
    await recordPresenceChange(db, ROW);
    const stamped = runs.find((s) => s.sql.includes('VALUES (?, ?, ?, ?, ?, ?)'));
    expect(stamped?.binds.at(-1)).toBe(1);
  });

  it('keeps the legacy unstamped write when the whole stream is unavailable', async () => {
    const { db, runs } = makeDb({
      batchError: true,
      stampedError: true,
      counterRow: { position: 7 },
    });
    await recordPresenceChange(db, ROW);
    const legacy = runs.find((s) =>
      s.sql.includes('INSERT INTO presence (user_id, presence, status_msg, last_active_ts)')
    );
    expect(legacy?.binds).toEqual([
      ROW.userId,
      ROW.presence,
      ROW.statusMsg,
      ROW.lastActiveTs,
    ]);
    expect(legacy?.sql).not.toContain('stream_position');
  });
});
