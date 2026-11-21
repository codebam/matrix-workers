/**
 * Focused coverage for the three bot-registry helpers the integration suite
 * does not reference: getBotById, listBots and setBotEnabled. Only the helper
 * SQL and binds are pinned here; command routing is covered elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { getBotById, listBots, setBotEnabled } from '../src/services/bots';
import type { BotRow } from '../src/services/bots';

type Bound = { sql: string; args: unknown[] };

const BOT_ROWS: BotRow[] = [
  { id: 'b1', user_id: '@adminbot:example.com', kind: 'admin', command_prefix: '!admin', enabled: 1, created_at: 10 },
  { id: 'b2', user_id: '@tgbot:example.com', kind: 'telegram', command_prefix: '', enabled: 1, created_at: 20 },
  { id: 'b3', user_id: '@oldbot:example.com', kind: 'admin', command_prefix: '!old', enabled: 0, created_at: 30 },
];

interface StubOpts {
  firstRow?: BotRow | null;
  allRows?: BotRow[] | null;
}

function makeDb(opts: StubOpts = {}) {
  const firsts: Bound[] = [];
  const alls: Bound[] = [];
  const runs: Bound[] = [];

  function prepare(sql: string) {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.args = args;
        return stmt;
      },
      async first<T>() {
        firsts.push({ sql, args: [...stmt.args] });
        if (sql.includes('FROM bots WHERE id = ?')) {
          const matched = BOT_ROWS.find((row) => row.id === stmt.args[0]) ?? null;
          return ('firstRow' in opts ? opts.firstRow : matched) as T;
        }
        return null as T;
      },
      async all<T>() {
        alls.push({ sql, args: [...stmt.args] });
        return { results: ('allRows' in opts ? opts.allRows : BOT_ROWS) as T[] };
      },
      async run() {
        runs.push({ sql, args: [...stmt.args] });
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  return { db: { prepare } as unknown as D1Database, firsts, alls, runs };
}

describe('getBotById', () => {
  it('selects by id and returns the matched bot row', async () => {
    const { db, firsts } = makeDb();

    const row = await getBotById(db, 'b2');

    expect(row).toEqual(BOT_ROWS[1]);
    expect(firsts).toEqual([
      {
        sql: expect.stringContaining(
          'SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots WHERE id = ?'
        ),
        args: ['b2'],
      },
    ]);
  });

  it('returns null when no bot has that id', async () => {
    const { db } = makeDb({ firstRow: null });

    expect(await getBotById(db, 'missing')).toBeNull();
  });
});

describe('listBots', () => {
  it('returns every bot ordered by creation time', async () => {
    const { db, alls } = makeDb();

    const rows = await listBots(db);

    expect(rows).toEqual(BOT_ROWS);
    expect(alls).toEqual([
      {
        sql: expect.stringContaining(
          'SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots ORDER BY created_at'
        ),
        args: [],
      },
    ]);
  });

  it('normalizes a missing results array to an empty list', async () => {
    const { db } = makeDb({ allRows: null });

    expect(await listBots(db)).toEqual([]);
  });

  it('normalizes an undefined results array to an empty list', async () => {
    const { db } = makeDb({ allRows: undefined as unknown as null });

    expect(await listBots(db)).toEqual([]);
  });
});

describe('setBotEnabled', () => {
  it('binds 1 for an enabled bot', async () => {
    const { db, runs } = makeDb();

    await setBotEnabled(db, 'b1', true);

    expect(runs).toEqual([
      { sql: expect.stringContaining('UPDATE bots SET enabled = ? WHERE id = ?'), args: [1, 'b1'] },
    ]);
  });

  it('binds 0 for a disabled bot', async () => {
    const { db, runs } = makeDb();

    await setBotEnabled(db, 'b3', false);

    expect(runs).toEqual([
      { sql: expect.stringContaining('UPDATE bots SET enabled = ? WHERE id = ?'), args: [0, 'b3'] },
    ]);
  });
});
