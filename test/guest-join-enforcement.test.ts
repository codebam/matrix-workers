/**
 * Guest join enforcement (spec audit item 10a): a guest may only join a room
 * whose m.room.guest_access state content is 'can_join'. All other cases —
 * including a room with no guest_access event at all (the spec default) —
 * reject with 403 M_GUEST_ACCESS_FORBIDDEN. Guest status is local to the
 * user's own homeserver, so this is enforced on both C-S join routes rather
 * than federation make_join (which cannot observe a remote user's flag).
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

const GUEST = '@guest:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const ALIAS = '#general:example.com';
const ALIAS_ENC = encodeURIComponent(ALIAS);

type Select = { sql: string; args: unknown[] };
type TestDb = D1Database & { selects: Select[] };
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

/** Raw D1 mock — only the is_guest lookup is answered; everything else is empty. */
function makeDb(isGuest: number): TestDb {
  const selects: Select[] = [];
  return {
    selects,
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>() {
          selects.push({ sql, args });
          if (sql.includes('SELECT is_guest FROM users WHERE user_id = ?')) {
            return { is_guest: isGuest } as T;
          }
          return null as T;
        },
        async all<T>() {
          selects.push({ sql, args });
          return { results: [] as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      });
      return { ...stmt([]), bind: (...a: unknown[]) => stmt(a) };
    },
  } as unknown as TestDb;
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

function envFor(db: TestDb): Env {
  return {
    DB: db as unknown as D1Database,
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

async function request(path: string, db: TestDb) {
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
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

const JOIN_ROOM = `/_matrix/client/v3/rooms/${ROOM_ENC}/join`;
const JOIN_ALIAS = `/_matrix/client/v3/join/${ROOM_ENC}`;

/** Seed a local public room; guest_access state is whatever the test passes. */
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
  getStateEvent.mockImplementation(async (_db, _room: string, type: string) => state[type] ?? null);
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.userId = GUEST;
  getRoomByAlias.mockResolvedValue(null);
  storeEventIdempotent.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
  tryInsertJoinMembership.mockResolvedValue({ inserted: true, eventId: '$join:example.com' });
  notifyUsersOfEvent.mockResolvedValue(undefined);
});

describe.each([
  ['POST /rooms/:roomId/join', JOIN_ROOM],
  ['POST /join/:roomIdOrAlias (room ID)', JOIN_ALIAS],
])('guest enforcement on %s', (_label, path) => {
  it('403 M_GUEST_ACCESS_FORBIDDEN for a guest in a guest_access=forbidden room', async () => {
    seedRoom('forbidden');
    const db = makeDb(1);
    const { status, body } = await request(path, db);
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_GUEST_ACCESS_FORBIDDEN' });
    expect(storeEventIdempotent).not.toHaveBeenCalled();
    expect(tryInsertJoinMembership).not.toHaveBeenCalled();
    expect(db.selects.some((s) => s.sql.includes('SELECT is_guest FROM users'))).toBe(true);
  });

  it('403 for a guest in a room with no m.room.guest_access event (spec default)', async () => {
    seedRoom(undefined);
    const { status, body } = await request(path, makeDb(1));
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_GUEST_ACCESS_FORBIDDEN' });
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it('allows a guest into a guest_access=can_join room', async () => {
    seedRoom('can_join');
    const { status, body } = await request(path, makeDb(1));
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(tryInsertJoinMembership).toHaveBeenCalledWith(
      expect.anything(),
      ROOM,
      GUEST,
      '$join:example.com'
    );
  });

  it('leaves non-guests unaffected by a guest_access=forbidden room', async () => {
    seedRoom('forbidden');
    const { status, body } = await request(path, makeDb(0));
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
    expect(tryInsertJoinMembership).toHaveBeenCalled();
  });
});

describe('guest enforcement via room alias', () => {
  it('403 M_GUEST_ACCESS_FORBIDDEN when joining a forbidden room by alias', async () => {
    seedRoom('forbidden');
    getRoomByAlias.mockResolvedValue(ROOM);
    const { status, body } = await request(`/_matrix/client/v3/join/${ALIAS_ENC}`, makeDb(1));
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_GUEST_ACCESS_FORBIDDEN' });
    expect(storeEventIdempotent).not.toHaveBeenCalled();
  });

  it('allows a guest joining a can_join room by alias', async () => {
    seedRoom('can_join');
    getRoomByAlias.mockResolvedValue(ROOM);
    const { status, body } = await request(`/_matrix/client/v3/join/${ALIAS_ENC}`, makeDb(1));
    expect(status).toBe(200);
    expect(body).toEqual({ room_id: ROOM });
  });
});
