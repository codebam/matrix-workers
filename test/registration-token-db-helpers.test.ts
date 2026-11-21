/**
 * Focused pins for the registration-token D1 helpers in src/services/database.ts.
 * The API-level suites stub these SQL strings themselves, so the helpers were
 * never exercised directly. A tiny in-memory D1 double keeps each case local.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeRegistrationToken,
  createRegistrationToken,
  revokeRegistrationToken,
  type RegistrationTokenRow,
} from '../src/services/database';

const NOW = 1_700_000_000_000;

type Query = { sql: string; args: unknown[] };

function makeDb(rows: RegistrationTokenRow[] = []) {
  const queries: Query[] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          queries.push({ sql, args });
          return {
            async run() {
              if (sql.includes('INSERT INTO registration_tokens')) {
                // The literal 0 in the INSERT is the initial revoked flag.
                rows.push({
                  id: args[0] as string,
                  token_hash: args[1] as string,
                  note: args[2] as string | null,
                  created_by: args[3] as string,
                  created_at: args[4] as number,
                  expires_at: args[5] as number | null,
                  uses_remaining: args[6] as number,
                  revoked: 0,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE registration_tokens SET revoked = 1')) {
                const row = rows.find((r) => r.id === args[0]);
                if (!row) return { meta: { changes: 0 } };
                row.revoked = 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('SET uses_remaining = uses_remaining - 1')) {
                const [hash, now] = args as [string, number];
                const row = rows.find((r) => r.token_hash === hash);
                if (
                  !row ||
                  row.revoked !== 0 ||
                  row.uses_remaining <= 0 ||
                  (row.expires_at !== null && row.expires_at <= now)
                ) {
                  return { meta: { changes: 0 } };
                }
                row.uses_remaining -= 1;
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected SQL: ${sql}`);
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  return { db, rows, queries };
}

function token(partial: Partial<RegistrationTokenRow> = {}): RegistrationTokenRow {
  return {
    id: 'tok-1',
    token_hash: 'hash-1',
    note: null,
    created_by: '@admin:example.com',
    created_at: NOW - 1000,
    expires_at: null,
    uses_remaining: 1,
    revoked: 0,
    ...partial,
  };
}

describe('registration-token D1 helpers', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => vi.restoreAllMocks());

  it('createRegistrationToken inserts every field with a fresh created_at and revoked=0', async () => {
    const { db, rows, queries } = makeDb();

    await createRegistrationToken(db, 'tok-a', 'hash-a', 'invite for alice', '@admin:example.com', NOW + 5000, 3);
    await createRegistrationToken(db, 'tok-b', 'hash-b', null, '@admin:example.com', null, 1);

    expect(rows).toEqual([
      {
        id: 'tok-a',
        token_hash: 'hash-a',
        note: 'invite for alice',
        created_by: '@admin:example.com',
        created_at: NOW,
        expires_at: NOW + 5000,
        uses_remaining: 3,
        revoked: 0,
      },
      {
        id: 'tok-b',
        token_hash: 'hash-b',
        note: null,
        created_by: '@admin:example.com',
        created_at: NOW,
        expires_at: null,
        uses_remaining: 1,
        revoked: 0,
      },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[0].sql).toContain('INSERT INTO registration_tokens');
    expect(queries[0].sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
    expect(queries[0].args).toEqual([
      'tok-a', 'hash-a', 'invite for alice', '@admin:example.com', NOW, NOW + 5000, 3,
    ]);
  });

  it('revokeRegistrationToken reports true only when the id exists', async () => {
    const { db, rows, queries } = makeDb([token({ id: 'tok-1' })]);

    expect(await revokeRegistrationToken(db, 'tok-1')).toBe(true);
    expect(await revokeRegistrationToken(db, 'missing')).toBe(false);

    expect(rows[0].revoked).toBe(1);
    expect(queries).toEqual([
      { sql: 'UPDATE registration_tokens SET revoked = 1 WHERE id = ?', args: ['tok-1'] },
      { sql: 'UPDATE registration_tokens SET revoked = 1 WHERE id = ?', args: ['missing'] },
    ]);
  });

  it('consumeRegistrationToken spends one use of a live token', async () => {
    const { db, rows, queries } = makeDb([token({ uses_remaining: 2 })]);

    expect(await consumeRegistrationToken(db, 'hash-1')).toBe(true);
    expect(rows[0].uses_remaining).toBe(1);
    expect(queries[0].sql).toContain('SET uses_remaining = uses_remaining - 1');
    expect(queries[0].sql).toContain('revoked = 0 AND uses_remaining > 0');
    expect(queries[0].sql).toContain('expires_at IS NULL OR expires_at > ?');
    expect(queries[0].args).toEqual(['hash-1', NOW]);
  });

  it('consumeRegistrationToken accepts a future expiry but not a past one', async () => {
    const future = makeDb([token({ expires_at: NOW + 1 })]);
    const past = makeDb([token({ id: 'tok-2', token_hash: 'hash-2', expires_at: NOW })]);

    expect(await consumeRegistrationToken(future.db, 'hash-1')).toBe(true);
    expect(await consumeRegistrationToken(past.db, 'hash-2')).toBe(false);
    expect(future.rows[0].uses_remaining).toBe(0);
    expect(past.rows[0].uses_remaining).toBe(1);
  });

  it('consumeRegistrationToken rejects revoked, exhausted and unknown tokens', async () => {
    const { db, rows } = makeDb([
      token({ id: 'revoked', token_hash: 'hash-revoked', revoked: 1 }),
      token({ id: 'spent', token_hash: 'hash-spent', uses_remaining: 0 }),
    ]);

    expect(await consumeRegistrationToken(db, 'hash-revoked')).toBe(false);
    expect(await consumeRegistrationToken(db, 'hash-spent')).toBe(false);
    expect(await consumeRegistrationToken(db, 'hash-unknown')).toBe(false);
    expect(rows.map((r) => r.uses_remaining)).toEqual([1, 0]);
  });
});
