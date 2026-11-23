/**
 * MSC4326 (Matrix spec v1.17) — appservice device masquerade.
 *
 * Exercises the real requireAuth() attached to the client /sync route: an
 * appservice may pass ?device_id= alongside ?user_id= (or alone, in which case
 * the device must belong to its own sender_localpart user), but must not be
 * able to claim a foreign or unknown device. The downstream consumers —
 * getToDeviceMessages' recipient_device_id filter and the device-scoped OTK /
 * fallback-key counts — run for real against the D1 mock below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

// Stub only the room/account-data side of /sync; auth and all device-scoped
// helpers stay real so the assertions cover the whole request path.
const getUserRooms = vi.fn();
const getRoomState = vi.fn();
const getEventsSince = vi.fn();
const getLatestStreamPosition = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getEventsSince: (...args: unknown[]) => getEventsSince(...args),
    getLatestStreamPosition: (...args: unknown[]) => getLatestStreamPosition(...args),
  };
});

const getGlobalAccountData = vi.fn();
const getRoomAccountData = vi.fn();

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: (...args: unknown[]) => getGlobalAccountData(...args),
    getRoomAccountData: (...args: unknown[]) => getRoomAccountData(...args),
  };
});

import syncApp from '../src/api/sync';
import { requireAuth } from '../src/middleware/auth';

const SERVER = 'example.com';
const AS_TOKEN = 'as_masquerade_secret';
const BOT = '@bot_alice:example.com';
const BRIDGE_USER = '@bridge:example.com';
const OUTSIDE_NS_USER = '@alice:example.com';
const OTHER_USER = '@bob:example.com';
const BOT_DEVICE = 'DEV_BOT';
const BOT_DEVICE_2 = 'DEV_BOT_2';
const BRIDGE_DEVICE = 'DEV_BRIDGE';
const FOREIGN_DEVICE = 'DEV_BOB';
const ALICE_DEVICE = 'DEV_ALICE';

type DeviceRow = { user_id: string; device_id: string };
type ToDeviceRow = {
  recipient_user_id: string;
  recipient_device_id: string;
  event_type: string;
  content: string;
  stream_position: number;
};
type KeyRow = {
  user_id: string;
  device_id: string;
  algorithm: string;
  claimed?: number;
  used?: number;
};
type SqlCall = { sql: string; args: unknown[] };

function createDb(opts: {
  devices?: DeviceRow[];
  toDevice?: ToDeviceRow[];
  oneTimeKeys?: KeyRow[];
  fallbackKeys?: KeyRow[];
} = {}) {
  const devices = opts.devices ?? [];
  const toDevice = opts.toDevice ?? [];
  const oneTimeKeys = opts.oneTimeKeys ?? [];
  const fallbackKeys = opts.fallbackKeys ?? [];
  const selects: SqlCall[] = [];

  const db = {
    selects,
    prepare(sql: string) {
      const bound = (...args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });

          // Regular access-token lookup misses: this is an AS token.
          if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
            return null as T;
          }
          if (sql.includes('FROM appservice_registrations') && sql.includes('as_token')) {
            return {
              id: 'as1',
              url: 'https://as.example.com',
              as_token: AS_TOKEN,
              hs_token: 'hs_token',
              sender_localpart: 'bridge',
              rate_limited: 0,
              protocols: null,
              namespaces: JSON.stringify({
                users: [{ exclusive: true, regex: '@bot_.*:example\\.com' }],
                rooms: [],
                aliases: [],
              }),
            } as T;
          }
          // The new MSC4326 ownership check in auth.ts.
          if (sql.includes('FROM devices') && sql.includes('device_id = ?')) {
            const [userId, deviceId] = args as [string, string];
            const row = devices.find(
              (d) => d.user_id === userId && d.device_id === deviceId
            );
            return (row ? { device_id: row.device_id } : null) as T;
          }
          if (sql.includes('FROM stream_positions') && sql.includes('stream_name = ?')) {
            return { position: 0 } as T;
          }
          if (sql.includes('MAX(stream_position)') && sql.includes('to_device_messages')) {
            const maxPos = toDevice.reduce((max, row) => Math.max(max, row.stream_position), 0);
            return { max_pos: maxPos } as T;
          }

          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 160)}`);
        },

        async all<T>() {
          selects.push({ sql, args });

          if (sql.includes('FROM to_device_messages') && sql.includes('recipient_device_id = ?')) {
            const [userId, deviceId, sincePos, limit] = args as [string, string, number, number];
            const rows = toDevice
              .filter(
                (r) =>
                  r.recipient_user_id === userId &&
                  r.recipient_device_id === deviceId &&
                  r.stream_position > sincePos
              )
              .slice(0, limit);
            return {
              results: rows.map((r) => ({
                id: 1,
                sender_user_id: '@sender:example.com',
                event_type: r.event_type,
                content: r.content,
                stream_position: r.stream_position,
              })) as T[],
            };
          }
          if (sql.includes('FROM one_time_keys') && sql.includes('GROUP BY algorithm')) {
            const [userId, deviceId] = args as [string, string];
            const counts = new Map<string, number>();
            for (const key of oneTimeKeys) {
              if (key.user_id === userId && key.device_id === deviceId && key.claimed !== 1) {
                counts.set(key.algorithm, (counts.get(key.algorithm) ?? 0) + 1);
              }
            }
            return {
              results: [...counts].map(([algorithm, count]) => ({ algorithm, count })) as T[],
            };
          }
          if (sql.includes('FROM fallback_keys') && sql.includes('DISTINCT algorithm')) {
            const [userId, deviceId] = args as [string, string];
            const algorithms = [
              ...new Set(
                fallbackKeys
                  .filter((k) => k.user_id === userId && k.device_id === deviceId && k.used !== 1)
                  .map((k) => k.algorithm)
              ),
            ];
            return { results: algorithms.map((algorithm) => ({ algorithm })) as T[] };
          }

          return { results: [] as T[] };
        },

        async run() {
          selects.push({ sql, args });
          return { meta: { changes: 0 } };
        },
      });
      // Some helpers (e.g. to-device's max-position read) call first()/all()
      // directly on prepare() without binding anything.
      return {
        first: <T>() => bound().first<T>(),
        all: <T>() => bound().all<T>(),
        run: () => bound().run(),
        bind: bound,
      };
    },
  };
  return db as unknown as D1Database & { selects: SqlCall[] };
}

type SyncDb = ReturnType<typeof createDb>;

function createEnv(db: SyncDb) {
  const env = {
    DB: db,
    SERVER_NAME: SERVER,
    CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
    SYNC: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ hasEvents: false }) }),
    },
  };
  return env as unknown as Env;
}

async function syncRequest(db: SyncDb, query: string) {
  const res = await syncApp.request(
    `http://localhost/_matrix/client/v3/sync?${query}`,
    { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
    createEnv(db)
  );
  const body = (await res.json()) as {
    errcode?: string;
    error?: string;
    to_device?: { events: Array<{ type: string; sender: string; content: Record<string, unknown> }> };
    device_one_time_keys_count?: Record<string, number>;
    device_unused_fallback_key_types?: string[];
  };
  return { status: res.status, body };
}

// Direct middleware harness (mirrors test/auth-middleware.test.ts) to pin the
// auth context itself, not just the downstream symptoms.
function makeAuthCtx(db: SyncDb, url: string) {
  const headers = new Headers({ Authorization: `Bearer ${AS_TOKEN}` });
  const raw = new Request(url, { headers });
  const store = new Map<string, unknown>();
  return {
    req: { raw, url, header: (name: string) => headers.get(name) },
    env: { DB: db, SERVER_NAME: SERVER },
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    _store: store,
  } as unknown as Parameters<ReturnType<typeof requireAuth>>[0];
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  getUserRooms.mockReset().mockResolvedValue([]);
  getRoomState.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /sync with as_token device masquerade (MSC4326)', () => {
  const baseToDevice: ToDeviceRow[] = [
    {
      recipient_user_id: BOT,
      recipient_device_id: BOT_DEVICE,
      event_type: 'm.room_key',
      content: JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }),
      stream_position: 7,
    },
    {
      recipient_user_id: BOT,
      recipient_device_id: BOT_DEVICE_2,
      event_type: 'm.room_key',
      content: JSON.stringify({ algorithm: 'for.the.other.device' }),
      stream_position: 8,
    },
  ];

  it('returns the masqueraded device\'s to-device messages and device-scoped key counts', async () => {
    const db = createDb({
      devices: [{ user_id: BOT, device_id: BOT_DEVICE }],
      toDevice: baseToDevice,
      oneTimeKeys: [
        { user_id: BOT, device_id: BOT_DEVICE, algorithm: 'signed_curve25519' },
        { user_id: BOT, device_id: BOT_DEVICE, algorithm: 'signed_curve25519' },
        { user_id: BOT, device_id: BOT_DEVICE_2, algorithm: 'signed_curve25519' },
      ],
      fallbackKeys: [
        { user_id: BOT, device_id: BOT_DEVICE, algorithm: 'signed_curve25519' },
        { user_id: BOT, device_id: BOT_DEVICE_2, algorithm: 'curve25519' },
      ],
    });

    const { status, body } = await syncRequest(db, `user_id=${BOT}&device_id=${BOT_DEVICE}`);
    expect(status).toBe(200);
    expect(body.to_device!.events).toEqual([
      {
        type: 'm.room_key',
        sender: '@sender:example.com',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ]);
    expect(body.device_one_time_keys_count).toEqual({ signed_curve25519: 2 });
    expect(body.device_unused_fallback_key_types).toEqual(['signed_curve25519']);
  });

  it('rejects a device belonging to a different user with 403 M_FORBIDDEN', async () => {
    const db = createDb({
      devices: [
        { user_id: BOT, device_id: BOT_DEVICE },
        { user_id: OTHER_USER, device_id: FOREIGN_DEVICE },
      ],
      toDevice: baseToDevice,
    });

    const { status, body } = await syncRequest(db, `user_id=${BOT}&device_id=${FOREIGN_DEVICE}`);
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(body.error).toMatch(/device/i);
  });

  it('rejects an unknown device with 403 M_FORBIDDEN', async () => {
    const db = createDb({ devices: [{ user_id: BOT, device_id: BOT_DEVICE }] });

    const { status, body } = await syncRequest(db, `user_id=${BOT}&device_id=DEV_UNKNOWN`);
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('leaves device-scoped delivery disabled when no device_id is supplied', async () => {
    const db = createDb({
      devices: [{ user_id: BOT, device_id: BOT_DEVICE }],
      toDevice: baseToDevice,
      oneTimeKeys: [{ user_id: BOT, device_id: BOT_DEVICE, algorithm: 'signed_curve25519' }],
    });

    const { status, body } = await syncRequest(db, `user_id=${BOT}`);
    expect(status).toBe(200);
    // Same as before MSC4326: requireAuth sets deviceId: null, so /sync's
    // `if (deviceId)` block (to-device + OTK counts) is skipped entirely.
    expect(body.to_device!.events).toEqual([]);
    expect(body.device_one_time_keys_count).toEqual({});
    expect(db.selects.some((s) => s.sql.includes('FROM to_device_messages'))).toBe(false);
  });

  it('validates the device against the appservice sender_localpart user when user_id is absent', async () => {
    const db = createDb({
      devices: [{ user_id: BRIDGE_USER, device_id: BRIDGE_DEVICE }],
      toDevice: [
        {
          recipient_user_id: BRIDGE_USER,
          recipient_device_id: BRIDGE_DEVICE,
          event_type: 'm.dummy',
          content: '{}',
          stream_position: 3,
        },
      ],
      oneTimeKeys: [{ user_id: BRIDGE_USER, device_id: BRIDGE_DEVICE, algorithm: 'signed_curve25519' }],
    });

    const ok = await syncRequest(db, `device_id=${BRIDGE_DEVICE}`);
    expect(ok.status).toBe(200);
    expect(ok.body.to_device!.events).toHaveLength(1);
    expect(ok.body.device_one_time_keys_count).toEqual({ signed_curve25519: 1 });

    const bad = await syncRequest(db, `device_id=${FOREIGN_DEVICE}`);
    expect(bad.status).toBe(403);
    expect(bad.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });

  it('still enforces the appservice user namespace when a device_id is supplied', async () => {
    const db = createDb({
      devices: [{ user_id: OUTSIDE_NS_USER, device_id: ALICE_DEVICE }],
      toDevice: baseToDevice,
    });

    const { status, body } = await syncRequest(
      db,
      `user_id=${OUTSIDE_NS_USER}&device_id=${ALICE_DEVICE}`
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({
      errcode: 'M_FORBIDDEN',
      error: 'User not in application service namespace',
    });
  });
});

describe('requireAuth context with device masquerade', () => {
  it('sets auth.deviceId to the validated device', async () => {
    const db = createDb({ devices: [{ user_id: BOT, device_id: BOT_DEVICE }] });
    const ctx = makeAuthCtx(db, `https://${SERVER}/_matrix/client/v3/sync?user_id=${BOT}&device_id=${BOT_DEVICE}`);
    const next = vi.fn(async () => 'ok');

    await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('userId')).toBe(BOT);
    expect(ctx.get('deviceId')).toBe(BOT_DEVICE);
    expect(ctx.get('auth')).toMatchObject({ userId: BOT, deviceId: BOT_DEVICE });
  });

  it('keeps deviceId null when no device_id is supplied', async () => {
    const db = createDb();
    const ctx = makeAuthCtx(db, `https://${SERVER}/_matrix/client/v3/sync?user_id=${BOT}`);
    const next = vi.fn(async () => 'ok');

    await expect(requireAuth()(ctx, next)).resolves.toBe('ok');
    expect(ctx.get('userId')).toBe(BOT);
    expect(ctx.get('deviceId')).toBeNull();
  });
});
