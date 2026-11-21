// Pin the bot-registry helpers that the integration suite imports but never
// asserts directly: getBotById, listBots and setBotEnabled. They are small,
// deterministic adapters over D1, so a recording fake is enough to fix their
// SQL, bind order and result-shape contract.
import { describe, expect, it } from 'vitest';
import { getBotById, listBots, setBotEnabled } from '../src/services/bots';

type Bot = {
  id: string;
  user_id: string;
  kind: string;
  command_prefix: string;
  enabled: number;
  created_at: number;
};

function fakeDb(rows: { first?: Bot | null; all?: Bot[] } = {}, omitResults = false) {
  const calls: Array<{ sql: string; binds: unknown[]; op: string }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          calls.push({ sql, binds, op: 'first' });
          return rows.first ?? null;
        },
        async all() {
          calls.push({ sql, binds, op: 'all' });
          return omitResults ? {} : { results: rows.all ?? [] };
        },
        async run() {
          calls.push({ sql, binds, op: 'run' });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, calls };
}

describe('services/bots helpers', () => {
  const bot: Bot = {
    id: 'bot1',
    user_id: '@bot:example.com',
    kind: 'telegram',
    command_prefix: '!bot',
    enabled: 1,
    created_at: 42,
  };

  it('getBotById selects by id with one bind and returns the row or null', async () => {
    const found = fakeDb({ first: bot });
    expect(await getBotById(found.db, 'bot1')).toEqual(bot);
    expect(found.calls).toEqual([
      {
        sql: expect.stringContaining('FROM bots WHERE id = ?'),
        binds: ['bot1'],
        op: 'first',
      },
    ]);

    const missing = fakeDb();
    expect(await getBotById(missing.db, 'nope')).toBeNull();
  });

  it('listBots returns all rows in creation order and degrades to an empty array', async () => {
    const listed = fakeDb({ all: [bot] });
    expect(await listBots(listed.db)).toEqual([bot]);
    expect(listed.calls).toEqual([
      {
        sql: expect.stringContaining('FROM bots ORDER BY created_at'),
        binds: [],
        op: 'all',
      },
    ]);

    // D1 may omit `results` entirely; the helper must still return [].
    const absent = fakeDb({}, true);
    expect(await listBots(absent.db)).toEqual([]);
  });

  it('setBotEnabled maps the boolean to 1/0 and binds id second', async () => {
    const enabled = fakeDb();
    await setBotEnabled(enabled.db, 'bot1', true);
    expect(enabled.calls).toEqual([
      {
        sql: expect.stringContaining('UPDATE bots SET enabled = ? WHERE id = ?'),
        binds: [1, 'bot1'],
        op: 'run',
      },
    ]);

    const disabled = fakeDb();
    await setBotEnabled(disabled.db, 'bot1', false);
    expect(disabled.calls[0].binds).toEqual([0, 'bot1']);
  });
});
