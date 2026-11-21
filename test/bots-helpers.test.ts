/**
 * Focused coverage for the three `src/services/bots.ts` registry helpers that
 * `bots-integrations.test.ts` does not touch: getBotById, listBots and
 * setBotEnabled. A minimal stub D1 pins only source behaviour (SQL shape,
 * bound parameters and return/null handling) — no product code is exercised.
 */
import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { getBotById, listBots, setBotEnabled, type BotRow } from '../src/services/bots';

type Call = { sql: string; args: unknown[] };

function bot(overrides: Partial<BotRow> = {}): BotRow {
  return {
    id: 'bot1',
    user_id: '@bot1:example.com',
    kind: 'admin',
    command_prefix: '!admin',
    enabled: 1,
    created_at: 100,
    ...overrides,
  };
}

function makeBotsDb(opts: { rows?: BotRow[]; nullResults?: boolean } = {}) {
  const bots = new Map<string, BotRow>((opts.rows ?? []).map((r) => [r.id, { ...r }]));
  const calls: Call[] = [];

  function terminal(sql: string, args: unknown[]) {
    return {
      async first<T>(): Promise<T | null> {
        calls.push({ sql, args });
        if (sql.includes('FROM bots WHERE id = ?')) {
          const row = bots.get(args[0] as string);
          return (row ? { ...row } : null) as T | null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] | null }> {
        calls.push({ sql, args });
        if (sql.includes('FROM bots ORDER BY created_at')) {
          return {
            results: opts.nullResults
              ? null
              : [...bots.values()].map((r) => ({ ...r })) as T[],
          };
        }
        return { results: [] as T[] };
      },
      async run() {
        calls.push({ sql, args });
        if (sql.includes('UPDATE bots SET enabled = ?')) {
          const [enabled, id] = args as [number, string];
          const row = bots.get(id);
          if (row) row.enabled = enabled;
          return { meta: { changes: row ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }

  return {
    bots,
    calls,
    prepare(sql: string) {
      return {
        ...terminal(sql, []),
        bind: (...args: unknown[]) => terminal(sql, args),
      };
    },
  };
}

const asDb = (db: ReturnType<typeof makeBotsDb>) => db as unknown as D1Database;

describe('getBotById', () => {
  it('selects by id and returns the matching row', async () => {
    const row = bot();
    const db = makeBotsDb({ rows: [row] });

    expect(await getBotById(asDb(db), 'bot1')).toEqual(row);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('FROM bots WHERE id = ?');
    expect(db.calls[0].args).toEqual(['bot1']);
  });

  it('returns null when no bot has that id', async () => {
    const db = makeBotsDb({ rows: [bot()] });

    expect(await getBotById(asDb(db), 'missing')).toBeNull();
  });
});

describe('listBots', () => {
  it('returns all rows ordered by created_at without binding arguments', async () => {
    const first = bot({ id: 'a', created_at: 1 });
    const second = bot({ id: 'b', user_id: '@b:example.com', created_at: 2 });
    const db = makeBotsDb({ rows: [first, second] });

    expect(await listBots(asDb(db))).toEqual([first, second]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('FROM bots ORDER BY created_at');
    expect(db.calls[0].args).toEqual([]);
  });

  it('coalesces a null results array to an empty array', async () => {
    const db = makeBotsDb({ nullResults: true });

    expect(await listBots(asDb(db))).toEqual([]);
  });
});

describe('setBotEnabled', () => {
  it('binds 1 for true and flips the row to enabled', async () => {
    const db = makeBotsDb({ rows: [bot({ enabled: 0 })] });

    await setBotEnabled(asDb(db), 'bot1', true);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('UPDATE bots SET enabled = ? WHERE id = ?');
    expect(db.calls[0].args).toEqual([1, 'bot1']);
    expect(db.bots.get('bot1')!.enabled).toBe(1);
  });

  it('binds 0 for false and flips the row to disabled', async () => {
    const db = makeBotsDb({ rows: [bot({ enabled: 1 })] });

    await setBotEnabled(asDb(db), 'bot1', false);

    expect(db.calls[0].args).toEqual([0, 'bot1']);
    expect(db.bots.get('bot1')!.enabled).toBe(0);
  });
});
