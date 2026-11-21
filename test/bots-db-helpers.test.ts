/**
 * Focused pins for the three bot-registry helpers that bots-integrations.test.ts
 * does not import: getBotById, listBots and setBotEnabled. A small in-memory D1
 * double records each statement so SQL shape and bind order are pinned too.
 */
import { describe, expect, it } from 'vitest';
import {
  getBotById,
  listBots,
  setBotEnabled,
  type BotRow,
} from '../src/services/bots';

type Query = { sql: string; args: unknown[] };

function bot(partial: Partial<BotRow> = {}): BotRow {
  return {
    id: 'bot-1',
    user_id: '@bot1:example.com',
    kind: 'admin',
    command_prefix: '!admin',
    enabled: 1,
    created_at: 1,
    ...partial,
  };
}

function makeDb(rows: BotRow[], emptyAll = false) {
  const queries: Query[] = [];
  const prepares: string[] = [];

  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        queries.push({ sql, args: bindArgs });
        return stmt(sql, bindArgs);
      },
      async first<T>(): Promise<T | null> {
        const row = rows.find((r) => r.id === args[0]);
        return (row ? { ...row } : null) as T | null;
      },
      async all<T>(): Promise<{ results?: T[] }> {
        return emptyAll ? {} : { results: rows.map((r) => ({ ...r }) as T) };
      },
      async run() {
        const [enabled, id] = args as [number, string];
        const row = rows.find((r) => r.id === id);
        if (row) row.enabled = enabled;
        return { meta: { changes: row ? 1 : 0 } };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      prepares.push(sql);
      return stmt(sql);
    },
  } as unknown as D1Database;

  return { db, rows, queries, prepares };
}

describe('bot registry D1 helpers', () => {
  it('getBotById fetches by id without filtering on enabled', async () => {
    const rows = [bot({ id: 'bot-off', enabled: 0 }), bot({ id: 'bot-on', enabled: 1 })];
    const { db, queries } = makeDb(rows);

    expect(await getBotById(db, 'bot-off')).toEqual(rows[0]);
    expect(await getBotById(db, 'missing')).toBeNull();

    const select = 'SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots WHERE id = ?';
    expect(queries).toEqual([
      { sql: select, args: ['bot-off'] },
      { sql: select, args: ['missing'] },
    ]);
  });

  it('listBots returns every stored row ordered by created_at', async () => {
    const rows = [bot({ id: 'a', created_at: 1 }), bot({ id: 'b', created_at: 2, enabled: 0 })];
    const { db, queries, prepares } = makeDb(rows);

    expect(await listBots(db)).toEqual(rows);
    expect(prepares).toEqual([
      'SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots ORDER BY created_at',
    ]);
    expect(queries).toEqual([]); // listBots does not bind anything
  });

  it('listBots normalises a missing results array to an empty list', async () => {
    const { db } = makeDb([bot()], true);

    expect(await listBots(db)).toEqual([]);
  });

  it('setBotEnabled binds the flag first and the id second', async () => {
    const rows = [bot({ id: 'toggle' })];
    const { db, queries } = makeDb(rows);

    await setBotEnabled(db, 'toggle', false);
    expect(rows[0].enabled).toBe(0);
    await setBotEnabled(db, 'toggle', true);
    expect(rows[0].enabled).toBe(1);

    const update = 'UPDATE bots SET enabled = ? WHERE id = ?';
    expect(queries).toEqual([
      { sql: update, args: [0, 'toggle'] },
      { sql: update, args: [1, 'toggle'] },
    ]);
  });
});
