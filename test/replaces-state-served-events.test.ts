/**
 * Spec v1.19: unsigned.replaces_state on served state events, and the
 * /context `filter` parameter. Mirrors the mocked-DB route harness used by
 * test/rooms-api-routes.test.ts and test/sync-api-routes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';
import { attachReplacesState } from '../src/services/replaces-state';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      c.set('auth', {
        userId: '@alice:example.com',
        deviceId: 'DEVICEA',
        accessToken: 't',
      });
      await next();
    };
  },
}));

const getMembership = vi.fn();
const getRoomState = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const getEvent = vi.fn();
const getUserRooms = vi.fn();
const getEventsSince = vi.fn();
const getLatestStreamPosition = vi.fn();
const storeEvent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const getToDeviceMessages = vi.fn();
const getGlobalAccountData = vi.fn();
const getRoomAccountData = vi.fn();
const getReceiptsForRoom = vi.fn();
const getTypingUsers = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...a: unknown[]) => getMembership(...a),
    getRoomState: (...a: unknown[]) => getRoomState(...a),
    getStateEvent: (...a: unknown[]) => getStateEvent(...a),
    getRoomEvents: (...a: unknown[]) => getRoomEvents(...a),
    getEvent: (...a: unknown[]) => getEvent(...a),
    getUserRooms: (...a: unknown[]) => getUserRooms(...a),
    getEventsSince: (...a: unknown[]) => getEventsSince(...a),
    getLatestStreamPosition: (...a: unknown[]) => getLatestStreamPosition(...a),
    storeEvent: (...a: unknown[]) => storeEvent(...a),
    notifyUsersOfEvent: (...a: unknown[]) => notifyUsersOfEvent(...a),
  };
});

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: (...a: unknown[]) => getToDeviceMessages(...a),
  };
});

vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: (...a: unknown[]) => getGlobalAccountData(...a),
    getRoomAccountData: (...a: unknown[]) => getRoomAccountData(...a),
  };
});

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: (...a: unknown[]) => getReceiptsForRoom(...a),
  };
});

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: (...a: unknown[]) => getTypingUsers(...a),
  };
});

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
  invalidateRoomCache: vi.fn(async () => undefined),
}));

const generateEventId = vi.fn(async () => '$new-topic:example.com');
vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateEventId: (...a: unknown[]) => generateEventId(...a),
  };
});

import rooms from '../src/api/rooms';
import syncApp from '../src/api/sync';

const USER = '@alice:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const OLD = '$old-topic:example.com';
const NEW = '$new-topic:example.com';
const MSG = '$msg:example.com';
const NOW = 1_700_000_000_000;

type DbEvent = {
  event_id: string;
  room_id: string;
  event_type?: string;
  type?: string;
  state_key?: string | null;
  sender?: string;
  content?: string;
  origin_server_ts?: number;
  unsigned?: string | null;
  depth: number;
  stream_ordering?: number | null;
};

type SqlCall = { sql: string; args: unknown[] };

/** Mock D1 whose one recognised enrichment query walks an in-memory event table. */
function createDb(
  rows: DbEvent[] = [],
  opts: { contextBefore?: DbEvent[]; contextAfter?: DbEvent[] } = {}
) {
  const selects: SqlCall[] = [];
  const typeOf = (e: DbEvent) => e.event_type ?? e.type ?? '';
  const db = {
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const call = { sql, args };
          return {
            async first<T>() {
              selects.push(call);
              return null as T;
            },
            async all<T>() {
              selects.push(call);
              if (sql.includes('AS replaces_state')) {
                const ids = JSON.parse(args[0] as string) as string[];
                const results = ids.map((eventId) => {
                  const served = rows.find((e) => e.event_id === eventId);
                  if (!served) return { served_event_id: eventId, replaces_state: null };
                  const predecessors = rows
                    .filter(
                      (e) =>
                        e.event_id !== eventId &&
                        e.room_id === served.room_id &&
                        typeOf(e) === typeOf(served) &&
                        (e.state_key ?? null) === (served.state_key ?? null) &&
                        (e.depth < served.depth ||
                          (e.depth === served.depth &&
                            (e.stream_ordering ?? 0) < (served.stream_ordering ?? 0)))
                    )
                    .sort(
                      (a, b) =>
                        b.depth - a.depth || (b.stream_ordering ?? 0) - (a.stream_ordering ?? 0)
                    );
                  return {
                    served_event_id: eventId,
                    replaces_state: predecessors[0]?.event_id ?? null,
                  };
                });
                return { results } as unknown as { results: T[] };
              }
              if (sql.includes('origin_server_ts < ?')) {
                return { results: (opts.contextBefore ?? []) as unknown as T[] };
              }
              if (sql.includes('origin_server_ts > ?')) {
                return { results: (opts.contextAfter ?? []) as unknown as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ success: true }));
    },
  };
  return db;
}

