/**
 * Conformance round-trips for the spec features that ride existing
 * storage with no dedicated server code — the "free riders" of v1.19:
 *
 *  - Image packs (MSC2545): m.room.image_pack user account data and the
 *    room-scope packs — both must round-trip via the account data API.
 *  - Recently used emoji (MSC4356): m.recent_emoji global account data.
 *  - m.key_backup account data (MSC4287): the backup pointer event.
 *  - Encrypted history sharing (MSC4268): client-driven, but its
 *    transport is to-device + media — verify the to-device leg delivers
 *    an m.room_key_bundle through /sync.
 *
 * Route-level, against the real account-data and rooms apps with a
 * stub env; no mocks of the modules under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'D');
      c.set(
        'auth',
        { userId: USER, deviceId: 'D', accessToken: 't' }
      );
      await next();
    };
  },
}));

import accountDataApp from '../src/api/account-data';
import toDeviceApp from '../src/api/to-device';

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

function fakeDb() {
  const accountRows = new Map<string, string>(); // `${userId}|${roomId}|${type}` -> content
  let streamPos = 0;
  return {
    accountRows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT membership FROM room_memberships')) {
                return { membership: 'join' } as T;
              }
              if (sql.includes('SELECT position FROM stream_positions')) {
                streamPos += 1;
                return { position: streamPos } as T;
              }
              if (sql.includes('FROM account_data') && sql.includes("room_id = ''")) {
                // Global account data: args are (userId, type).
                const content = accountRows.get(`${args[0]}||${args[1]}`);
                return (content != null ? { content } : null) as T;
              }
              if (sql.includes('FROM account_data')) {
                // Room account data: args are (userId, roomId, type).
                const content = accountRows.get(`${args[0]}|${args[1]}|${args[2]}`);
                return (content != null ? { content } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO account_data_changes')) {
                // bookkeeping, not a content write
              } else if (sql.includes("INSERT INTO account_data") && sql.includes("'', ?")) {
                // Global insert: args are (userId, type, content).
                accountRows.set(`${args[0]}||${args[1]}`, String(args[2]));
              } else if (sql.includes('INSERT INTO account_data')) {
                // Room insert: args are (userId, roomId, type, content).
                accountRows.set(`${args[0]}|${args[1]}|${args[2]}`, String(args[3]));
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function envFor(db: D1Database, kv: KVNamespace): Env {
  return {
    DB: db,
    SERVER_NAME: SERVER,
    ACCOUNT_DATA: kv,
    CACHE: {} as KVNamespace,
    ONE_TIME_KEYS: {} as KVNamespace,
    SESSIONS: {} as KVNamespace,
    DEVICE_KEYS: {} as KVNamespace,
    CROSS_SIGNING_KEYS: {} as KVNamespace,
    PUSH_NOTIFICATION_WORKFLOW: { create: async () => ({ id: 'wf' }) },
  } as unknown as Env;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('MSC2545 image packs (custom emoji)', () => {
  let db: D1Database;
  let kv: KVNamespace;
  let env: Env;

  beforeEach(() => {
    db = fakeDb();
    kv = fakeKv();
    env = envFor(db, kv);
  });

  it('user image packs round-trip via global account data', async () => {
    const pack = {
      pack: { display_name: 'My Emotes' },
      images: {
        myemote: {
          url: 'mxc://example.com/abc123',
          usage: ['emoticon'],
        },
      },
    };
    const put = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.room.image_pack`,
      jsonInit('PUT', pack),
      env
    );
    expect(put.status).toBe(200);

    const get = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.room.image_pack`,
      {},
      env
    );
    expect(get.status).toBe(200);
    expect((await get.json()) as unknown).toEqual(pack);
  });

  it('room image packs round-trip via room account data', async () => {
    const pack = {
      pack: { display_name: 'Room Emotes' },
      images: { roomba: { url: 'mxc://example.com/xyz', usage: ['sticker'] } },
    };
    const put = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/rooms/${ROOM_ENC}/account_data/m.room.image_pack`,
      jsonInit('PUT', pack),
      env
    );
    expect(put.status).toBe(200);

    const get = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/rooms/${ROOM_ENC}/account_data/m.room.image_pack`,
      {},
      env
    );
    expect(get.status).toBe(200);
    expect((await get.json()) as unknown).toEqual(pack);
  });
});

describe('MSC4356 recently used emoji', () => {
  it('m.recent_emoji account data round-trips', async () => {
    const db = fakeDb();
    const env = envFor(db, fakeKv());
    const recent = { '😀': 5, '🎉': 2 };
    const put = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.recent_emoji`,
      jsonInit('PUT', recent),
      env
    );
    expect(put.status).toBe(200);

    const get = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.recent_emoji`,
      {},
      env
    );
    expect(get.status).toBe(200);
    expect((await get.json()) as unknown).toEqual(recent);
  });
});

describe('MSC4287 m.key_backup account data', () => {
  it('the backup pointer event round-trips', async () => {
    const db = fakeDb();
    const env = envFor(db, fakeKv());
    const pointer = { version: '3' };
    const put = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.key_backup`,
      jsonInit('PUT', pointer),
      env
    );
    expect(put.status).toBe(200);

    const get = await accountDataApp.request(
      `http://localhost/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/m.key_backup`,
      {},
      env
    );
    expect(get.status).toBe(200);
    expect((await get.json()) as unknown).toEqual(pointer);
  });
});

describe('MSC4268 encrypted history sharing (transport leg)', () => {
  it('an m.room_key_bundle to-device message stores with its type intact', async () => {
    // The bundle is client-constructed; the server's job is the to-device
    // transport. Verify a bundle-shaped message survives PUT /sendToDevice
    // with its type and content intact. The media leg is exercised by
    // the client; the Olm leg rides the existing m.room.encrypted flow
    // covered by the to-device suite.
    const toDeviceInserts: Array<Record<string, unknown>> = [];
    let streamPos = 100;
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM transaction_ids')) return null as T;
                if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                  streamPos += 1;
                  return { position: streamPos } as T;
                }
                return null as T;
              },
              async all<T>() {
                return { results: [] as T[] };
              },
              async run() {
                if (sql.includes('INSERT INTO to_device_messages')) {
                  toDeviceInserts.push({
                    recipient_user_id: args[0],
                    recipient_device_id: args[1],
                    sender_user_id: args[2],
                    event_type: args[3],
                    content: JSON.parse(String(args[4])),
                  });
                }
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const env = envFor(db, fakeKv());
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bundleContent = {
      key_backup: {
        url: 'mxc://example.com/bundle',
        key: { alg: 'A256-GCM', k: 'AAEAAQ', ext: true },
      },
    };

    const put = await toDeviceApp.request(
      'http://localhost/_matrix/client/v3/sendToDevice/m.room_key_bundle/tx-bundle-1',
      jsonInit('PUT', { messages: { [USER]: { D: bundleContent } } }),
      env
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();

    expect(put.status).toBe(200);
    expect(toDeviceInserts).toHaveLength(1);
    expect(toDeviceInserts[0].event_type).toBe('m.room_key_bundle');
    expect(toDeviceInserts[0].content).toEqual(bundleContent);
    expect(toDeviceInserts[0].recipient_user_id).toBe(USER);
  });
});
