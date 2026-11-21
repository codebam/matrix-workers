/**
 * MSC4323 (stable since spec v1.18) — standard account lock/suspend admin
 * endpoints: GET/PUT /_matrix/client/v1/admin/{lock,suspend}/{userId}.
 *
 * Covers the spec's gate ordering (admin check before any target lookup),
 * 400 M_INVALID_PARAM for non-local user IDs, 404 for unknown/deactivated
 * users, 403 for self/other-admin targets on PUT, and the happy paths.
 *
 * Enforcement of the resulting account states (M_USER_LOCKED 401 /
 * M_USER_SUSPENDED 403) lives in msc4323-auth-enforcement.test.ts, which
 * exercises the REAL auth middleware against a fake D1; this file mocks
 * the client middleware so it can drive adminApp end to end.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const ADMIN = '@admin:example.com';
const USER = '@alice:example.com';
const REMOTE = '@bob:remote.example.org';

// Shared mutable auth state for the mocked client middleware.
const authState = vi.hoisted(() => ({
  userId: '@admin:example.com',
  suspended: false,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', 'D');
      c.set('accessToken', 't');
      await next();
    };
  },
}));

import adminApp from '../src/api/admin';

// ---------------------------------------------------------------------------
// Fake D1
// ---------------------------------------------------------------------------

type UserRow = {
  user_id: string;
  localpart: string;
  admin: number;
  is_deactivated: number;
  locked: number;
  suspended: number;
};

function adminDbFor(users: UserRow[]) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              // requireAdmin's getUserById lookup.
              if (sql.includes('SELECT user_id, localpart')) {
                const row = users.find((u) => u.user_id === args[0]);
                return (row ?? null) as T;
              }
              // moderationTarget's lookup.
              if (sql.includes('SELECT user_id, admin, is_deactivated')) {
                const row = users.find((u) => u.user_id === args[0]);
                return (row ?? null) as T;
              }
              return null as T;
            },
            async run() {
              // Apply moderation writes so follow-up GETs see new state.
              if (sql.includes('SET locked = ?')) {
                const row = users.find((u) => u.user_id === args[2]);
                if (row) row.locked = args[0] as number;
              }
              if (sql.includes('SET suspended = ?')) {
                const row = users.find((u) => u.user_id === args[2]);
                if (row) row.suspended = args[0] as number;
              }
              if (sql.includes('UPDATE users SET updated_at')) {
                // admin audit bookkeeping — harmless no-op
              }
              updates.push({ sql, args });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { updates: typeof updates };
  return { db, updates };
}

async function adminRequest(
  db: D1Database,
  path: string,
  init: RequestInit
): Promise<{ status: number; body: any }> {
  const env = { DB: db, SERVER_NAME: SERVER } as unknown as Env;
  const res = await adminApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

describe('MSC4323 admin lock/suspend endpoints', () => {
  const baseUsers: UserRow[] = [
    { user_id: ADMIN, localpart: 'admin', admin: 1, is_deactivated: 0, locked: 0, suspended: 0 },
    { user_id: USER, localpart: 'alice', admin: 0, is_deactivated: 0, locked: 0, suspended: 0 },
  ];

  it('GET lock reports the stored state', async () => {
    const { db } = adminDbFor([
      baseUsers[0],
      { ...baseUsers[1], locked: 1 },
    ]);
    const res = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
      jsonInit('GET')
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: true });
  });

  it('PUT lock updates the state and echoes it', async () => {
    const { db, updates } = adminDbFor(baseUsers);
    const res = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
      jsonInit('PUT', { locked: true })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locked: true });
    expect(updates.some((u) => u.sql.includes('SET locked = ?') && u.args[0] === 1)).toBe(true);
  });

  it('PUT lock rejects a missing/non-boolean locked field', async () => {
    const { db } = adminDbFor(baseUsers);
    const missing = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
      jsonInit('PUT', {})
    );
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ errcode: 'M_MISSING_PARAM' });

    const badType = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
      jsonInit('PUT', { locked: 'yes' })
    );
    expect(badType.status).toBe(400);
  });

  it('non-local user id is 400 M_INVALID_PARAM', async () => {
    const { db } = adminDbFor(baseUsers);
    const res = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(REMOTE)}`,
      jsonInit('GET')
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('unknown and deactivated users are 404', async () => {
    const { db } = adminDbFor([
      baseUsers[0],
      { ...baseUsers[1], is_deactivated: 1 },
    ]);
    const deactivated = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
      jsonInit('GET')
    );
    expect(deactivated.status).toBe(404);
    expect(deactivated.body).toMatchObject({ errcode: 'M_NOT_FOUND' });

    const unknown = await adminRequest(
      db,
      `/_matrix/client/v1/admin/suspend/${encodeURIComponent('@ghost:example.com')}`,
      jsonInit('GET')
    );
    expect(unknown.status).toBe(404);
  });

  it('PUT refuses locking yourself or another admin', async () => {
    const { db } = adminDbFor(baseUsers);
    const self = await adminRequest(
      db,
      `/_matrix/client/v1/admin/lock/${encodeURIComponent(ADMIN)}`,
      jsonInit('PUT', { locked: true })
    );
    expect(self.status).toBe(403);

    const otherAdmin = await adminRequest(
      db,
      `/_matrix/client/v1/admin/suspend/${encodeURIComponent(ADMIN)}`,
      jsonInit('PUT', { suspended: true })
    );
    expect(otherAdmin.status).toBe(403);
  });

  it('suspend endpoints mirror the lock contract', async () => {
    const { db, updates } = adminDbFor(baseUsers);
    const put = await adminRequest(
      db,
      `/_matrix/client/v1/admin/suspend/${encodeURIComponent(USER)}`,
      jsonInit('PUT', { suspended: true })
    );
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ suspended: true });
    expect(updates.some((u) => u.sql.includes('SET suspended = ?') && u.args[0] === 1)).toBe(true);

    const get = await adminRequest(
      db,
      `/_matrix/client/v1/admin/suspend/${encodeURIComponent(USER)}`,
      jsonInit('GET')
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ suspended: true });
  });

  it('non-admin callers are forbidden before any target lookup', async () => {
    const { db } = adminDbFor(baseUsers);
    authState.userId = USER;
    try {
      const res = await adminRequest(
        db,
        `/_matrix/client/v1/admin/lock/${encodeURIComponent(USER)}`,
        jsonInit('GET')
      );
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    } finally {
      authState.userId = ADMIN;
    }
  });
});