type Db = ReturnType<typeof createDb>;

function mockKv() {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function envFor(db: Db): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: 'example.com',
    SYNC: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async () => Response.json({ hasEvents: false }),
      }),
    },
    FEDERATION: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response('Queued') }),
    },
  } as unknown as Env;
}

function execCtx() {
  return { waitUntil() {}, passThroughOnException() {}, props: {} };
}

async function roomsRequest(path: string, init: RequestInit, db: Db) {
  const res = await rooms.request(`http://localhost${path}`, init, envFor(db), execCtx() as never);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function syncRequest(path: string, db: Db) {
  const res = await syncApp.request(`http://localhost${path}`, {}, envFor(db));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  };
}

const oldTopicRow: DbEvent = {
  event_id: OLD,
  room_id: ROOM,
  event_type: 'm.room.topic',
  state_key: '',
  sender: USER,
  content: JSON.stringify({ topic: 'old' }),
  origin_server_ts: NOW - 100,
  unsigned: null,
  depth: 1,
  stream_ordering: 1,
};
const newTopicRow: DbEvent = {
  ...oldTopicRow,
  event_id: NEW,
  content: JSON.stringify({ topic: 'new' }),
  origin_server_ts: NOW,
  depth: 2,
  stream_ordering: 2,
};
const messageRow: DbEvent = {
  ...newTopicRow,
  event_id: MSG,
  event_type: 'm.room.message',
  state_key: undefined,
  content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
  origin_server_ts: NOW + 10,
  depth: 3,
  stream_ordering: 3,
};

