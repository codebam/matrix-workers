import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import {
  consumeRegistrationToken,
  createRegistrationToken,
  listRegistrationTokens,
  revokeRegistrationToken,
  type RegistrationTokenRow,
} from '../src/services/database';

type Statement = { sql: string; args: unknown[] };

function mockDb(result: { results?: unknown[]; changes?: number } = {}) {
  const statements: Statement[] = [];
  const db = {
    statements,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...bound: unknown[]) {
          args = bound;
          return stmt;
        },
        async all() {
          statements.push({ sql, args });
          return { results: result.results ?? [] };
        },
        async run() {
          statements.push({ sql, args });
          return { meta: { changes: result.changes ?? 0 } };
        },
        async first() {
          statements.push({ sql, args });
          return null;
        },
      };
      return stmt;
    },
  };
  return db;
}

const asDb = (db: ReturnType<typeof mockDb>) => db as unknown as D1Database;

describe('registration token database helpers', () => {
  it('createRegistrationToken inserts an unrevoked row with the bound fields', async () => {
    const db = mockDb();
    const before = Date.now();
    await createRegistrationToken(asDb(db), 'tok-1', 'hash-1', 'for sean', '@admin:ex', 999, 3);
    const after = Date.now();

    expect(db.statements).toHaveLength(1);
    const { sql, args } = db.statements[0];
    expect(sql).toContain('INSERT INTO registration_tokens');
    expect(sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
    expect(args).toHaveLength(7);
    expect(args.slice(0, 4)).toEqual(['tok-1', 'hash-1', 'for sean', '@admin:ex']);
    expect(args[4]).toBeGreaterThanOrEqual(before);
    expect(args[4]).toBeLessThanOrEqual(after);
    expect(args.slice(5)).toEqual([999, 3]);
  });

  it('listRegistrationTokens selects every column but the hash, newest first', async () => {
    const rows: Array<Omit<RegistrationTokenRow, 'token_hash'>> = [
      {
        id: 'tok-1',
        note: null,
        created_by: '@admin:ex',
        created_at: 10,
        expires_at: null,
        uses_remaining: 1,
        revoked: 0,
      },
    ];
    const db = mockDb({ results: rows });

    expect(await listRegistrationTokens(asDb(db))).toEqual(rows);
    expect(db.statements).toHaveLength(1);
    const { sql, args } = db.statements[0];
    expect(sql).toContain('SELECT id, note, created_by, created_at, expires_at, uses_remaining, revoked');
    expect(sql).not.toContain('token_hash');
    expect(sql).toContain('ORDER BY created_at DESC LIMIT 100');
    expect(args).toEqual([]);
  });

  it('revokeRegistrationToken reports whether a row was actually changed', async () => {
    const changed = mockDb({ changes: 1 });
    expect(await revokeRegistrationToken(asDb(changed), 'tok-1')).toBe(true);
    expect(changed.statements[0].sql).toBe('UPDATE registration_tokens SET revoked = 1 WHERE id = ?');
    expect(changed.statements[0].args).toEqual(['tok-1']);

    const unchanged = mockDb({ changes: 0 });
    expect(await revokeRegistrationToken(asDb(unchanged), 'missing')).toBe(false);
    expect(unchanged.statements[0].args).toEqual(['missing']);
  });

  it('consumeRegistrationToken decrements only live, unused, unexpired tokens', async () => {
    const before = Date.now();
    const changed = mockDb({ changes: 1 });
    expect(await consumeRegistrationToken(asDb(changed), 'hash-1')).toBe(true);
    const { sql, args } = changed.statements[0];
    expect(sql).toContain('SET uses_remaining = uses_remaining - 1');
    expect(sql).toContain('revoked = 0 AND uses_remaining > 0');
    expect(sql).toContain('(expires_at IS NULL OR expires_at > ?)');
    expect(args[0]).toBe('hash-1');
    expect(args[1]).toBeGreaterThanOrEqual(before);
    expect(args[1]).toBeLessThanOrEqual(Date.now());

    const unchanged = mockDb({ changes: 0 });
    expect(await consumeRegistrationToken(asDb(unchanged), 'hash-1')).toBe(false);
  });
});
