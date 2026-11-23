/**
 * Complement/Sytest-style port: guest join enforcement (M_GUEST_ACCESS_FORBIDDEN)
 * and mxc:// path-segment sanitization.
 *
 * Spec citations:
 *  - Matrix C-S API guest access: a guest may only join a room whose
 *    m.room.guest_access state content is 'can_join'; otherwise the server
 *    MUST return 403 M_GUEST_ACCESS_FORBIDDEN (spec v1.19, guest join).
 *  - Matrix media repository security: mxc:// URI path segments MUST be
 *    sanitized; malformed segments are rejected with 400 M_INVALID_PARAM.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const authState = vi.hoisted(() => ({ userId: '@guest:example.com' }));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', authState.userId);
    c.set('deviceId', 'DEV1');
    await next();
  },
}));

const getRoom = vi.fn();
const getStateEvent = vi.fn();
const getMembership = vi.fn();
const getRoomEvents = vi.fn();
const storeEventIdempotent = vi.fn();
const tryInsertJoinMembership = vi.fn();
const getRoomByAlias = vi.fn();
const notifyUsersOfEvent = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoom: (...args: unknown[]) => getRoom(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    tryInsertJoinMembership: (...args: unknown[]) => tryInsertJoinMembership(...args),
    getRoomByAlias: (...args: unknown[]) => getRoomByAlias(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
  };
});

const generateDeterministicEventId = vi.fn(async () => '$join:example.com');

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateDeterministicEventId: (...args: unknown[]) => generateDeterministicEventId(...args),
  };
});

import rooms from '../src/api/rooms';
import mediaApp from '../src/api/media';

const GUEST = '@guest:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);

type StateMap = Record<string, PDU | null>;

function pdu(overrides: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: '@creator:example.com',
    content: {},
    origin_server_ts: 1_700_000_000_000,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

function makeDb(isGuest: number) {
  return {
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>() {
          if (sql.includes('SELECT is_guest FROM users WHERE user_id = ?')) {
            return { is_guest: isGuest } as T;
          }
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      });
      return { ...stmt([]), bind: (...a: unknown[]) => stmt(a) };
    },
  } as unknown as D1Database;
}

function mockKv(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function envFor(db: D1Database): Env {
  return {
    DB: db,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
    ROOM_JOIN_WORKFLOW: { create: vi.fn() } as unknown as Env['ROOM_JOIN_WORKFLOW'],
    PUSH_NOTIFICATION_WORKFLOW: {
      create: vi.fn(async () => ({ id: 'push-1' })),
    } as unknown as Env['PUSH_NOTIFICATION_WORKFLOW'],
    FEDERATION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response('Queued') }),
    } as unknown as Env['FEDERATION'],
  } as unknown as Env;
}

async function joinRequest(path: string, isGuest: number) {
  const db = makeDb(isGuest);
  const execCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  const res = await rooms.request(
    `http://localhost${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    envFor(db),
    execCtx as never
  );
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

function seedRoom(guestAccess?: 'can_join' | 'forbidden') {
  getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
  getMembership.mockResolvedValue(null);
  getRoomEvents.mockResolvedValue({ events: [], end: 0 });
  const state: StateMap = {
    'm.room.join_rules': pdu({
      type: 'm.room.join_rules',
      event_id: '$jr',
      content: { join_rule: 'public' },
      state_key: '',
    }),
  };
  if (guestAccess) {
    state['m.room.guest_access'] = pdu({
      type: 'm.room.guest_access',
      event_id: '$ga',
      content: { guest_access: guestAccess },
      state_key: '',
    });
  }
  getStateEvent.mockImplementation(async (_db: unknown, _room: string, type: string) => state[type] ?? null);
}

// --- media harness (minimal) ---
type MediaRow = { media_id: string; user_id: string; content_type: string; content_length: number; filename: string | null; created_at: number };
function createMediaHarness(rows: MediaRow[] = [], seed: Record<string, ArrayBuffer> = {}) {
  const mediaStore = new Map(Object.entries(seed).map(([k, v]) => [k, { body: v }]));
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT content_type, filename FROM media WHERE media_id = ?')) {
                const row = rows.find((r) => r.media_id === args[0]);
                return row ? ({ content_type: row.content_type, filename: row.filename } as T) : null;
              }
              if (sql.includes('SELECT content_type FROM media WHERE media_id = ?')) {
                const row = rows.find((r) => r.media_id === args[0]);
                return row ? ({ content_type: row.content_type } as T) : null;
              }
              return null as T;
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
            async all<T>() { return { results: [] as T[] }; },
          };
        },
      };
    },
  };
  const media = {
    async get(key: string) { return mediaStore.get(key) ?? null; },
    async put() {},
  };
  const cache = { async get() { return null; }, async put() {}, async delete() {} };
  const env = {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: SERVER,
  } as unknown as Env;
  return { env };
}

async function mediaRequest(path: string, env: Env) {
  const res = await mediaApp.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('Content-Type') || '').includes('application/json')) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, text };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.userId = GUEST;
  getRoomByAlias.mockResolvedValue(null);
  storeEventIdempotent.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
  tryInsertJoinMembership.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
  notifyUsersOfEvent.mockResolvedValue(undefined);
});

describe('Complement-style guest join enforcement', () => {
  const JOIN_ROOM = `/_matrix/client/v3/rooms/${ROOM_ENC}/join`;

  it('guest is rejected with M_GUEST_ACCESS_FORBIDDEN in a forbidden room (spec default)', async () => {
    seedRoom('forbidden');
    const { status, body } = await joinRequest(JOIN_ROOM, 1);
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_GUEST_ACCESS_FORBIDDEN' });
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it('guest is allowed into a can_join room', async () => {
    seedRoom('can_join');
    const { status, body } = await joinRequest(JOIN_ROOM, 1);
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
  });
});

describe('Complement-style mxc:// path sanitization', () => {
  it('rejects a traversal-shaped mediaId with M_INVALID_PARAM', async () => {
    const h = createMediaHarness();
    const { status, body } = await mediaRequest(`/_matrix/media/v3/download/${SERVER}/..%2Fetc`, h.env);
    expect(status).toBe(400);
    expect(body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('serves a valid mediaId successfully', async () => {
    const bytes = new TextEncoder().encode('PNGDATA').buffer;
    const h = createMediaHarness([{ media_id: 'abc123', user_id: GUEST, content_type: 'image/png', content_length: bytes.byteLength, filename: null, created_at: 1 }], { abc123: bytes });
    const { status, text } = await mediaRequest(`/_matrix/media/v3/download/${SERVER}/abc123`, h.env);
    expect(status).toBe(200);
    expect(text).toBe('PNGDATA');
  });
});
