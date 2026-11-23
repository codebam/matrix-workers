/**
 * MSC4190 — appservice use of standard endpoints (roadmap item 12).
 *
 * An application service must be able to register users in its own namespace
 * with its as_token (no UIA/password), and to delete a masqueraded user's
 * devices even though it cannot supply the UIA password an ordinary user
 * would. Ordinary user flows must stay exactly as they were.
 *
 * Hono app.request() against src/api/login.ts + src/api/devices.ts, with a
 * SQL-level D1 double so the real requireAuth masquerade path is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const AS_TOKEN = 'as_secret_token';
const AS_USER = '@bot_alice:example.com';
const OTHER_USER = '@alice:example.com';
const USER_TOKEN = 'syt_user_token';
const USER = '@alice:example.com';
const AS_NAMESPACE = '@bot_.*:example\\.com';

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    hashPassword: vi.fn(async (password: string) => `mockok:${password}`),
    verifyPassword: vi.fn(async (password: string, storedHash: string) => (
      storedHash === `mockok:${password}`
    )),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  let seq = 0;
  const next = () => ++seq;
  return {
    ...actual,
    generateOpaqueId: vi.fn(async (len?: number) => (
      `opaque${next()}`.padEnd(len ?? 16, '0').slice(0, len ?? 16)
    )),
    generateDeviceId: vi.fn(async () => `GENDEV${next()}`),
    generateAccessToken: vi.fn(async () => `syt_access_${next()}`),
    generateRefreshToken: vi.fn(async () => `syr_refresh_${next()}`),
  };
});

import { hashToken } from '../src/utils/crypto';
import login from '../src/api/login';
import devices from '../src/api/devices';

type UserRow = {
  user_id: string;
  localpart: string;
  password_hash: string | null;
  is_guest: number;
  display_name: string | null;
  avatar_url: string | null;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type DeviceRow = {
  device_id: string;
  user_id: string;
  display_name: string | null;
  last_seen_ts: number | null;
  last_seen_ip: string | null;
};

type AsRow = {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
};

type TokenRow = { token: string; userId: string; deviceId: string | null };
type SqlCall = { sql: string; args: unknown[] };

function asRow(overrides: Partial<AsRow> = {}): AsRow {
  return {
    id: 'as1',
    url: 'https://as.example.com',
    as_token: AS_TOKEN,
    hs_token: 'hs_secret',
    sender_localpart: 'bridge',
    rate_limited: 0,
    protocols: null,
    namespaces: JSON.stringify({
      users: [{ exclusive: true, regex: AS_NAMESPACE }],
      rooms: [],
      aliases: [],
    }),
    ...overrides,
  };
}

function userRow(overrides: Partial<UserRow> & Pick<UserRow, 'user_id'>): UserRow {
  const localpart = overrides.localpart ?? overrides.user_id.slice(1).split(':')[0];
  return {
    user_id: overrides.user_id,
    localpart,
    password_hash: overrides.password_hash ?? null,
    is_guest: overrides.is_guest ?? 0,
    display_name: overrides.display_name ?? localpart,
    avatar_url: overrides.avatar_url ?? null,
    is_deactivated: overrides.is_deactivated ?? 0,
    admin: overrides.admin ?? 0,
    created_at: overrides.created_at ?? 1_730_300_000_000,
  };
}

function seedDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    device_id: overrides.device_id ?? 'DEV1',
    user_id: overrides.user_id ?? USER,
    display_name: overrides.display_name ?? null,
    last_seen_ts: overrides.last_seen_ts ?? null,
    last_seen_ip: overrides.last_seen_ip ?? null,
  };
}

function createDb(opts: {
  users?: Map<string, UserRow>;
  devices?: DeviceRow[];
  tokens?: TokenRow[];
  appservices?: Map<string, AsRow>;
} = {}) {
  const users = opts.users ?? new Map<string, UserRow>();
  const deviceRows = opts.devices ?? [];
  const tokens = opts.tokens ?? [];
  const appservices = opts.appservices ?? new Map<string, AsRow>();
  const selects: SqlCall[] = [];
  const runs: SqlCall[] = [];
  const inserts: SqlCall[] = [];
  const deletes: SqlCall[] = [];
  let streamPosition = 40;

  const db = {
    users,
    deviceRows,
    tokens,
    appservices,
    selects,
    runs,
    inserts,
    deletes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });

              if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
                const row = appservices.get(args[0] as string);
                return (row ? { ...row } : null) as T;
              }

              // Real requireAuth → validateAccessToken → getUserByTokenHash
              if (sql.includes('FROM access_tokens at JOIN users u') && sql.includes('token_hash')) {
                const hash = args[0] as string;
                for (const t of tokens) {
                  if (await hashToken(t.token) === hash) {
                    return {
                      user_id: t.userId,
                      device_id: t.deviceId,
                      locked: 0,
                      suspended: 0,
                    } as T;
                  }
                }
                return null as T;
              }

              if (sql.includes('SELECT password_hash FROM users')) {
                const u = users.get(args[0] as string);
                return (u ? { password_hash: u.password_hash } : null) as T;
              }

              // getUserById
              if (sql.includes('FROM users WHERE user_id = ?') && sql.includes('is_deactivated')) {
                const u = users.get(args[0] as string);
                if (!u) return null as T;
                return {
                  user_id: u.user_id,
                  localpart: u.localpart,
                  display_name: u.display_name,
                  avatar_url: u.avatar_url,
                  is_guest: u.is_guest,
                  is_deactivated: u.is_deactivated,
                  admin: u.admin,
                  created_at: u.created_at,
                } as T;
              }

              if (sql.includes('SELECT device_id FROM devices') && sql.includes('device_id = ?')) {
                const [userId, deviceId] = args as string[];
                const d = deviceRows.find((x) => x.user_id === userId && x.device_id === deviceId);
                return (d ? { device_id: d.device_id } : null) as T;
              }

              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position: streamPosition } as T;
              }

              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },

            async all<T>() {
              selects.push({ sql, args });
              // getServersInEncryptedRoomsWithUser (device-list EDU fan-out)
              return { results: [] as T[] };
            },

            async run() {
              runs.push({ sql, args });

              if (sql.includes('INSERT INTO users')) {
                inserts.push({ sql, args });
                const [userId, localpart, passwordHash, isGuest] = args as [
                  string, string, string | null, number,
                ];
                users.set(userId, userRow({
                  user_id: userId, localpart, password_hash: passwordHash, is_guest: isGuest,
                }));
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO devices')) {
                inserts.push({ sql, args });
                const [userId, deviceId, displayName] = args as [string, string, string | null];
                deviceRows.push(seedDevice({
                  user_id: userId, device_id: deviceId, display_name: displayName,
                }));
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO access_tokens')) {
                inserts.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM access_tokens')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM device_keys')) {
                deletes.push({ sql, args });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('DELETE FROM devices')) {
                deletes.push({ sql, args });
                const [userId, deviceId] = args as string[];
                for (let i = deviceRows.length - 1; i >= 0; i--) {
                  if (deviceRows[i].user_id === userId && deviceRows[i].device_id === deviceId) {
                    deviceRows.splice(i, 1);
                  }
                }
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('INSERT INTO device_key_changes')) {
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              if (sql.includes('UPDATE stream_positions')) {
                streamPosition += 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }

              return { success: true, meta: { changes: 1, last_row_id: 0 } };
            },
          };
        },
      };
    },
  };

  return db;
}

type Db = ReturnType<typeof createDb>;

function mockKv() {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function envFor(db: Db): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    SESSIONS: mockKv(),
  } as unknown as Env;
}

async function parse(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

async function register(env: Env, query: string, body: unknown = {}) {
  return parse(await login.request(
    `http://localhost/_matrix/client/v3/register${query}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  ));
}

async function deleteDevice(env: Env, path: string, body: unknown = {}, token?: string) {
  return parse(await devices.request(
    `http://localhost${path}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  ));
}

async function deleteDevices(env: Env, path: string, body: unknown, token?: string) {
  return parse(await devices.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  ));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MSC4190 register with an appservice as_token', () => {
  it('creates a namespaced user from user_id with no UIA/password', async () => {
    const db = createDb({ appservices: new Map([[AS_TOKEN, asRow()]]) });
    const env = envFor(db);
    const res = await register(
      env,
      `?access_token=${AS_TOKEN}&user_id=${encodeURIComponent(AS_USER)}`,
      {} // no username, password or auth
    );

    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(AS_USER);
    expect(res.body.home_server).toBe(SERVER);
    expect(res.body.access_token).toBeDefined();
    expect(res.body.device_id).toBeDefined();
    expect(db.users.get(AS_USER)?.password_hash).toBeNull();
    expect(db.users.get(AS_USER)?.is_guest).toBe(0);
  });

  it('rejects a user_id outside the appservice namespace with 403', async () => {
    const db = createDb({ appservices: new Map([[AS_TOKEN, asRow()]]) });
    const res = await register(
      envFor(db),
      `?access_token=${AS_TOKEN}&user_id=${encodeURIComponent(OTHER_USER)}`,
      {}
    );

    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.users.size).toBe(0);
  });

  it('rejects a foreign-server user_id with 403', async () => {
    const db = createDb({ appservices: new Map([[AS_TOKEN, asRow()]]) });
    const res = await register(
      envFor(db),
      `?access_token=${AS_TOKEN}&user_id=${encodeURIComponent('@bot_alice:elsewhere.test')}`,
      {}
    );

    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.users.size).toBe(0);
  });

  it('requires user_id when an as_token is supplied', async () => {
    const db = createDb({ appservices: new Map([[AS_TOKEN, asRow()]]) });
    const res = await register(envFor(db), `?access_token=${AS_TOKEN}`, {});

    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('still requires UIA without an as_token', async () => {
    const db = createDb();
    const res = await register(envFor(db), '', {
      username: 'newuser',
      password: 'Password1!',
    });

    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.dummy'] }]);
    expect(db.users.size).toBe(0);
  });

  it('keeps ordinary UIA registration working', async () => {
    const db = createDb();
    const res = await register(envFor(db), '', {
      username: 'newuser',
      password: 'Password1!',
      auth: { type: 'm.login.dummy' },
    });

    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@newuser:${SERVER}`);
    expect(res.body.access_token).toBeDefined();
    expect(db.users.get(`@newuser:${SERVER}`)?.password_hash).toBe('mockok:Password1!');
  });
});

describe('MSC4190 device deletion with an appservice as_token', () => {
  const masqueradeQuery = `?user_id=${encodeURIComponent(AS_USER)}`;

  function masqueradeDb() {
    return createDb({
      users: new Map([[AS_USER, userRow({ user_id: AS_USER })]]),
      devices: [seedDevice({ user_id: AS_USER, device_id: 'DEV1' })],
      appservices: new Map([[AS_TOKEN, asRow()]]),
    });
  }

  it('DELETE /devices/:deviceId succeeds without a password', async () => {
    const db = masqueradeDb();
    const res = await deleteDevice(
      envFor(db),
      `/_matrix/client/v3/devices/DEV1${masqueradeQuery}`,
      {}, // no auth
      AS_TOKEN
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.deviceRows).toHaveLength(0);
  });

  it('POST /delete_devices succeeds without a password', async () => {
    const db = masqueradeDb();
    const res = await deleteDevices(
      envFor(db),
      `/_matrix/client/v3/delete_devices${masqueradeQuery}`,
      { devices: ['DEV1'] }, // no auth
      AS_TOKEN
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(db.deviceRows).toHaveLength(0);
  });

  it('does not bypass UIA for a masquerade outside the namespace', async () => {
    const db = createDb({
      users: new Map([[OTHER_USER, userRow({ user_id: OTHER_USER })]]),
      devices: [seedDevice({ user_id: OTHER_USER, device_id: 'DEV1' })],
      appservices: new Map([[AS_TOKEN, asRow()]]),
    });
    const res = await deleteDevice(
      envFor(db),
      `/_matrix/client/v3/devices/DEV1?user_id=${encodeURIComponent(OTHER_USER)}`,
      {},
      AS_TOKEN
    );

    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.deviceRows).toHaveLength(1);
  });
});

describe('ordinary device deletion is unchanged', () => {
  function ordinaryDb() {
    return createDb({
      users: new Map([[USER, userRow({
        user_id: USER,
        password_hash: 'mockok:s3cret',
      })]]),
      devices: [seedDevice({ user_id: USER, device_id: 'DEV1' })],
      tokens: [{ token: USER_TOKEN, userId: USER, deviceId: 'CURRENT' }],
    });
  }

  it('still requires UIA when no password auth is supplied', async () => {
    for (const [path, body, method] of [
      ['/_matrix/client/v3/devices/DEV1', {}, 'DELETE'],
      ['/_matrix/client/v3/delete_devices', { devices: ['DEV1'] }, 'POST'],
    ] as const) {
      const db = ordinaryDb();
      const res = method === 'DELETE'
        ? await deleteDevice(envFor(db), path, body, USER_TOKEN)
        : await deleteDevices(envFor(db), path, body, USER_TOKEN);

      expect(res.status).toBe(401);
      expect(res.body.flows).toEqual([{ stages: ['m.login.password'] }]);
      expect(db.deviceRows).toHaveLength(1);
    }
  });

  it('still deletes with a valid password', async () => {
    const db = ordinaryDb();
    const res = await deleteDevice(
      envFor(db),
      '/_matrix/client/v3/devices/DEV1',
      { auth: { type: 'm.login.password', password: 's3cret' } },
      USER_TOKEN
    );

    expect(res.status).toBe(200);
    expect(db.deviceRows).toHaveLength(0);
  });

  it('still rejects a wrong password', async () => {
    const db = ordinaryDb();
    const res = await deleteDevice(
      envFor(db),
      '/_matrix/client/v3/devices/DEV1',
      { auth: { type: 'm.login.password', password: 'wrong' } },
      USER_TOKEN
    );

    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(db.deviceRows).toHaveLength(1);
  });
});
