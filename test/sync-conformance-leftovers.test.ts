/**
 * Sync-surface conformance: device_lists.left, partial presence fallback,
 * room summary and event_format / event_fields projection. Tests-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

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

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: vi.fn(async () => ({ events: [], nextBatch: '0' })),
  };
});

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: vi.fn(async () => []),
    getRoomAccountData: vi.fn(async () => []),
  };
});

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: vi.fn(async () => ({ type: 'm.receipt', content: {} })),
  };
});

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: vi.fn(async () => []),
  };
});

import syncApp from '../src/api/sync';

const USER = '@alice:example.com';
const BOB = '@bob:remote.example';
const CAROL = '@carol:remote.example';
const DAVE = '@dave:example.com';
const JOINED = '!joined:example.com';
const LEFT = '!left:example.com';
const NAMED = '!named:example.com';
const BANNED = '!banned:example.com';

type Member = { user_id: string; membership: string; display_name?: string; avatar_url?: string };
type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
};

function createDb(opts: {
  deviceKeyChanges?: Array<{ user_id: string; stream_position: number }>;
  roomNames?: string[];
  membersByRoom?: Record<string, Member[]>;
  presenceRows?: PresenceRow[];
} = {}) {
  const deviceKeyChanges = opts.deviceKeyChanges ?? [];
  const roomNames = new Set(opts.roomNames ?? []);
  const membersByRoom = opts.membersByRoom ?? {};
  const presenceRows = opts.presenceRows ?? [];
  return {
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>() {
          if (sql.includes('FROM device_key_changes') && sql.includes('COUNT(*)')) {
            const [sincePos, userId] = args as [number, string];
            return { count: deviceKeyChanges.filter(c => c.user_id === userId && c.stream_position > sincePos).length } as T;
          }
          if (sql.includes('FROM stream_positions')) {
            return { position: 0 } as T;
          }
          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 120)}`);
        },
        async all<T>() {
          if (sql.includes('FROM one_time_keys') || sql.includes('FROM fallback_keys')) {
            return { results: [] as T[] };
          }
          if (sql.includes('SELECT DISTINCT dkc.user_id')) {
            const [sincePos] = args as [number];
            return {
              results: [...new Set(deviceKeyChanges.filter(c => c.stream_position > sincePos).map(c => c.user_id))]
                .map(user_id => ({ user_id }) as unknown as T),
            };
          }
          if (sql.includes("event_type = 'm.room.name'")) {
            const [roomId] = args as [string];
            return { results: roomNames.has(roomId) ? [{ event_id: '$name' }] as unknown as T[] : [] as T[] };
          }
          if (sql.includes('GROUP BY membership')) {
            const [roomId] = args as [string];
            const counts = new Map<string, number>();
            for (const m of membersByRoom[roomId] ?? []) {
              if (m.membership === 'join' || m.membership === 'invite') {
                counts.set(m.membership, (counts.get(m.membership) ?? 0) + 1);
              }
            }
            return { results: [...counts].map(([membership, count]) => ({ membership, count }) as unknown as T) };
          }
          if (sql.includes("membership IN ('join', 'leave', 'ban')")) {
            const [roomId] = args as [string];
            return {
              results: (membersByRoom[roomId] ?? [])
                .filter(m => ['join', 'leave', 'ban'].includes(m.membership))
                .map(m => ({ user_id: m.user_id }) as unknown as T),
            };
          }
          if (sql.includes('LIMIT 5')) {
            const [roomId, exclude] = args as [string, string];
            return {
              results: (membersByRoom[roomId] ?? [])
                .filter(m => m.membership === 'join' && m.user_id !== exclude)
                .slice(0, 5)
                .map(m => ({
                  user_id: m.user_id,
                  display_name: m.display_name ?? null,
                  avatar_url: m.avatar_url ?? null,
                }) as unknown as T),
            };
          }
          if (sql.includes('FROM room_memberships') && sql.includes("membership = 'join'")) {
            const [roomId] = args as [string];
            return {
              results: (membersByRoom[roomId] ?? [])
                .filter(m => m.membership === 'join')
                .map(m => ({ user_id: m.user_id }) as unknown as T),
            };
          }
          if (sql.includes('FROM presence')) {
            const ids = new Set(args as string[]);
            return { results: presenceRows.filter(p => ids.has(p.user_id)) as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          throw new Error(`Unexpected run() SQL: ${sql.slice(0, 120)}`);
        },
      });
      return { ...stmt([]), bind: (...args: unknown[]) => stmt(args) };
    },
  };
}

function makeEnv(db: ReturnType<typeof createDb>) {
  return {
    DB: db as unknown as D1Database,
    CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: (name: string) => ({ name, toString: () => `id:${name}` }),
      get: () => ({ fetch: async () => Response.json({ hasEvents: false }) }),
    },
  } as unknown as Env;
}

function makePdu(partial: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: JOINED,
    sender: USER,
    origin_server_ts: 1_700_000_000_000,
    content: {},
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...partial,
  };
}

function leaveEvent(userId: string, membership: 'leave' | 'ban' = 'leave'): PDU {
  return makePdu({
    type: 'm.room.member',
    event_id: `$${membership}-${userId}:example.com`,
    state_key: userId,
    room_id: LEFT,
    content: { membership },
  });
}

async function sync(env: Env, query = '') {
  const res = await syncApp.request(`http://localhost/_matrix/client/v3/sync${query ? `?${query}` : ''}`, {}, env);
  return JSON.parse(await res.text()) as Record<string, any>;
}

function rooms(response: Record<string, any>) {
  return response.rooms as { join: Record<string, any>; leave: Record<string, any> };
}

beforeEach(() => {
  getUserRooms.mockReset().mockImplementation(async (_db: unknown, _u: string, membership?: string) => {
    if (membership === 'join') return [JOINED];
    return [];
  });
  getRoomState.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(100);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Issue 1: device_lists.left / changed
// ---------------------------------------------------------------------------

describe('GET /sync device_lists.left after leaving a shared room', () => {
  it('lists remote members of a room the caller left since the token', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) =>
      membership === 'join' ? [JOINED] : membership === 'leave' ? [LEFT] : []
    );
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) =>
      roomId === LEFT ? [leaveEvent(USER)] : []
    );
    const env = makeEnv(createDb({
      membersByRoom: {
        [LEFT]: [
          { user_id: USER, membership: 'leave' },
          { user_id: BOB, membership: 'join' },
          { user_id: CAROL, membership: 'leave' },
          { user_id: DAVE, membership: 'join' }, // local — must not be listed
        ],
      },
    }));

    const response = await sync(env, 'since=s50_td0');
    expect(response.device_lists).toEqual({ changed: [], left: [BOB, CAROL] });
    expect(rooms(response).leave[LEFT]).toBeDefined();
  });

  it('lists remote members when the caller was banned (membership ban)', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) =>
      membership === 'join' ? [JOINED] : membership === 'ban' ? [BANNED] : []
    );
    getEventsSince.mockImplementation(async (_db: unknown, roomId: string) =>
      roomId === BANNED ? [leaveEvent(USER, 'ban')] : []
    );
    const env = makeEnv(createDb({
      membersByRoom: { [BANNED]: [{ user_id: BOB, membership: 'join' }] },
    }));

    const response = await sync(env, 'since=s50_td0');
    expect(response.device_lists.left).toEqual([BOB]);
  });

  it('is empty when no membership transition happened since the token', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) =>
      membership === 'join' ? [JOINED] : membership === 'leave' ? [LEFT] : []
    );
    const env = makeEnv(createDb({
      membersByRoom: { [LEFT]: [{ user_id: BOB, membership: 'join' }] },
    }));

    const response = await sync(env, 'since=s50_td0');
    expect(response.device_lists).toBeUndefined();
  });

  it('changed still flows from device_key_changes keyed by user_id and stream position', async () => {
    const env = makeEnv(createDb({
      deviceKeyChanges: [
        { user_id: BOB, stream_position: 51 },
        { user_id: CAROL, stream_position: 12 }, // stale
      ],
      membersByRoom: { [JOINED]: [{ user_id: BOB, membership: 'join' }] },
    }));

    const response = await sync(env, 'since=s50_td0_ad0_dk50');
    expect(response.device_lists).toEqual({ changed: [BOB], left: [] });
  });

  it('does not emit left on initial sync', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) =>
      membership === 'leave' ? [LEFT] : []
    );
    const env = makeEnv(createDb());
    const response = await sync(env);
    expect(response.device_lists).toEqual({ changed: [USER], left: [] });
  });
});

// ---------------------------------------------------------------------------
// Issue 2: partial presence fallback
// ---------------------------------------------------------------------------

describe('GET /sync presence.events (partial fallback)', () => {
  const now = Date.now();

  it('emits current presence for the caller and shared-room users on initial sync', async () => {
    const env = makeEnv(createDb({
      membersByRoom: { [JOINED]: [{ user_id: USER, membership: 'join' }, { user_id: BOB, membership: 'join' }] },
      presenceRows: [
        { user_id: USER, presence: 'online', status_msg: 'here', last_active_ts: now - 1000 },
        { user_id: BOB, presence: 'online', status_msg: null, last_active_ts: now - 1000 },
      ],
    }));

    const response = await sync(env);
    expect(response.presence.events).toHaveLength(2);
    const bySender = Object.fromEntries(response.presence.events.map((e: any) => [e.sender, e.content]));
    expect(bySender[USER]).toMatchObject({ presence: 'online', status_msg: 'here', currently_active: true });
    expect(bySender[BOB]).toMatchObject({ presence: 'online', currently_active: true });
    expect(bySender[BOB].last_active_ago).toBeGreaterThanOrEqual(0);
  });

  it('downgrades stale online to unavailable and reports empty incremental presence', async () => {
    const db = createDb({
      membersByRoom: { [JOINED]: [{ user_id: BOB, membership: 'join' }] },
      presenceRows: [{ user_id: BOB, presence: 'online', status_msg: null, last_active_ts: 1 }],
    });
    const initial = await sync(makeEnv(db));
    expect(initial.presence.events[0].content.presence).toBe('unavailable');
    expect(initial.presence.events[0].content.currently_active).toBe(false);

    // No presence stream exists → incremental syncs deliberately emit nothing.
    const incremental = await sync(makeEnv(db), 'since=s50_td0');
    expect(incremental.presence).toEqual({ events: [] });
  });

  it('applies the presence filter to emitted events', async () => {
    const env = makeEnv(createDb({
      presenceRows: [{ user_id: USER, presence: 'online', status_msg: null, last_active_ts: now }],
    }));
    const filter = encodeURIComponent(JSON.stringify({ presence: { not_types: ['m.presence'] } }));
    const response = await sync(env, `filter=${filter}`);
    expect(response.presence).toEqual({ events: [] });
  });
});

// ---------------------------------------------------------------------------
// Issue 3: room summary + event filters
// ---------------------------------------------------------------------------

describe('GET /sync joined room summary', () => {
  it('emits heroes and counts for an unnamed small room, none for a named room', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, membership?: string) =>
      membership === 'join' ? [JOINED, NAMED] : []
    );
    const env = makeEnv(createDb({
      roomNames: [NAMED],
      membersByRoom: {
        [JOINED]: [
          { user_id: USER, membership: 'join' },
          { user_id: BOB, membership: 'join', display_name: 'Bob', avatar_url: 'mxc://avatar' },
          { user_id: CAROL, membership: 'join' },
          { user_id: DAVE, membership: 'invite' },
        ],
        [NAMED]: [{ user_id: USER, membership: 'join' }, { user_id: BOB, membership: 'join' }],
      },
    }));

    const response = await sync(env);
    expect(rooms(response).join[JOINED].summary).toEqual({
      'm.heroes': [BOB, CAROL],
      'm.joined_member_count': 3,
      'm.invited_member_count': 1,
    });
    expect(rooms(response).join[NAMED].summary).toBeUndefined();
  });
});

describe('GET /sync event_format and event_fields', () => {
  const event = makePdu({
    type: 'm.room.message',
    event_id: '$msg:example.com',
    content: { msgtype: 'm.text', body: 'hi' },
    hashes: { sha256: 'abc' },
    signatures: { 'remote.example': { ed25519: 'sig' } },
  });

  beforeEach(() => {
    getEventsSince.mockResolvedValue([event]);
  });

  async function timelineFor(filter: Record<string, unknown>) {
    const env = makeEnv(createDb());
    const response = await sync(env, `filter=${encodeURIComponent(JSON.stringify(filter))}`);
    return rooms(response).join[JOINED].timeline.events[0] as Record<string, unknown>;
  }

  it('client format strips federation-only PDU fields', async () => {
    const delivered = await timelineFor({ event_format: 'client' });
    for (const key of ['depth', 'auth_events', 'prev_events', 'hashes', 'signatures']) {
      expect(delivered).not.toHaveProperty(key);
    }
    expect(delivered).toHaveProperty('event_id', '$msg:example.com');
  });

  it('federation format keeps federation-only PDU fields', async () => {
    const delivered = await timelineFor({ event_format: 'federation' });
    expect(delivered).toMatchObject({
      depth: 1,
      auth_events: [],
      prev_events: [],
      hashes: { sha256: 'abc' },
      signatures: { 'remote.example': { ed25519: 'sig' } },
    });
  });

  it('event_fields projects to the requested top-level fields', async () => {
    const delivered = await timelineFor({ event_fields: ['type', 'sender', 'content'] });
    expect(Object.keys(delivered).sort()).toEqual(['content', 'sender', 'type']);
  });

  it('empty event_fields means all fields', async () => {
    const delivered = await timelineFor({ event_fields: [] });
    expect(delivered).toHaveProperty('event_id', '$msg:example.com');
    expect(Object.keys(delivered).length).toBeGreaterThan(3);
  });
});
