/**
 * Federation query/profile custom-field semantics (Matrix v1.19 #2326).
 *
 * The `field` parameter must restrict the response to one field; custom keys
 * live in CACHE under `profile:<user>:custom` (the same key the C-S profile
 * endpoints use), and a field that does not exist is a 404.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const USER_ID = encodeURIComponent(USER);

type ProfileRow = { display_name: string | null; avatar_url: string | null };

type KvStore = {
  data: Record<string, string>;
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
};

function mockKv(initial: Record<string, string> = {}): KvStore {
  const data = { ...initial };
  return {
    data,
    get: async (key) => data[key] ?? null,
    put: async (key, value) => { data[key] = value; },
  };
}

function makeDb(users: Record<string, ProfileRow>) {
  return {
    prepare(sql: string) {
      let boundUserId = '';
      const stmt = {
        async first<T>() {
          if (sql.includes('SELECT display_name, avatar_url FROM users')) {
            return (users[boundUserId] ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
        bind(...args: unknown[]) {
          boundUserId = String(args[0]);
          return stmt;
        },
      };
      return stmt;
    },
  };
}

function makeEnv(db: ReturnType<typeof makeDb>, cache: KvStore): Env {
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
    SESSIONS: mockKv() as unknown as KVNamespace,
    CACHE: cache as unknown as KVNamespace,
    ONE_TIME_KEYS: mockKv() as unknown as KVNamespace,
    USER_KEYS: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => new Response('{}', { status: 200 }),
      }),
    } as unknown as DurableObjectNamespace,
  } as Env;
}

async function get(path: string, env: Env) {
  const res = await federation.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : null,
  };
}

function seededEnv(profile: ProfileRow, custom: Record<string, unknown> = {}) {
  const cache = mockKv({
    [`profile:${USER}:custom`]: JSON.stringify(custom),
  });
  return makeEnv(makeDb({ [USER]: profile }), cache);
}

describe('federation query/profile field semantics', () => {
  const profile: ProfileRow = {
    display_name: 'Alice',
    avatar_url: 'mxc://example.com/avatar',
  };
  const custom = { 'm.tz': 'Etc/UTC', 'org.example.color': 'blue' };

  it('field=displayname returns only displayname', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=displayname`,
      seededEnv(profile, custom)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayname: 'Alice' });
  });

  it('field=avatar_url returns only avatar_url', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=avatar_url`,
      seededEnv(profile, custom)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ avatar_url: 'mxc://example.com/avatar' });
  });

  it('field=m.tz returns only that custom field', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=m.tz`,
      seededEnv(profile, custom)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 'm.tz': 'Etc/UTC' });
  });

  it('an unknown field is a 404 M_NOT_FOUND', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=does.not.exist`,
      seededEnv(profile, custom)
    );
    expect(res.status).toBe(404);
    expect(res.body?.errcode).toBe('M_NOT_FOUND');
  });

  it('no field returns the full public profile including custom keys', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}`,
      seededEnv(profile, custom)
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayname: 'Alice',
      avatar_url: 'mxc://example.com/avatar',
      'm.tz': 'Etc/UTC',
      'org.example.color': 'blue',
    });
  });

  it('unset fields stay null and a field query never leaks other values', async () => {
    const res = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=displayname`,
      seededEnv({ display_name: null, avatar_url: 'mxc://example.com/avatar' }, {})
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayname: null });

    const missing = await get(
      `/_matrix/federation/v1/query/profile?user_id=${USER_ID}&field=m.tz`,
      seededEnv(profile, {})
    );
    expect(missing.status).toBe(404);
  });
});
