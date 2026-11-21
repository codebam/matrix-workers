import { describe, it, expect } from 'vitest';
import { recordPresenceChange } from '../src/api/presence';

// Focused fake D1 double: no Cloudflare bindings, just records the statements
// the helper prepares/batches so the write-shape decisions can be asserted.
// Mirrors private getNextPresencePosition / recordPresenceChange in
// src/api/presence.ts (neither the fallback chain nor this helper was covered
// by the existing presence-helpers tests).

type Statement = {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): Statement;
  run(): Promise<{ success: boolean }>;
  first(): Promise<unknown>;
  all(): Promise<{ results: unknown[] }>;
};

type Options = {
  batchError?: Error;
  position?: { position: number } | null;
  firstError?: Error;
  runErrorFor?: (sql: string) => boolean;
};

function createDb(opts: Options = {}) {
  const prepared: Statement[] = [];
  const batches: Statement[][] = [];

  const db = {
    prepared,
    batches,
    prepare(sql: string): Statement {
      const stmt: Statement = {
        sql,
        args: [],
        bind(...args: unknown[]) {
          stmt.args = args;
          return stmt;
        },
        async run() {
          if (opts.runErrorFor?.(sql)) throw new Error('run failed');
          return { success: true };
        },
        async first() {
          if (opts.firstError) throw opts.firstError;
          return opts.position ?? null;
        },
        async all() {
          return { results: [] };
        },
      };
      prepared.push(stmt);
      return stmt;
    },
    async batch(stmts: Statement[]) {
      batches.push(stmts);
      if (opts.batchError) throw opts.batchError;
      return [];
    },
  };

  return db;
}

const ROW = {
  userId: '@alice:example.org',
  presence: 'online',
  statusMsg: 'here',
  lastActiveTs: 1234,
  currentlyActive: true,
};

const STAMPED_VALUES = 'VALUES (?, ?, ?, ?, ?, ?)';
const LEGACY_VALUES = 'VALUES (?, ?, ?, ?)';

describe('recordPresenceChange — pure write-shape decisions', () => {
  it('batch-writes the counter bump and the stamped row', async () => {
    const db = createDb();
    await recordPresenceChange(db as unknown as D1Database, ROW);

    expect(db.batches).toHaveLength(1);
    const [counter, insert] = db.batches[0];
    expect(counter.sql).toContain('UPDATE stream_positions');
    expect(insert.sql).toContain('INSERT INTO presence');
    expect(insert.sql).toContain('stream_position');
    expect(insert.args).toEqual([
      '@alice:example.org',
      'online',
      'here',
      1234,
      1,
    ]);
  });

  it('encodes currently_active=false as 0 and passes a null status_msg through', async () => {
    const db = createDb();
    await recordPresenceChange(db as unknown as D1Database, {
      userId: '@bob:example.org',
      presence: 'offline',
      statusMsg: null,
      lastActiveTs: 9,
      currentlyActive: false,
    });

    expect(db.batches[0][1].args).toEqual([
      '@bob:example.org',
      'offline',
      null,
      9,
      0,
    ]);
  });

  it('falls back to a stamped single insert when batch() is unavailable', async () => {
    const db = createDb({
      batchError: new Error('batch not supported'),
      position: { position: 7 },
    });
    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.filter((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped).toHaveLength(1);
    expect(stamped[0].args).toEqual([
      '@alice:example.org',
      'online',
      'here',
      1234,
      1,
      7,
    ]);
    expect(
      db.prepared.some((s) => s.sql.includes('SELECT position FROM stream_positions'))
    ).toBe(true);
  });

  it('uses position 1 when the stream counter row is missing', async () => {
    const db = createDb({
      batchError: new Error('batch not supported'),
      position: null,
    });
    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.find((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped?.args[5]).toBe(1);
  });

  it('uses position 0 when reading the stream counter throws', async () => {
    const db = createDb({
      batchError: new Error('batch not supported'),
      firstError: new Error('no stream_positions table'),
    });
    await recordPresenceChange(db as unknown as D1Database, ROW);

    const stamped = db.prepared.find((s) => s.sql.includes(STAMPED_VALUES));
    expect(stamped?.args[5]).toBe(0);
  });

  it('drops to the legacy unstamped insert when the stamped insert also fails', async () => {
    const db = createDb({
      batchError: new Error('batch not supported'),
      position: { position: 2 },
      runErrorFor: (sql) => sql.includes(STAMPED_VALUES),
    });
    await recordPresenceChange(db as unknown as D1Database, ROW);

    const legacy = db.prepared.filter((s) => s.sql.includes(LEGACY_VALUES));
    expect(legacy).toHaveLength(1);
    expect(legacy[0].sql).not.toContain('stream_position');
    expect(legacy[0].args).toEqual([
      '@alice:example.org',
      'online',
      'here',
      1234,
    ]);
  });
});
