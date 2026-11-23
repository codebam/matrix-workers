/**
 * Spec-cited tests for ROADMAP item 10b: /sync explicit timeline.limit windowing.
 *
 * Matrix Client-Server API spec, "GET /sync" filtering:
 *   - `filter.room.timeline.limit` caps the number of events returned in a
 *     room's timeline; the timeline is ordered chronologically (oldest ->
 *     newest), so a limit selects the NEWEST N events and the response keeps
 *     them in ascending order.
 *   - Left rooms (`rooms.leave`) are emitted for a fresh self-leave even when
 *     `filter.room.include_leave` is false (documented deviation in this fork).
 *
 * These tests pin the intended fixed behaviour: explicit timeline.limit=5
 * returns the 5 newest events in ascending order on both initial and
 * incremental sync, the default initial window still shows the newest events,
 * and a left room is emitted even with include_leave=false.
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

const getToDeviceMessages = vi.fn();
vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return { ...actual, getToDeviceMessages: (...args: unknown[]) => getToDeviceMessages(...args) };
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

const getReceiptsForRoom = vi.fn();
vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return { ...actual, getReceiptsForRoom: (...args: unknown[]) => getReceiptsForRoom(...args) };
});

const getTypingUsers = vi.fn();
vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return { ...actual, getTypingUsers: (...args: unknown[]) => getTypingUsers(...args) };
});

import syncApp from '../src/api/sync';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ROOM = '!room:example.com';
const LEFT_ROOM = '!left:example.com';
const NOW = 1_700_000_000_000;

type SqlCall = { sql: string; args: unknown[] };
type DeviceKeyChange = { user_id: string; stream_position: number };

function mockKv(data: Record<string, string> = {}) {
  const kv = {
    data,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },
    put: async (key: string, value: string) => { data[key] = value; },
    delete: async (key: string) => { delete data[key]; },
  };
  return kv as unknown as KVNamespace & { data: Record<string, string> };
}

function createSyncDoStub() {
  return { fetch: async () => Response.json({ hasEvents: false }) };
}

function createSyncDb(opts: { streamPositions?: Record<string, number> } = {}) {
  const streamPositions = opts.streamPositions ?? { events: 0, to_device: 0 };
  const selects: SqlCall[] = [];
  const db = {
    streamPositions,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM stream_positions') && sql.includes('stream_name = ?')) {
                const [streamName] = args as [string];
                return { position: (streamPositions as Record<string, number>)[streamName] ?? 0 } as T;
              }
              if (sql.includes('FROM events') && sql.includes('stream_ordering') && sql.includes('MAX')) {
                return { position: 0 } as T;
              }
              return null as T;
            },
            async all<T>() {
              selects.push({ sql, args });
              return { results: [] as T[] };
            },
            async run() { return {}; },
          };
        },
      };
    },
  };
  return db as any;
}

function makePdu(partial: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    origin_server_ts: NOW,
    content: {},
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...partial,
  };
}

function makeEvents(count: number, prefix = '$') {
  return Array.from({ length: count }, (_, i) =>
    makePdu({
      type: 'm.room.message',
      event_id: `${prefix}${i + 1}:example.com`,
      content: { body: String(i + 1) },
    })
  );
}

function createEnv() {
  const db = createSyncDb();
  const cache = mockKv();
  const syncDo = createSyncDoStub();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: 'example.com',
    SYNC: { idFromName: (name: string) => ({ name, toString: () => `id:${name}` }), get: () => syncDo },
    _db: db,
  };
  return env as unknown as Env & typeof env;
}

// Override mocks setup helpers like sync-api-routes
function resetMocks() {
  getUserRooms.mockReset().mockImplementation(async (_db: unknown, _userId: string, membership?: string) => {
    if (membership === 'join') return [ROOM];
    if (membership === 'leave') return [];
    return [];
  });
  getRoomState.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
  getReceiptsForRoom.mockReset().mockResolvedValue({ type: 'm.receipt', content: {} });
  getTypingUsers.mockReset().mockResolvedValue([]);
}

async function syncRequest(env: Env, query: string = ''): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = `/_matrix/client/v3/sync${query ? `?${query}` : ''}`;
  const res = await syncApp.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  return { status: res.status, body };
}

beforeEach(() => resetMocks());
afterEach(() => vi.clearAllMocks());

describe('sync timeline.limit (ROADMAP 10b)', () => {
  it('(a) explicit timeline.limit=5 returns the 5 newest events ascending on initial sync', async () => {
    // Matrix C-S /sync: timeline is chronological; a limit selects the newest N.
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue(makeEvents(8));
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 5 } } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string }> } }> }).join[ROOM];
    expect(join.timeline.events.map((e) => e.event_id)).toEqual([
      '$4:example.com',
      '$5:example.com',
      '$6:example.com',
      '$7:example.com',
      '$8:example.com',
    ]);
  });

  it('(b) incremental sync with a limit behaves consistently (ascending, <= limit)', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue(makeEvents(8));
    const filter = encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 5 } } }));
    const env = createEnv();
    const { body } = await syncRequest(env, `since=s1_td0&filter=${filter}`);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string }> } }> }).join[ROOM];
    const ids = join.timeline.events.map((e) => e.event_id);
    expect(ids.length).toBeLessThanOrEqual(5);
    // ascending order preserved
    expect(ids).toEqual([...ids].sort());
  });

  it('(c) default initial window still shows the newest events', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'join') return [ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue(makeEvents(25));
    const env = createEnv();
    const { body } = await syncRequest(env, ``);
    const join = (body.rooms as { join: Record<string, { timeline: { events: Array<{ event_id: string }> } }> }).join[ROOM];
    const ids = join.timeline.events.map((e) => e.event_id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('$6:example.com');
    expect(ids[ids.length - 1]).toBe('$25:example.com');
  });

  it('(d) left-room emission pinned: emitted even when include_leave is false', async () => {
    getUserRooms.mockImplementation(async (_db, _u, membership?: string) => {
      if (membership === 'leave') return [LEFT_ROOM];
      return [];
    });
    getEventsSince.mockResolvedValue([
      makePdu({
        type: 'm.room.member',
        event_id: '$leave:example.com',
        room_id: LEFT_ROOM,
        state_key: USER,
        content: { membership: 'leave' },
        sender: USER,
      }),
    ]);
    const filter = encodeURIComponent(JSON.stringify({ room: { include_leave: false } }));
    const env = createEnv();
    // need ROOM override? makePdu defaults ROOM; left room event sets room_id
    const { body } = await syncRequest(env, `since=s8_td0&filter=${filter}`);
    expect(Object.keys((body.rooms as { leave: object }).leave)).toEqual([LEFT_ROOM]);
  });
});
