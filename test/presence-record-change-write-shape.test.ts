import { describe, it, expect } from 'vitest';
import { recordPresenceChange } from '../src/api/presence';

// A small D1 double: it records every prepared statement and batch so the
// write-shape decisions in recordPresenceChange can be asserted without a
// binding. The helper is the one exported presence helper with no direct test
// in test/ — the others are pinned by presence-helpers.test.ts and friends.

type Statement = {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): Statement;
  run(): Promise<{ success: boolean }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};

type FakeOptions = {
  batchFails?: boolean;
  position?: { position: number } | null;
  counterReadFails?: boolean;
  stampedInsertFails?: boolean;
};

const STAMPED_VALUES = 'VALUES (?, ?, ?, ?, ?, ?)';
const LEGACY_VALUES = 'VALUES (?, ?, ?, ?)';

function createDb(options: FakeOptions = {}) {
  const prepared: Statement[] = [];
  const batches: Statement[][] = [];

  function prepare(sql: string): Statement {
    const statement: Statement = {
      sql,
      args: [],
      bind(...args: unknown[]) {
        statement.args = args;
        return statement;
      },
      async run() {
        if (options.stampedInsertFails && sql.includes(STAMPED_VALUES)) {
          throw new Error('no stream_position column');
        }
        return { success: true };
      },
      async first<T>() {
        if (options.counterReadFails) throw new Error('no stream_positions table');
        return (options.position ?? null) as T | null;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
    };
    prepared.push(statement);
    return statement;
  }

  return {
    prepared,
    batches,
    prepare,
    async batch(statements: Statement[]) {
      batches.push(statements);
      if (options.batchFails) throw new Error('batch() unavailable');
      return [];
    },
  };
}

const ROW = {
  userId: '@alice:example.org',
  presence: 'online',
  statusMsg: 'around',
  lastActiveTs: 1700000000000,
  currentlyActive: true,
};

describe('recordPresenceChange — write-shape decisions', () => {
  it('bumps the counter and stamps the row in one batch', async () => {
    const db = createDb();

    await recordPresenceChange(db as unknown as D1Database, ROW);

    expect(db.batches).toHaveLength(1);
    const [counter, insert] = db.batches[0];
    expect(counter.sql).toContain('UPDATE stream_positions SET position = position + 1');
    expect(counter.sql).toContain("stream_name = 'presence'");
    expect(insert.sql).toContain('INSERT INTO presence');
    expect(insert.sql).toContain('stream_position');
    expect(insert.sql).toContain('COALESCE');
    expect(insert.args).toEqual([ROW.userId, 'online', 'around', ROW.lastActiveTs, 1]);
    // A successful batch must not fall through to any of the fallback work.
    expect(db.prepared).toHaveLength(2);
  });

  it('encodes an inactive row as 0 and passes a null status_msg through', async () => {
    const db = createDb();

    await recordPresenceChange(db as unknown as D1Database, {
      ...ROW,
      presence: 'offline',
      statusMsg: null,
      currentlyActive: false,
    });

    expect(db.batches[0][1].args).toEqual([
      ROW.userId,
      'offline',
      null,
      ROW.lastActiveTs,
      0,
    ]);
  });

  it('falls back to a stamped single insert when batch() is unavailable', async () => {
    const db = createDb({ batchFails: true, position: { position: 7 } });

    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.filter((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped).toHaveLength(1);
    expect(stamped[0].args).toEqual([
      ROW.userId,
      'online',
      'around',
      ROW.lastActiveTs,
      1,
      7,
    ]);
    expect(
      db.prepared.some((s) => s.sql.includes('SELECT position FROM stream_positions'))
    ).toBe(true);
    expect(
      db.prepared.some((s) => s.sql.includes('UPDATE stream_positions SET position = position + 1'))
    ).toBe(true);
  });

  it('stamps position 1 when the stream counter row is missing', async () => {
    const db = createDb({ batchFails: true, position: null });

    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.find((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped?.args[5]).toBe(1);
  });

  it('stamps position 0 when reading the stream counter throws', async () => {
    const db = createDb({ batchFails: true, counterReadFails: true });

    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.find((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped?.args[5]).toBe(0);
  });

  it('drops to the legacy unstamped insert when the stamped insert fails', async () => {
    const db = createDb({
      batchFails: true,
      position: { position: 2 },
      stampedInsertFails: true,
    });

    await recordPresenceChange(db as unknown as D1Database, ROW);

    const legacy = db.prepared.filter((s) => s.sql.includes(LEGACY_VALUES));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].sql).not.toContain('stream_position');
    expect(legacy[0].args).toEqual([ROW.userId, 'online', 'around', ROW.lastActiveTs]);
  });
});
