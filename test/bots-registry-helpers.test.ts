// Focused tests for the bots registry helpers that had no direct coverage:
// getBotById, listBots and setBotEnabled. The D1 binding is a small in-memory
// stub that answers only the statements these three helpers issue.
import { describe, expect, it } from 'vitest';
import type { BotRow } from '../src/services/bots';
import { getBotById, listBots, setBotEnabled } from '../src/services/bots';

function makeDb(seed: BotRow[]) {
  const bots = seed.map((bot) => ({ ...bot }));

  function statement(sql: string, args: unknown[]) {
    const q = sql.replace(/\s+/g, ' ').trim();
    return {
      async run() {
        if (q.includes('UPDATE bots SET enabled')) {
          const [enabled, id] = args as [number, string];
          const bot = bots.find((row) => row.id === id);
          if (bot) bot.enabled = enabled;
        }
        return { success: true };
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (q.includes('ORDER BY created_at')) {
          return {
            results: [...bots].sort((a, b) => a.created_at - b.created_at) as unknown as T[],
          };
        }
        return { results: [] as T[] };
      },
      async first<T>(): Promise<T | null> {
        if (q.includes('FROM bots WHERE id = ?')) {
          return (bots.find((row) => row.id === args[0]) ?? null) as unknown as T | null;
        }
        return null;
      },
    };
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return statement(sql, args);
        },
        ...statement(sql, []),
      };
    },
  };
  return { db: db as unknown as D1Database, bots };
}

function seed(): BotRow[] {
  return [
    { id: 'b2', user_id: '@late:ex', kind: 'telegram', command_prefix: '!tg', enabled: 1, created_at: 200 },
    { id: 'b1', user_id: '@early:ex', kind: 'admin', command_prefix: '!admin', enabled: 1, created_at: 100 },
    { id: 'b3', user_id: '@off:ex', kind: 'admin', command_prefix: '!a', enabled: 0, created_at: 150 },
  ];
}

describe('bots registry helpers', () => {
  it('getBotById returns the full row (including disabled bots), or null', async () => {
    const rows = seed();
    const { db } = makeDb(rows);

    expect(await getBotById(db, 'b3')).toEqual(rows[2]);
    expect(await getBotById(db, 'b1')).toMatchObject({
      id: 'b1',
      user_id: '@early:ex',
      kind: 'admin',
      command_prefix: '!admin',
      enabled: 1,
    });
    expect(await getBotById(db, 'missing')).toBeNull();
  });

  it('listBots returns every bot ordered by created_at', async () => {
    const { db } = makeDb(seed());

    expect((await listBots(db)).map((bot) => bot.id)).toEqual(['b1', 'b3', 'b2']);
  });

  it('setBotEnabled toggles the stored flag without dropping the row', async () => {
    const { db } = makeDb(seed());

    await setBotEnabled(db, 'b1', false);
    expect((await getBotById(db, 'b1'))?.enabled).toBe(0);

    await setBotEnabled(db, 'b1', true);
    expect((await getBotById(db, 'b1'))?.enabled).toBe(1);

    await setBotEnabled(db, 'unknown', true);
    expect(await listBots(db)).toHaveLength(3);
  });
});
