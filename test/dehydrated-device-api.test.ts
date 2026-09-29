/**
 * Dehydrated device (MSC3814) endpoint tests.
 *
 * Covers the Element secret-storage bootstrap flow: the GET support probe
 * (must be M_NOT_FOUND, never M_UNRECOGNIZED, when no device exists), the PUT
 * that stores the encrypted device_data and installs the device keys, the
 * single-slot replace semantics used by Element's periodic rotation, DELETE
 * cleanup, and the to-device events paging used during rehydration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
  optionalAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      if (authState.userId) c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      await next();
    };
  },
  extractAccessToken: () => 'test-token',
  validateAccessToken: async () =>
    authState.userId
      ? { userId: authState.userId, deviceId: authState.deviceId }
      : null,
}));

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitType: () => 'default',
  getClientId: () => 'unknown',
  RATE_LIMITS: {},
}));

vi.mock('../src/middleware/analytics', () => ({
  analyticsMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('hono/logger', () => ({
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com' as string | undefined,
  deviceId: 'DEVICEA' as string,
}));

vi.mock('../src/durable-objects', () => ({
  RoomDurableObject: class {},
  SyncDurableObject: class {},
  FederationDurableObject: class {},
  CallRoomDurableObject: class {},
  AdminDurableObject: class {},
  UserKeysDurableObject: class {},
  PushDurableObject: class {},
  RateLimitDurableObject: class {},
}));

vi.mock('../src/workflows', () => ({
  RoomJoinWorkflow: class {},
  PushNotificationWorkflow: class {},
  FederationCatchupWorkflow: class {},
  MediaCleanupWorkflow: class {},
  StateCompactionWorkflow: class {},
}));

import app from '../src/index';

const USER = '@alice:example.com';
const OTHER_USER = '@bob:example.com';
const DEHYDRATED = 'DEHYDRATED01';
const NEW_DEHYDRATED = 'DEHYDRATED02';
const PREFIX = '/_matrix/client/unstable/org.matrix.msc3814.v1';
const AUTH = { Authorization: 'Bearer test-token' };

function mockKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string): Promise<unknown> {
      const value = store.get(key);
      if (value === undefined) return null;
      if (type === 'json') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

type DehydratedRow = {
  user_id: string;
  device_id: string;
  device_data: string;
  display_name: string | null;
  created_at: number;
};

type DeviceRow = { user_id: string; device_id: string; display_name: string | null; created_at: number };

type ToDeviceRow = {
  sender_user_id: string;
  recipient_user_id: string;
  recipient_device_id: string;
  event_type: string;
  content: string;
  stream_position: number;
};

function createDb() {
  const dehydrated = new Map<string, DehydratedRow>();
  const devices: DeviceRow[] = [];
  const oneTimeKeys: Array<Record<string, unknown>> = [];
  const keyChanges: Array<Record<string, unknown>> = [];
  const toDevice: ToDeviceRow[] = [];
  const streamPositions: Record<string, number> = { device_keys: 10 };

  return {
    dehydrated,
    devices,
    oneTimeKeys,
    keyChanges,
    toDevice,
    streamPositions,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM dehydrated_devices')) {
                return (dehydrated.get(args[0] as string) ?? null) as T;
              }
              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position: streamPositions[args[0] as string] ?? null } as T;
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes('FROM to_device_messages')) {
                const [userId, deviceId, sincePos, limit] = args as [string, string, number, number];
                const results = toDevice
                  .filter(
                    (m) =>
                      m.recipient_user_id === userId &&
                      m.recipient_device_id === deviceId &&
                      m.stream_position > sincePos
                  )
                  .sort((a, b) => a.stream_position - b.stream_position)
                  .slice(0, limit);
                return { results: results as T[] };
              }
              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 140)}`);
            },
            async run() {
              if (sql.includes('INSERT INTO dehydrated_devices')) {
                const [userId, deviceId, deviceData, displayName, createdAt] = args as [
                  string,
                  string,
                  string,
                  string,
                  number,
                ];
                dehydrated.set(userId, {
                  user_id: userId,
                  device_id: deviceId,
                  device_data: deviceData,
                  display_name: displayName,
                  created_at: createdAt,
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM dehydrated_devices')) {
                dehydrated.delete(args[0] as string);
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO devices')) {
                devices.push({
                  user_id: args[0] as string,
                  device_id: args[1] as string,
                  display_name: args[2] as string | null,
                  created_at: args[3] as number,
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM devices')) {
                const [userId, deviceId] = args as [string, string];
                const idx = devices.findIndex((d) => d.user_id === userId && d.device_id === deviceId);
                if (idx >= 0) devices.splice(idx, 1);
                return { success: true, meta: { changes: idx >= 0 ? 1 : 0, last_row_id: 0 } };
              }
              if (sql.includes('DELETE FROM device_keys') || sql.includes('DELETE FROM one_time_keys')) {
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('UPDATE stream_positions')) {
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO stream_positions')) {
                streamPositions[args[0] as string] = args[1] as number;
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                keyChanges.push({
                  user_id: args[0],
                  device_id: args[1],
                  change_type: args[2],
                  stream_position: args[3],
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              if (sql.includes('INSERT INTO one_time_keys')) {
                oneTimeKeys.push({
                  user_id: args[0],
                  device_id: args[1],
                  algorithm: args[2],
                  key_id: args[3],
                  key_data: args[4],
                });
                return { success: true, meta: { changes: 1, last_row_id: 0 } };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
}

type TestDb = ReturnType<typeof createDb>;

function createUserKeysStub() {
  const deviceKeys: Record<string, unknown> = {};
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    deviceKeys,
    puts,
    deletes,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      if (path === '/device-keys/put') {
        const b = body as { device_id: string; keys: unknown };
        deviceKeys[b.device_id] = b.keys;
        puts.push(b.device_id);
        return Response.json({ success: true });
      }
      if (path === '/device-keys/delete') {
        const b = body as { device_id: string };
        delete deviceKeys[b.device_id];
        deletes.push(b.device_id);
        return Response.json({ success: true });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

function createEnv(db: TestDb) {
  const deviceKeysKv = mockKv();
  const oneTimeKeysKv = mockKv();
  const userKeys = createUserKeysStub();
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    DEVICE_KEYS: deviceKeysKv,
    ONE_TIME_KEYS: oneTimeKeysKv,
    USER_KEYS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => userKeys,
    },
    _deviceKeysKv: deviceKeysKv,
    _oneTimeKeysKv: oneTimeKeysKv,
    _userKeys: userKeys,
  };
}

type TestEnv = ReturnType<typeof createEnv>;

async function request(
  env: TestEnv,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any; text: string }> {
  const res = await app.request(`http://localhost${path}`, init, env as unknown as Record<string, unknown>);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function deviceKeysFor(deviceId: string, userId: string = USER) {
  return {
    user_id: userId,
    device_id: deviceId,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: {
      [`curve25519:${deviceId}`]: 'curve25519key',
      [`ed25519:${deviceId}`]: 'ed25519key',
    },
    signatures: { [userId]: { [`ed25519:${deviceId}`]: 'signature' } },
    unsigned: { device_display_name: 'Dehydrated device' },
  };
}

function putBody(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    device_id: deviceId,
    device_data: { algorithm: 'org.matrix.msc3814.v2', account: 'encrypted-pickle-blob' },
    device_keys: deviceKeysFor(deviceId),
    initial_device_display_name: 'Dehydrated device',
    ...overrides,
  };
}

function seedDehydrated(db: TestDb, deviceId: string = DEHYDRATED, userId: string = USER) {
  db.dehydrated.set(userId, {
    user_id: userId,
    device_id: deviceId,
    device_data: JSON.stringify({ algorithm: 'org.matrix.msc3814.v2', account: 'old-pickle' }),
    display_name: 'Dehydrated device',
    created_at: 1700000000000,
  });
  db.devices.push({ user_id: userId, device_id: deviceId, display_name: 'Dehydrated device', created_at: 1700000000000 });
}

let db: TestDb;
let env: TestEnv;

beforeEach(() => {
  db = createDb();
  env = createEnv(db);
  authState.userId = USER;
  authState.deviceId = 'DEVICEA';
});

describe('GET /dehydrated_device (support probe)', () => {
  it('returns 404 M_NOT_FOUND when no device exists (Element treats this as supported)', async () => {
    const res = await request(env, `${PREFIX}/dehydrated_device`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
    // M_UNRECOGNIZED would make Element skip dehydration entirely.
    expect(res.body.errcode).not.toBe('M_UNRECOGNIZED');
  });

  it('returns the stored device when one exists', async () => {
    seedDehydrated(db);
    const res = await request(env, `${PREFIX}/dehydrated_device`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(DEHYDRATED);
    expect(res.body.device_data).toEqual({ algorithm: 'org.matrix.msc3814.v2', account: 'old-pickle' });
  });
});

describe('PUT /dehydrated_device (create/replace)', () => {
  it('creates the device and installs its keys as a first-class device', async () => {
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', putBody(DEHYDRATED)));
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(DEHYDRATED);

    const slot = db.dehydrated.get(USER);
    expect(slot?.device_id).toBe(DEHYDRATED);
    expect(JSON.parse(slot!.device_data)).toEqual({
      algorithm: 'org.matrix.msc3814.v2',
      account: 'encrypted-pickle-blob',
    });

    // Visible as a device so to-device messages can be routed to it.
    expect(db.devices.find((d) => d.device_id === DEHYDRATED)).toBeTruthy();

    // Keys installed where /keys/query reads them (UserKeys DO) and in the KV cache.
    expect(env._userKeys.puts).toContain(DEHYDRATED);
    expect(env._userKeys.deviceKeys[DEHYDRATED]).toEqual(deviceKeysFor(DEHYDRATED));
    expect(env._deviceKeysKv.store.get(`device:${USER}:${DEHYDRATED}`)).toBeTruthy();

    // /keys/changes stream records the key change.
    expect(db.keyChanges.some((c) => c.device_id === DEHYDRATED && c.change_type === 'update')).toBe(true);
  });

  it('stores one-time keys in both KV and D1 (like /keys/upload)', async () => {
    const body = putBody(DEHYDRATED, {
      one_time_keys: {
        'signed_curve25519:AAAA': { key: 'curve25519-otk', signatures: { [USER]: { 'ed25519:key': 'sig' } } },
      },
    });
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', body));
    expect(res.status).toBe(200);

    const otk = env._oneTimeKeysKv.store.get(`otk:${USER}:${DEHYDRATED}`);
    expect(otk).toBeTruthy();
    expect(JSON.parse(otk!)).toHaveProperty('signed_curve25519');
    expect(db.oneTimeKeys.some((k) => k.key_id === 'signed_curve25519:AAAA')).toBe(true);
  });

  it('replaces the previous device on upload (single slot, Element rotation)', async () => {
    seedDehydrated(db, DEHYDRATED);
    // Old device has cached keys + a stale KV entry.
    env._userKeys.deviceKeys[DEHYDRATED] = { stale: true };
    await env._deviceKeysKv.put(`device:${USER}:${DEHYDRATED}`, '{}');

    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', putBody(NEW_DEHYDRATED)));
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(NEW_DEHYDRATED);

    // Old device fully purged.
    expect(env._userKeys.deletes).toContain(DEHYDRATED);
    expect(env._userKeys.deviceKeys[DEHYDRATED]).toBeUndefined();
    expect(env._deviceKeysKv.store.has(`device:${USER}:${DEHYDRATED}`)).toBe(false);
    expect(db.devices.find((d) => d.device_id === DEHYDRATED)).toBeUndefined();
    expect(db.keyChanges.some((c) => c.device_id === DEHYDRATED && c.change_type === 'delete')).toBe(true);

    // Slot now points at the new device; old data gone.
    expect(db.dehydrated.get(USER)?.device_id).toBe(NEW_DEHYDRATED);
  });

  it('re-uploading the same device id keeps it in place', async () => {
    seedDehydrated(db, DEHYDRATED);
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', putBody(DEHYDRATED)));
    expect(res.status).toBe(200);
    expect(env._userKeys.deletes).not.toContain(DEHYDRATED);
    expect(db.dehydrated.get(USER)?.device_id).toBe(DEHYDRATED);
  });

  it('rejects a missing device_data', async () => {
    const body = putBody(DEHYDRATED, { device_data: undefined });
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', body));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects a missing device_keys', async () => {
    const body = putBody(DEHYDRATED, { device_keys: undefined });
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', body));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects device_keys for a different user', async () => {
    const body = putBody(DEHYDRATED, { device_keys: deviceKeysFor(DEHYDRATED, OTHER_USER) });
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', body));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects device_keys for a different device id', async () => {
    const body = putBody(DEHYDRATED, { device_keys: deviceKeysFor('SOMETHINGELSE') });
    const res = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', body));
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects a non-JSON body', async () => {
    const res = await request(env, `${PREFIX}/dehydrated_device`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_BAD_JSON');
  });
});

describe('DELETE /dehydrated_device', () => {
  it('removes the device, its keys and its slot', async () => {
    seedDehydrated(db);
    env._userKeys.deviceKeys[DEHYDRATED] = { stale: true };
    await env._deviceKeysKv.put(`device:${USER}:${DEHYDRATED}`, '{}');

    const res = await request(env, `${PREFIX}/dehydrated_device`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(DEHYDRATED);

    expect(db.dehydrated.has(USER)).toBe(false);
    expect(db.devices.find((d) => d.device_id === DEHYDRATED)).toBeUndefined();
    expect(env._userKeys.deletes).toContain(DEHYDRATED);
    expect(env._deviceKeysKv.store.has(`device:${USER}:${DEHYDRATED}`)).toBe(false);

    const again = await request(env, `${PREFIX}/dehydrated_device`, { method: 'DELETE', headers: AUTH });
    expect(again.status).toBe(404);
    expect(again.body.errcode).toBe('M_NOT_FOUND');
  });

  it('404s when nothing is stored', async () => {
    const res = await request(env, `${PREFIX}/dehydrated_device`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });
});

describe('GET/POST /dehydrated_device/:device_id/events (rehydration paging)', () => {
  function seedEvent(position: number, overrides: Partial<ToDeviceRow> = {}) {
    db.toDevice.push({
      sender_user_id: overrides.sender_user_id ?? OTHER_USER,
      recipient_user_id: overrides.recipient_user_id ?? USER,
      recipient_device_id: overrides.recipient_device_id ?? DEHYDRATED,
      event_type: overrides.event_type ?? 'm.room_key',
      content: overrides.content ?? JSON.stringify({ room_id: '!room:example.com' }),
      stream_position: position,
    });
  }

  it('returns queued to-device events for the dehydrated device only', async () => {
    seedDehydrated(db);
    seedEvent(1);
    seedEvent(2, { event_type: 'm.room_key_request' });
    // Noise: another device and another user must not leak in.
    seedEvent(3, { recipient_device_id: 'DEVICEA' });
    seedEvent(4, { recipient_user_id: OTHER_USER });

    const res = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toEqual({
      sender: OTHER_USER,
      type: 'm.room_key',
      content: { room_id: '!room:example.com' },
    });
    expect(res.body.events[1].type).toBe('m.room_key_request');
    expect(res.body.next_batch).toBeUndefined();
  });

  it('pages with next_batch when a full page is returned, and honors from', async () => {
    seedDehydrated(db);
    for (let i = 1; i <= 100; i++) seedEvent(i);

    const first = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events`, { headers: AUTH });
    expect(first.status).toBe(200);
    expect(first.body.events).toHaveLength(100);
    expect(first.body.next_batch).toBe('100');

    const second = await request(
      env,
      `${PREFIX}/dehydrated_device/${DEHYDRATED}/events?from=${first.body.next_batch}`,
      { headers: AUTH }
    );
    expect(second.status).toBe(200);
    expect(second.body.events).toHaveLength(0);
    expect(second.body.next_batch).toBeUndefined();

    // from mid-stream only returns later events.
    seedEvent(101);
    const mid = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events?from=100`, { headers: AUTH });
    expect(mid.body.events).toHaveLength(1);
    expect(mid.body.events[0].content).toEqual({ room_id: '!room:example.com' });
  });

  it('accepts POST with from in the body (ruma-style)', async () => {
    seedDehydrated(db);
    seedEvent(1);
    seedEvent(2);

    const res = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events`, jsonInit('POST', { from: '1' }));
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });

  it('404s for a device id that is not the stored dehydrated device', async () => {
    seedDehydrated(db, DEHYDRATED);
    const res = await request(env, `${PREFIX}/dehydrated_device/SOMEOTHERDEVICE/events`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('404s when no dehydrated device exists at all', async () => {
    const res = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(res.body.errcode).toBe('M_NOT_FOUND');
  });

  it('treats a garbage from token as the start of the stream', async () => {
    seedDehydrated(db);
    seedEvent(1);
    const res = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events?from=not-a-number`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});

describe('round trip', () => {
  it('PUT -> GET -> events -> DELETE behaves like Element expects', async () => {
    const put = await request(env, `${PREFIX}/dehydrated_device`, jsonInit('PUT', putBody(DEHYDRATED)));
    expect(put.status).toBe(200);

    const get = await request(env, `${PREFIX}/dehydrated_device`, { headers: AUTH });
    expect(get.status).toBe(200);
    expect(get.body.device_id).toBe(DEHYDRATED);
    expect(get.body.device_data).toEqual(putBody(DEHYDRATED).device_data);

    const events = await request(env, `${PREFIX}/dehydrated_device/${DEHYDRATED}/events`, { headers: AUTH });
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual([]);

    const del = await request(env, `${PREFIX}/dehydrated_device`, { method: 'DELETE', headers: AUTH });
    expect(del.status).toBe(200);

    const gone = await request(env, `${PREFIX}/dehydrated_device`, { headers: AUTH });
    expect(gone.status).toBe(404);
  });
});