function toPdu(row: DbEvent, overrides: Partial<PDU> = {}): PDU {
  return {
    event_id: row.event_id,
    room_id: row.room_id,
    sender: row.sender ?? USER,
    type: row.event_type ?? row.type ?? '',
    state_key: row.state_key ?? undefined,
    content: JSON.parse(row.content ?? '{}'),
    origin_server_ts: row.origin_server_ts ?? NOW,
    unsigned: row.unsigned ? JSON.parse(row.unsigned) : undefined,
    depth: row.depth,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

function joinMembership() {
  return { membership: 'join', eventId: '$join' };
}

function countEnrichmentQueries(db: Db): number {
  return db.selects.filter((s) => s.sql.includes('AS replaces_state')).length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getMembership.mockReset().mockResolvedValue(joinMembership());
  getRoomState.mockReset().mockResolvedValue([]);
  getStateEvent.mockReset().mockResolvedValue(null);
  getRoomEvents.mockReset().mockResolvedValue({ events: [], end: 0 });
  getEvent.mockReset().mockResolvedValue(null);
  getUserRooms.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  storeEvent.mockReset().mockResolvedValue(1);
  notifyUsersOfEvent.mockReset().mockResolvedValue(undefined);
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
  getReceiptsForRoom.mockReset().mockResolvedValue({ type: 'm.receipt', content: {} });
  getTypingUsers.mockReset().mockResolvedValue([]);
  generateEventId.mockReset().mockResolvedValue(NEW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

describe('attachReplacesState', () => {
  it('fills missing values from ONE batched query and forwards existing unsigned unchanged', async () => {
    const db = createDb([oldTopicRow, newTopicRow]);
    const forwarded = {
      event_id: NEW,
      room_id: ROOM,
      state_key: '',
      unsigned: { age: 12, transaction_id: 'tx' },
    };
    const alreadySet = {
      event_id: '$written:example.com',
      room_id: ROOM,
      state_key: '',
      unsigned: { replaces_state: '$from-put' },
    };
    const message = { event_id: MSG, room_id: ROOM, unsigned: { age: 3 } };
    const events = [forwarded, alreadySet, message];

    await attachReplacesState(db as never, events);

    expect(countEnrichmentQueries(db)).toBe(1);
    // Only the event lacking a value is looked up; the already-populated one
    // and the non-state event are excluded from the batch.
    expect(JSON.parse(db.selects.find((s) => s.sql.includes('AS replaces_state'))!.args[0] as string)).toEqual(
      [NEW]
    );
    expect(forwarded.unsigned).toEqual({ age: 12, transaction_id: 'tx', replaces_state: OLD });
    expect(alreadySet.unsigned).toEqual({ replaces_state: '$from-put' });
    expect(message.unsigned).toEqual({ age: 3 });
  });

  it('omits the field for the first event of a (type, state_key) slot', async () => {
    const db = createDb([oldTopicRow]);
    const event = {
      event_id: OLD,
      room_id: ROOM,
      state_key: '',
      type: 'm.room.topic',
    };
    await attachReplacesState(db as never, [event]);
    expect(countEnrichmentQueries(db)).toBe(1);
    expect(event.unsigned).toBeUndefined();
  });

  it('skips the query entirely when no state event needs enrichment', async () => {
    const db = createDb([oldTopicRow, newTopicRow]);
    await attachReplacesState(db as never, [
      { event_id: NEW, room_id: ROOM, state_key: '', unsigned: { replaces_state: OLD } },
      { event_id: MSG, room_id: ROOM },
    ]);
    expect(countEnrichmentQueries(db)).toBe(0);
  });

  it('picks the deepest predecessor, breaking depth ties by stream ordering', async () => {
    const first: DbEvent = { ...newTopicRow, event_id: '$p1', depth: 2, stream_ordering: 5 };
    const latest: DbEvent = { ...newTopicRow, event_id: '$p2', depth: 2, stream_ordering: 7 };
    const current: DbEvent = { ...newTopicRow, event_id: '$cur', depth: 3, stream_ordering: 8 };
    const db = createDb([first, latest, current]);
    const event = { event_id: '$cur', room_id: ROOM, state_key: '', type: 'm.room.topic' };

    await attachReplacesState(db as never, [event]);

    expect(event.unsigned).toEqual({ replaces_state: '$p2' });
  });
});

// ---------------------------------------------------------------------------
// Locally written state (PUT stores the value) and the client read surfaces
// ---------------------------------------------------------------------------

describe('locally PUT state', () => {
  it('the second PUT stores unsigned.replaces_state pointing at the first event', async () => {
    getStateEvent.mockImplementation(async (_db: unknown, _room: string, type: string, key = '') => {
      if (type === 'm.room.topic' && key === '') return toPdu(oldTopicRow);
      if (type === 'm.room.power_levels') {
        return toPdu(oldTopicRow, {
          event_id: '$pl',
          type: 'm.room.power_levels',
          content: { users: { [USER]: 100 }, state_default: 50 },
        });
      }
      if (type === 'm.room.create') {
        return toPdu(oldTopicRow, {
          event_id: '$create',
          type: 'm.room.create',
          content: { creator: USER },
        });
      }
      return null;
    });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    const { status } = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.topic/`,
      jsonInit('PUT', { topic: 'new' }),
      createDb([oldTopicRow])
    );
    expect(status).toBe(200);
    const stored = storeEvent.mock.calls.at(-1)![1] as PDU;
    expect(stored.unsigned).toEqual({ replaces_state: OLD });
  });
});

describe('rooms read surfaces', () => {
  it('GET /state forwards stored unsigned and fills it for federated-origin state', async () => {
    // First read: value written locally is forwarded verbatim (no lookup).
    getRoomState.mockResolvedValueOnce([
      toPdu(newTopicRow, { unsigned: { replaces_state: OLD } }),
    ]);
    const localDb = createDb([oldTopicRow, newTopicRow]);
    const local = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state`,
      {},
      localDb
    );
    expect(local.status).toBe(200);
    expect(local.body[0].unsigned).toEqual({ replaces_state: OLD });
    expect(countEnrichmentQueries(localDb)).toBe(0);

    // Second read: federated state has no stored unsigned, so it is computed.
    getRoomState.mockResolvedValueOnce([toPdu(newTopicRow)]);
    const federatedDb = createDb([oldTopicRow, newTopicRow]);
    const federated = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state`,
      {},
      federatedDb
    );
    expect(federated.status).toBe(200);
    expect(federated.body[0].unsigned).toEqual({ replaces_state: OLD });
    expect(countEnrichmentQueries(federatedDb)).toBe(1);
  });

  it('GET /messages and /event expose replaces_state on state events only', async () => {
    const db1 = createDb([oldTopicRow, newTopicRow, messageRow]);
    getRoomEvents.mockResolvedValue({
      events: [toPdu(messageRow), toPdu(newTopicRow)],
      end: 3,
    });
    const messages = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/messages?dir=b&limit=10`,
      {},
      db1
    );
    expect(messages.status).toBe(200);
    const stateEvent = messages.body.chunk.find((e: { event_id: string }) => e.event_id === NEW);
    const plainMessage = messages.body.chunk.find((e: { event_id: string }) => e.event_id === MSG);
    expect(stateEvent.unsigned).toEqual({ replaces_state: OLD });
    expect(plainMessage.unsigned).toBeUndefined();
    expect(countEnrichmentQueries(db1)).toBe(1);

    const db2 = createDb([oldTopicRow, newTopicRow]);
    getEvent.mockResolvedValue(toPdu(newTopicRow));
    const event = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/event/${encodeURIComponent(NEW)}`,
      {},
      db2
    );
    expect(event.status).toBe(200);
    expect(event.body.unsigned).toEqual({ replaces_state: OLD });
    expect(countEnrichmentQueries(db2)).toBe(1);
  });

  it('/context fills state + before/after, and filter applies only to before/after', async () => {
    getEvent.mockResolvedValue(toPdu(messageRow)); // target, not filtered
    getRoomState.mockResolvedValue([toPdu(newTopicRow)]);

    const before: DbEvent[] = [
      { ...newTopicRow, event_id: '$before-state', depth: 4, stream_ordering: 4, origin_server_ts: NOW + 1 },
      { ...messageRow, event_id: '$before-msg', depth: 5, stream_ordering: 5, origin_server_ts: NOW + 2 },
    ];
    const after: DbEvent[] = [
      { ...messageRow, event_id: '$after-msg', depth: 7, stream_ordering: 7, origin_server_ts: NOW + 20 },
      { ...newTopicRow, event_id: '$after-state', depth: 8, stream_ordering: 8, origin_server_ts: NOW + 21 },
    ];
    const rows = [oldTopicRow, newTopicRow, ...before, ...after];

    const noFilterDb = createDb(rows, { contextBefore: before, contextAfter: after });
    const noFilter = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${encodeURIComponent(MSG)}?limit=4`,
      {},
      noFilterDb
    );
    expect(noFilter.status).toBe(200);
    expect(noFilter.body.state[0].unsigned).toEqual({ replaces_state: OLD });
    expect(noFilter.body.events_before.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$before-msg',
      '$before-state',
    ]);
    // This before-side state event supersedes the topic event in the window.
    expect(noFilter.body.events_before.find((e: { event_id: string }) => e.event_id === '$before-state').unsigned)
      .toEqual({ replaces_state: NEW });
    expect(noFilter.body.events_after).toHaveLength(2);
    expect(countEnrichmentQueries(noFilterDb)).toBe(1);

    const filteredDb = createDb(rows, { contextBefore: before, contextAfter: after });
    const filtered = await roomsRequest(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${encodeURIComponent(MSG)}` +
        `?limit=4&filter=${encodeURIComponent(JSON.stringify({ types: ['m.room.message'] }))}`,
      {},
      filteredDb
    );
    expect(filtered.status).toBe(200);
    // State still carries the enrichment; only before/after are filtered.
    expect(filtered.body.state[0].unsigned).toEqual({ replaces_state: OLD });
    expect(filtered.body.events_before.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$before-msg',
    ]);
    expect(filtered.body.events_after.map((e: { event_id: string }) => e.event_id)).toEqual([
      '$after-msg',
    ]);
    expect(countEnrichmentQueries(filteredDb)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Sync surfaces
// ---------------------------------------------------------------------------

describe('/sync surfaces', () => {
  function joinOnly(rooms: string[]) {
    getUserRooms.mockImplementation(async (_db: unknown, _user: string, membership?: string) =>
      membership === 'join' ? rooms : []
    );
  }

  it('initial sync state carries replaces_state for a federated state event', async () => {
    joinOnly([ROOM]);
    getEventsSince.mockResolvedValue([toPdu(oldTopicRow), toPdu(newTopicRow)]);
    getRoomState.mockResolvedValue([toPdu(newTopicRow)]);
    const db = createDb([oldTopicRow, newTopicRow]);

    const { status, body } = await syncRequest('/_matrix/client/v3/sync', db);
    expect(status).toBe(200);
    const state = (body.rooms as { join: Record<string, { state: { events: Array<{ event_id: string; unsigned?: { replaces_state?: string } }> } }> })
      .join[ROOM].state.events;
    const newEvent = state.find((e) => e.event_id === NEW);
    expect(newEvent?.unsigned?.replaces_state).toBe(OLD);
    expect(state.find((e) => e.event_id === OLD)?.unsigned).toBeUndefined();
  });

  it('full_state on an incremental sync carries replaces_state', async () => {
    joinOnly([ROOM]);
    getEventsSince.mockResolvedValue([]);
    getRoomState.mockResolvedValue([toPdu(newTopicRow)]);
    const db = createDb([oldTopicRow, newTopicRow]);

    const { body } = await syncRequest(
      '/_matrix/client/v3/sync?since=s5_td0&full_state=true',
      db
    );
    const state = (body.rooms as { join: Record<string, { state: { events: Array<{ event_id: string; unsigned?: { replaces_state?: string } }> } }> })
      .join[ROOM].state.events;
    expect(state.find((e) => e.event_id === NEW)?.unsigned?.replaces_state).toBe(OLD);
  });

  it('state_after carries replaces_state', async () => {
    joinOnly([ROOM]);
    getEventsSince.mockResolvedValue([toPdu(messageRow)]);
    getRoomState.mockResolvedValue([toPdu(newTopicRow)]);
    const db = createDb([oldTopicRow, newTopicRow]);

    const { body } = await syncRequest(
      '/_matrix/client/v3/sync?org.matrix.msc4222.use_state_after=true',
      db
    );
    const after = (body.rooms as { join: Record<string, { timeline: { state_after?: { events: Array<{ event_id: string; unsigned?: { replaces_state?: string } }> } } }> })
      .join[ROOM].timeline.state_after!.events;
    expect(after.find((e) => e.event_id === NEW)?.unsigned?.replaces_state).toBe(OLD);
  });

  it('leave timeline carries replaces_state for the superseded membership', async () => {
    const joinRow: DbEvent = {
      ...newTopicRow,
      event_id: '$old-join',
      event_type: 'm.room.member',
      state_key: USER,
      content: JSON.stringify({ membership: 'join' }),
      depth: 1,
      stream_ordering: 1,
    };
    const leaveRow: DbEvent = {
      ...joinRow,
      event_id: '$leave',
      content: JSON.stringify({ membership: 'leave' }),
      depth: 2,
      stream_ordering: 2,
      origin_server_ts: NOW + 10,
    };
    getUserRooms.mockImplementation(async (_db: unknown, _user: string, membership?: string) =>
      membership === 'leave' ? [ROOM] : []
    );
    getEventsSince.mockResolvedValue([toPdu(leaveRow)]);
    const db = createDb([joinRow, leaveRow]);

    const { body } = await syncRequest('/_matrix/client/v3/sync?since=s5_td0', db);
    const leave = (body.rooms as { leave: Record<string, { timeline: { events: Array<{ event_id: string; unsigned?: { replaces_state?: string } }> } }> })
      .leave[ROOM].timeline.events;
    expect(leave[0].event_id).toBe('$leave');
    expect(leave[0].unsigned?.replaces_state).toBe('$old-join');
  });
});
