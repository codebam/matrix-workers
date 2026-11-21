/**
 * Focused helper test for the uncovered registry readers/writer in
 * src/services/bots.ts (getBotById, listBots, setBotEnabled). Stub D1 records
 * the SQL, binds and writes issued by each helper; no product code is touched.
 */
import { describe, it, expect } from 'vitest';
import {
  getBotById,
  listBots,
  setBotEnabled,
  type BotRow,
} from '../src/services/bots';

type Call = { sql: string; args: unknown[] };

function makeDb(options: {
  byId?: BotRow | null;
  listed?: BotRow[];
  listedUndefined?: boolean;
} = {}) {
  const prepares: string[] = [];
  const binds: Call[] = [];
  const runs: Call[] = [];

  const makeStmt = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...next: unknown[]) {
        args = [...next];
        return this;
      },
      async first<T>() {
        binds.push({ sql, args: [...args] });
        return (options.byId === undefined ? null : options.byId) as T | null;
      },
      async all<T>() {
        binds.push({ sql, args: [...args] });
        return {
          results: options.listedUndefined
            ? undefined
            : (options.listed ?? []),
        } as unknown as { results: T[] };
      },
      async run() {
        runs.push({ sql, args: [...args] });
        return { meta: { changes: 1 } };
      },
    };
  };

  const db = {
    prepare(sql: string) {
      prepares.push(sql);
      return makeStmt(sql);
    },
  };

  return { db: db as unknown as D1Database, prepares, binds, runs };
}

const BOT: BotRow = {
  id: 'bot-1',
  user_id: '@bot:example.com',
  kind: 'admin',
  command_prefix: '!admin',
  enabled: 1,
  created_at: 1_700_000_000_000,
};

describe('getBotById', () => {
  it('selects by id, binds the id and returns the matching row', async () => {
    const { db, prepares, binds, runs } = makeDb({ byId: BOT });
    await expect(getBotById(db, 'bot-1')).resolves.toEqual(BOT);

    expect(prepares).toEqual([expect.stringContaining('FROM bots WHERE id = ?')]);
    expect(binds).toEqual([{ sql: expect.stringContaining('FROM bots WHERE id = ?'), args: ['bot-1'] }]);
    expect(runs).toEqual([]);
  });

  it('returns null when no row has that id', async () => {
    const { db } = makeDb({ byId: null });
    await expect(getBotById(db, 'missing')).resolves.toBeNull();
  });
});

describe('listBots', () => {
  it('returns all rows ordered by creation time', async () => {
    const second: BotRow = { ...BOT, id: 'bot-2', user_id: '@relay:example.com', kind: 'telegram', created_at: BOT.created_at + 1 };
    const { db, prepares, binds, runs } = makeDb({ listed: [BOT, second] });

    await expect(listBots(db)).resolves.toEqual([BOT, second]);
    expect(prepares).toEqual([expect.stringContaining('FROM bots ORDER BY created_at')]);
    expect(binds).toEqual([{ sql: expect.stringContaining('FROM bots ORDER BY created_at'), args: [] }]);
    expect(runs).toEqual([]);
  });

  it('returns [] when D1 reports no results array', async () => {
    const { db } = makeDb({ listedUndefined: true });
    await expect(listBots(db)).resolves.toEqual([]);
  });
});

describe('setBotEnabled', () => {
  it('binds 1 for enabled', async () => {
    const { db, prepares, runs } = makeDb();
    await expect(setBotEnabled(db, 'bot-1', true)).resolves.toBeUndefined();

    expect(prepares).toEqual(['UPDATE bots SET enabled = ? WHERE id = ?']);
    expect(runs).toEqual([{ sql: 'UPDATE bots SET enabled = ? WHERE id = ?', args: [1, 'bot-1'] }]);
  });

  it('binds 0 for disabled', async () => {
    const { db, runs } = makeDb();
    await setBotEnabled(db, 'bot-2', false);
    expect(runs).toEqual([{ sql: 'UPDATE bots SET enabled = ? WHERE id = ?', args: [0, 'bot-2'] }]);
  });
});
