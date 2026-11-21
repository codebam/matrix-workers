import { describe, it, expect } from 'vitest';
import { getBotById, listBots, setBotEnabled } from '../src/services/bots';
import type { BotRow } from '../src/services/bots';

const BOT: BotRow = {
  id: 'botx',
  user_id: '@botx:example.com',
  kind: 'admin',
  command_prefix: '!admin',
  enabled: 1,
  created_at: 1_700_000_000_000,
};

function makeDb(firstResult: BotRow | null = null, allResult?: BotRow[]) {
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const entry = { sql, binds: [] as unknown[] };
      statements.push(entry);
      const stmt = {
        bind(...binds: unknown[]) {
          entry.binds = binds;
          return stmt;
        },
        async first<T>() {
          return firstResult as T | null;
        },
        async all<T>() {
          return { results: (allResult ?? []) as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, statements };
}

describe('getBotById', () => {
  it('selects the full bot row by id', async () => {
    const { db, statements } = makeDb(BOT);
    expect(await getBotById(db, 'botx')).toEqual(BOT);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('FROM bots WHERE id = ?');
    expect(statements[0].binds).toEqual(['botx']);
  });

  it('returns null when the id is unknown', async () => {
    const { db } = makeDb(null);
    expect(await getBotById(db, 'missing')).toBeNull();
  });
});

describe('listBots', () => {
  it('returns every row in creation order', async () => {
    const second: BotRow = { ...BOT, id: 'boty', kind: 'telegram' };
    const { db, statements } = makeDb(null, [BOT, second]);
    expect(await listBots(db)).toEqual([BOT, second]);
    expect(statements[0].sql).toContain('ORDER BY created_at');
    expect(statements[0].binds).toEqual([]);
  });

  it('treats a missing results array as an empty list', async () => {
    const { db } = makeDb(null, undefined);
    expect(await listBots(db)).toEqual([]);
  });
});

describe('setBotEnabled', () => {
  it('binds 1 for enabled', async () => {
    const { db, statements } = makeDb();
    await setBotEnabled(db, 'botx', true);
    expect(statements[0].sql).toBe('UPDATE bots SET enabled = ? WHERE id = ?');
    expect(statements[0].binds).toEqual([1, 'botx']);
  });

  it('binds 0 for disabled', async () => {
    const { db, statements } = makeDb();
    await setBotEnabled(db, 'botx', false);
    expect(statements[0].binds).toEqual([0, 'botx']);
  });
});
