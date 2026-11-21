/**
 * Focused helper test for recordPresenceChange (src/api/presence.ts).
 * Pins the write contract: the atomic batch bump+stamp, active-flag conversion,
 * and both degradation paths for databases / test doubles without a working
 * stream counter or stream_position column.
 */
import { describe, it, expect } from 'vitest';
import { recordPresenceChange } from '../src/api/presence';

type Call = { sql: string; args: unknown[] };
type Stmt = {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
};

function makeDb(options: {
  failBatch?: boolean;
  failStreamUpdate?: boolean;
  failStampedInsert?: boolean;
  streamPosition?: number | null;
} = {}) {
  const batchBodies: Stmt[][] = [];
  const runCalls: Call[] = [];
  const firstCalls: Call[] = [];
  const streamPosition = options.streamPosition === undefined ? 7 : options.streamPosition;

  const makeStmt = (sql: string): Stmt => {
    const stmt: Stmt = {
      sql,
      args: [],
      bind(...args: unknown[]) {
        stmt.args = [...args];
        return stmt;
      },
      async run() {
        runCalls.push({ sql, args: [...stmt.args] });
        if (sql.includes('UPDATE stream_positions') && options.failStreamUpdate) {
          throw new Error('stream_positions update failed');
        }
        if (sql.includes('VALUES (?, ?, ?, ?, ?, ?)') && options.failStampedInsert) {
          throw new Error('stamped presence insert failed');
        }
        return { meta: { changes: 1 } };
      },
      async first<T>() {
        firstCalls.push({ sql, args: [...stmt.args] });
        if (sql.includes('SELECT position FROM stream_positions')) {
          return (streamPosition === null ? null : { position: streamPosition }) as T;
        }
        return null as T;
      },
    };
    return stmt;
  };

  const db = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(stmts: Stmt[]) {
      batchBodies.push(stmts);
      if (options.failBatch) throw new Error('batch() unavailable');
      return [];
    },
  };

  return { db: db as unknown as D1Database, batchBodies, runCalls, firstCalls };
}

const ROW = {
  userId: '@alice:example.com',
  presence: 'online',
  statusMsg: 'here',
  lastActiveTs: 1_700_000_000_000,
  currentlyActive: true,
};

describe('recordPresenceChange', () => {
  it('bumps the stream counter and stamps the row in one batch', async () => {
    const { db, batchBodies, runCalls, firstCalls } = makeDb();
    await recordPresenceChange(db, ROW);

    expect(batchBodies).toHaveLength(1);
    const [bump, insert] = batchBodies[0];
    expect(bump.sql).toContain("UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'presence'");
    expect(bump.args).toEqual([]);
    expect(insert.sql).toContain('INSERT INTO presence');
    expect(insert.sql).toContain('COALESCE((SELECT position FROM stream_positions');
    expect(insert.args).toEqual([ROW.userId, ROW.presence, ROW.statusMsg, ROW.lastActiveTs, 1]);
    // The atomic batch commits both statements; no per-statement fallback work.
    expect(runCalls).toEqual([]);
    expect(firstCalls).toEqual([]);
  });

  it('stores currently_active = 0 for an inactive row', async () => {
    const { db, batchBodies } = makeDb();
    await recordPresenceChange(db, {
      ...ROW,
      presence: 'offline',
      statusMsg: null,
      currentlyActive: false,
    });
    expect(batchBodies[0][1].args).toEqual([ROW.userId, 'offline', null, ROW.lastActiveTs, 0]);
  });

  it('falls back to a read-then-stamped insert when batch() throws', async () => {
    const { db, batchBodies, runCalls, firstCalls } = makeDb({ failBatch: true, streamPosition: 42 });
    await recordPresenceChange(db, ROW);

    expect(batchBodies).toHaveLength(1); // attempted once
    expect(runCalls).toHaveLength(2);
    expect(runCalls[0].sql).toContain('UPDATE stream_positions');
    expect(runCalls[0].args).toEqual([]);
    expect(firstCalls).toEqual([
      { sql: expect.stringContaining('SELECT position FROM stream_positions'), args: ['presence'] },
    ]);
    expect(runCalls[1].sql).toContain('VALUES (?, ?, ?, ?, ?, ?)');
    expect(runCalls[1].args).toEqual([ROW.userId, ROW.presence, ROW.statusMsg, ROW.lastActiveTs, 1, 42]);
  });

  it('stamps position 1 when the stream counter row is missing', async () => {
    const { db, runCalls } = makeDb({ failBatch: true, streamPosition: null });
    await recordPresenceChange(db, ROW);

    expect(runCalls[1].args[5]).toBe(1);
  });

  it('stamps position 0 when the stream counter cannot be bumped', async () => {
    const { db, runCalls, firstCalls } = makeDb({ failBatch: true, failStreamUpdate: true });
    await recordPresenceChange(db, ROW);

    expect(firstCalls).toEqual([]); // read skipped once the bump throws
    expect(runCalls).toHaveLength(2);
    expect(runCalls[1].args[5]).toBe(0);
  });

  it('falls back to the legacy unstamped insert when the stamped insert throws', async () => {
    const { db, runCalls } = makeDb({ failBatch: true, failStampedInsert: true, streamPosition: 3 });
    await recordPresenceChange(db, ROW);

    expect(runCalls).toHaveLength(3);
    expect(runCalls[2].sql).toContain(
      'INSERT INTO presence (user_id, presence, status_msg, last_active_ts)'
    );
    expect(runCalls[2].args).toEqual([ROW.userId, ROW.presence, ROW.statusMsg, ROW.lastActiveTs]);
  });
});
