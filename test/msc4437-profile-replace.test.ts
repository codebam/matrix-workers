/**
 * MSC4437 (in FCP): PUT /_matrix/client/unstable/org.matrix.msc4437/profile/{userId}
 * replaces the ENTIRE profile — absent fields are deleted, custom fields
 * replace the stored set wholesale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER = '@alice:example.com';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'D');
      await next();
    };
  },
  optionalAuth: () => {
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

import profileApp from '../src/api/profile';

function fakeKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string, type?: string) {
      const raw = data.get(key);
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  } as unknown as KVNamespace & { data: Map<string, string> };
}

function fakeDb(users: Map<string, Record<string, unknown>>) {
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  return {
    updates,
    users,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM users WHERE user_id = ?')) {
                return (users.get(String(args[0])) ?? null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              updates.push({ sql, args });
              if (sql.includes('UPDATE users SET display_name = ?')) {
                const u = users.get(String(args[2])) ?? {};
                u.display_name = (args[0] as string | null) ?? null;
                users.set(String(args[2]), u);
              } else if (sql.includes('UPDATE users SET avatar_url = ?')) {
                const u = users.get(String(args[2])) ?? {};
                u.avatar_url = (args[0] as string | null) ?? null;
                users.set(String(args[2]), u);
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database & { updates: Array<{ sql: string; args: unknown[] }>; users: Map<string, Record<string, unknown>> };
}

function envFor(db: D1Database, kv: KVNamespace): Env {
  return { DB: db, SERVER_NAME: SERVER, CACHE: kv } as unknown as Env;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const MSC4437_PATH = `/_matrix/client/unstable/org.matrix.msc4437/profile/${encodeURIComponent(USER)}`;

describe('MSC4437 profile replace', () => {
  let db: ReturnType<typeof fakeDb>;
  let kv: ReturnType<typeof fakeKv>;
  let env: Env;

  beforeEach(() => {
    db = fakeDb(new Map([[USER, {
      user_id: USER, localpart: 'alice', display_name: 'Old Name',
      avatar_url: 'mxc://old', admin: 0, is_deactivated: 0,
    }]]));
    kv = fakeKv();
    // Seed existing custom fields to prove wholesale replacement.
    kv.data.set(`profile:${USER}:custom`, JSON.stringify({ old_field: 'gone', keep_me: 'no' }));
    env = envFor(db, kv);
  });

  it('replaces the entire profile: absent fields are deleted', async () => {
    const res = await profileApp.request(
      `http://localhost${MSC4437_PATH}`,
      jsonInit('PUT', { displayname: 'New Name' }),
      env
    );
    expect(res.status).toBe(200);

    // avatar_url was absent -> deleted (set to null).
    expect(db.users.get(USER)!.avatar_url).toBeNull();
    expect(db.users.get(USER)!.display_name).toBe('New Name');

    // Custom fields absent from the request are gone entirely.
    expect(JSON.parse(kv.data.get(`profile:${USER}:custom`)!)).toEqual({});
  });

  it('custom fields replace the stored set wholesale', async () => {
    const res = await profileApp.request(
      `http://localhost${MSC4437_PATH}`,
      jsonInit('PUT', { displayname: 'Alice', us_citizen: false, pronouns: 'they' }),
      env
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.data.get(`profile:${USER}:custom`)!)).toEqual({
      us_citizen: false,
      pronouns: 'they',
    });
  });

  it('refuses other users and non-string standard fields', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const other = await profileApp.request(
      `http://localhost/_matrix/client/unstable/org.matrix.msc4437/profile/${encodeURIComponent('@bob:example.com')}`,
      jsonInit('PUT', { displayname: 'Hax' }),
      env
    );
    expect(other.status).toBe(403);
    (console.log as ReturnType<typeof vi.spyOn>).mockRestore?.();

    const badType = await profileApp.request(
      `http://localhost${MSC4437_PATH}`,
      jsonInit('PUT', { displayname: 42 }),
      env
    );
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
  });

  it('explicit null clears a standard field without touching the other', async () => {
    const res = await profileApp.request(
      `http://localhost${MSC4437_PATH}`,
      jsonInit('PUT', { avatar_url: null, displayname: 'Kept' }),
      env
    );
    expect(res.status).toBe(200);
    expect(db.users.get(USER)!.avatar_url).toBeNull();
    expect(db.users.get(USER)!.display_name).toBe('Kept');
  });
});
