/**
 * MSC4354 sticky events + MSC4480 sliding-sync extension.
 *
 * Targeted coverage for the account-data-backed sticky store:
 *  - PUT/GET round-trip over both unstable endpoint prefixes
 *  - per-room isolation, expiry, membership checks and duration validation
 *  - delivery via /sync in the dedicated room section (never the timeline)
 *  - one-shot delivery as the account_data stream token advances
 *  - delivery via the MSC4480 sliding-sync extension
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const NOW = 1_760_000_000_000;
const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const ROOM2 = '!second:example.com';
const EMPTY_ROOM = '!empty:example.com';

const h = vi.hoisted(() => ({
  user: { value: '@alice:example.com' },
  getUserRooms: vi.fn(async (_db: unknown, userId: string, membership: string) =>
    membership === 'join' && userId === '@alice:example.com'
      ? ['!room:example.com', '!second:example.com']
      : []),
  getRoomState: vi.fn(async () => []),
  getEventsSince: vi.fn(async () => []),
  getLatestStreamPosition: vi.fn(async () => 7),
  getToDeviceMessages: vi.fn(async () => ({ events: [], nextBatch: '0' })),
  getReceiptsForRoom: vi.fn(async () => ({ type: 'm.receipt', content: {} })),
  getTypingUsers: vi.fn(async () => [] as string[]),
  countNotificationsWithRules: vi.fn(async () => ({ notification_count: 0, highlight_count: 0 })),
  notifyUserSync: vi.fn(async () => {}),
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', h.user.value);
    c.set('deviceId', 'DEVICEA');
    await next();
  },
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserRooms: (...args: unknown[]) => h.getUserRooms(...args),
    getRoomState: (...args: unknown[]) => h.getRoomState(...args),
    getEventsSince: (...args: unknown[]) => h.getEventsSince(...args),
    getLatestStreamPosition: (...args: unknown[]) => h.getLatestStreamPosition(...args),
    notifyUserSync: (...args: unknown[]) => h.notifyUserSync(...args),
  };
});

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return {
    ...actual,
    getToDeviceMessages: (...args: unknown[]) => h.getToDeviceMessages(...args),
  };
});

vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return {
    ...actual,
    getReceiptsForRoom: (...args: unknown[]) => h.getReceiptsForRoom(...args),
  };
});

vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return {
    ...actual,
    getTypingUsers: (...args: unknown[]) => h.getTypingUsers(...args),
  };
});

vi.mock('../src/services/push-rule-evaluator', () => ({
  countNotificationsWithRules: (...args: unknown[]) => h.countNotificationsWithRules(...args),
  evaluatePushRules: vi.fn(),
}));

import accountDataApp, {
  isStickyEventType,
  STICKY_EVENT_TYPE_PREFIX,
  toStickyClientEvent,
} from '../src/api/account-data';
import syncApp from '../src/api/sync';
import slidingSyncApp from '../src/api/sliding-sync';

type AccountDataRow = { user_id: string; room_id: string; event_type: string; content: string };
type ChangeRow = { user_id: string; room_id: string; event_type: string; stream_position: number };
type Membership = { room_id: string; user_id: string; membership: string };

const MSC4354 = '/_matrix/client/unstable/org.matrix.msc4354';
const MSC4480 = '/_matrix/client/unstable/org.matrix.msc4480';
const V4 = '/_matrix/client/v4/sync';

function createDb() {
  const accountData: AccountDataRow[] = [];
  const changes: ChangeRow[] = [];
  const positions = new Map<string, number>([
    ['events', 7], ['device_keys', 0], ['account_data', 0], ['presence', 0],
  ]);
  const memberships: Membership[] = [
    { room_id: ROOM, user_id: ALICE, membership: 'join' },
    { room_id: ROOM2, user_id: ALICE, membership: 'join' },
    { room_id: EMPTY_ROOM, user_id: ALICE, membership: 'join' },
  ];
  const events = new Map<string, number>();

  const executor = (sql: string, args: unknown[]) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    const run = async () => ({ success: true });
    const first = async <T>(): Promise<T | null> => {
      if (q.includes('SELECT position FROM stream_positions')) {
        return { position: positions.get(String(args[0])) ?? 0 } as T;
      }
      if (q.includes('SELECT membership FROM room_memberships')) {
        const hit = memberships.find(m => m.room_id === args[0] && m.user_id === args[1]);
        return hit ? { membership: hit.membership } as T : null;
      }
      if (q.includes('SELECT content FROM account_data')) {
        const hit = accountData.find(d => d.user_id === args[0] && d.room_id === args[1] && d.event_type === args[2]);
        return hit ? { content: hit.content } as T : null;
      }
      if (q.includes('SELECT stream_ordering FROM events WHERE event_id = ?')) {
        const pos = events.get(String(args[0]));
        return pos === undefined ? null : { stream_ordering: pos } as T;
      }
      if (q.includes('SELECT MAX(stream_ordering)')) return { max_pos: 7 } as T;
      return null;
    };
    const all = async <T>(): Promise<{ results: T[] }> => {
      if (q.includes('event_type LIKE ?')) {
        const isIncremental = q.includes('HAVING MAX(adc.stream_position)');
        const roomIds = args.filter(a => typeof a === 'string' && String(a).startsWith('!')) as string[];
        const since = isIncremental ? Number(args[args.length - 1]) : -1;
        const rows = accountData
          .filter(d => roomIds.includes(d.room_id) && d.event_type.startsWith(STICKY_EVENT_TYPE_PREFIX))
          .filter(d => {
            if (!isIncremental) return true;
            const change = changes.find(c =>
              c.user_id === d.user_id && c.room_id === d.room_id && c.event_type === d.event_type);
            return !!change && change.stream_position > since;
          })
          .map(d => ({ ...d, stream_position: changes.find(c => c.event_type === d.event_type)?.stream_position ?? 0 }));
        return { results: rows as unknown as T[] };
      }
      if (q.includes('FROM account_data ad INNER JOIN account_data_changes adc')) {
        const [userId, since] = args as [string, number];
        const rows = changes
          .filter(c => c.user_id === userId && c.stream_position > since && !isStickyEventType(c.event_type))
          .map(c => accountData.find(d =>
            d.user_id === c.user_id && d.room_id === c.room_id && d.event_type === c.event_type))
          .filter((d): d is AccountDataRow => !!d)
          .map(d => ({ event_type: d.event_type, content: d.content }));
        return { results: rows as unknown as T[] };
      }
      if (q.includes('FROM account_data WHERE user_id = ? AND room_id = ?')) {
        const rows = accountData
          .filter(d => d.user_id === args[0] && d.room_id === args[1] && !isStickyEventType(d.event_type))
          .map(d => ({ event_type: d.event_type, content: d.content }));
        return { results: rows as unknown as T[] };
      }
      if (q.includes('FROM account_data WHERE user_id = ?')) {
        const rows = accountData
          .filter(d => d.user_id === args[0] && d.room_id === '' && !isStickyEventType(d.event_type))
          .map(d => ({ event_type: d.event_type, content: d.content }));
        return { results: rows as unknown as T[] };
      }
      if (q.includes('SELECT room_id FROM room_memberships')) {
        const wanted = memberships
          .filter(m => m.user_id === args[0] && m.membership === 'join')
          .map(m => ({ room_id: m.room_id }));
        return { results: wanted as unknown as T[] };
      }
      if (q.includes('SELECT user_id, presence')) return { results: [] };
      if (q.includes('FROM device_key_changes')) return { results: [] };
      if (q.includes('FROM one_time_keys') || q.includes('FROM fallback_keys')) return { results: [] };
      if (q.includes('FROM events')) return { results: [] };
      return { results: [] };
    };

    return {
      bind: (...bound: unknown[]) => executor(sql, bound),
      all,
      first,
      run,
    };
  };

  const db = {
    accountData,
    changes,
    positions,
    events,
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        const noResult = {
          run: async () => ({ success: true }),
          all: async () => ({ results: [] as unknown[] }),
          first: async () => null,
        };
        if (q.includes('INSERT INTO account_data (user_id, room_id, event_type, content)')) {
          const [userId, roomId, eventType, content] = args as string[];
          const idx = accountData.findIndex(d =>
            d.user_id === userId && d.room_id === roomId && d.event_type === eventType);
          const row = { user_id: userId, room_id: roomId, event_type: eventType, content };
          if (idx >= 0) accountData[idx] = row; else accountData.push(row);
          return noResult;
        }
        if (q.includes('INSERT INTO account_data_changes')) {
          const [userId, roomId, eventType, streamPosition] = args as [string, string, string, number];
          changes.push({ user_id: userId, room_id: roomId, event_type: eventType, stream_position: streamPosition });
          return noResult;
        }
        if (q.includes('UPDATE stream_positions')) {
          const name = String(args[0]);
          positions.set(name, (positions.get(name) ?? 0) + 1);
          return noResult;
        }
        return executor(sql, args);
      },
      all: async <T>() => executor(sql, []).all<T>(),
      first: async <T>() => executor(sql, []).first<T>(),
      run: async () => executor(sql, []).run(),
    }),
  };

  return db as unknown as D1Database & {
    accountData: AccountDataRow[];
    changes: ChangeRow[];
    events: Map<string, number>;
  };
}

function createEnv(db: D1Database) {
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  };
  const doStub = {
    fetch: async (input: Request | URL | string, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.pathname === '/sliding-sync/state' && method === 'GET') {
        return Response.json(null);
      }
      if (url.pathname === '/wait-for-events') return Response.json({ hasEvents: false });
      return Response.json({ success: true });
    },
  };
  return {
    DB: db,
    CACHE: kv,
    SYNC: { idFromName: () => 'id', get: () => doStub },
    USER_KEYS: { idFromName: () => 'id', get: () => doStub },
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(app: { request: typeof accountDataApp.request }, env: Env, path: string, init: RequestInit = {}) {
  const res = await app.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

function jsonPut(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function putSticky(
  env: Env,
  room: string,
  txn: string,
  opts: { prefix?: string; duration?: string; eventType?: string; body?: unknown } = {}
) {
  const prefix = opts.prefix ?? MSC4354;
  const duration = opts.duration ?? '300000';
  const eventType = opts.eventType ?? 'm.room.message';
  const path = `${prefix}/rooms/${encodeURIComponent(room)}/sticky/${encodeURIComponent(eventType)}/${txn}?org.matrix.msc4354.sticky_duration_ms=${duration}`;
  return request(accountDataApp, env, path, jsonPut(opts.body ?? { msgtype: 'm.text', body: `sticky ${txn}` }));
}

describe('MSC4354 sticky events stored in account_data', () => {
  let db: ReturnType<typeof createDb>;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h.user.value = ALICE;
    h.getUserRooms.mockClear();
    h.getEventsSince.mockClear();
    db = createDb();
    env = createEnv(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('PUT then GET round-trips a sticky event with the remaining duration', async () => {
    const put = await putSticky(env, ROOM, 'txn1');
    expect(put.status).toBe(200);
    expect(put.body).toEqual({});

    expect(db.accountData).toHaveLength(1);
    expect(db.accountData[0].event_type).toContain(STICKY_EVENT_TYPE_PREFIX);

    const get = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(ROOM)}/sticky`);
    expect(get.status).toBe(200);
    const events = (get.body as { events: any[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'm.room.message',
      sender: ALICE,
      room_id: ROOM,
      content: { body: 'sticky txn1' },
      sticky: { duration_ms: 300000 },
      msc4354_sticky: { duration_ms: 300000 },
      unsigned: {
        sticky_duration_remaining_ms: 300000,
        msc4354_sticky_duration_ttl_ms: 300000,
      },
    });
  });

  it('accepts the MSC4480 unstable prefix as an endpoint alias', async () => {
    expect((await putSticky(env, ROOM, 'txn2', { prefix: MSC4480, duration: '60000' })).status).toBe(200);
    const get = await request(accountDataApp, env, `${MSC4480}/rooms/${encodeURIComponent(ROOM)}/sticky`);
    expect((get.body as { events: any[] }).events).toHaveLength(1);
    expect((get.body as { events: any[] }).events[0].unsigned.sticky_duration_remaining_ms).toBe(60000);
  });

  it('rejects a missing or non-positive sticky_duration_ms', async () => {
    for (const duration of ['0', '-1', 'abc', '']) {
      const res = await putSticky(env, ROOM, `bad${duration}`, { duration });
      expect(res.status).toBe(400);
      expect((res.body as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
    }
  });

  it('isolates sticky events by room', async () => {
    await putSticky(env, ROOM, 'a');
    await putSticky(env, ROOM2, 'b');

    const first = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(ROOM)}/sticky`);
    const second = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(ROOM2)}/sticky`);
    const empty = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(EMPTY_ROOM)}/sticky`);

    const firstEvents = (first.body as { events: any[] }).events;
    const secondEvents = (second.body as { events: any[] }).events;
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    expect(firstEvents[0].room_id).toBe(ROOM);
    expect(secondEvents[0].room_id).toBe(ROOM2);
    expect(firstEvents[0].event_id).not.toBe(secondEvents[0].event_id);
    expect((empty.body as { events: any[] }).events).toHaveLength(0);
  });

  it('omits expired events from GET', async () => {
    await putSticky(env, ROOM, 'short', { duration: '1000' });
    vi.setSystemTime(NOW + 1001);
    const get = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(ROOM)}/sticky`);
    expect((get.body as { events: any[] }).events).toHaveLength(0);
  });

  it('clamps sticky duration to one hour and uses min(received_ts, origin_server_ts)', () => {
    const record = {
      event_id: '$clamp', type: 'm.room.message', sender: ALICE, room_id: ROOM,
      origin_server_ts: NOW - 10_000, received_ts: NOW, duration_ms: 7_200_000,
      content: {},
    };
    const event = toStickyClientEvent(record, NOW);
    expect(event?.unsigned.sticky_duration_remaining_ms).toBe(3_600_000 - 10_000);
  });

  it('requires room membership for reads and writes', async () => {
    h.user.value = BOB;
    const get = await request(accountDataApp, env, `${MSC4354}/rooms/${encodeURIComponent(ROOM)}/sticky`);
    expect(get.status).toBe(403);
    const put = await putSticky(env, ROOM, 'bobtxn');
    expect(put.status).toBe(403);
  });
});

describe('sticky events in sync responses', () => {
  let db: ReturnType<typeof createDb>;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h.user.value = ALICE;
    h.getUserRooms.mockClear();
    h.getEventsSince.mockClear();
    h.getEventsSince.mockResolvedValue([{
      type: 'm.room.message',
      event_id: '$normal',
      sender: BOB,
      room_id: ROOM,
      content: { body: 'normal message' },
      origin_server_ts: NOW,
      stream_ordering: 5,
    }]);
    db = createDb();
    db.events.set('$normal', 5);
    env = createEnv(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('/sync delivers sticky events in the sticky section, never the timeline', async () => {
    await putSticky(env, ROOM, 'sync1');
    const res = await request(syncApp, env, '/_matrix/client/v3/sync');
    expect(res.status).toBe(200);
    const body = res.body as any;
    const room = body.rooms.join[ROOM];

    expect(room.sticky.events).toHaveLength(1);
    expect(room.sticky.events[0].content.body).toBe('sticky sync1');
    expect(room.msc4354_sticky.events[0].event_id).toBe(room.sticky.events[0].event_id);
    expect(room.timeline.events.map((e: any) => e.event_id)).toEqual(['$normal']);
    expect(room.account_data.events).toHaveLength(0);
    expect(body.account_data.events).toHaveLength(0);
  });

  it('/sync does not put sticky types into room account_data', async () => {
    await putSticky(env, ROOM, 'adcheck');
    const res = await request(syncApp, env, '/_matrix/client/v3/sync');
    const room = (res.body as any).rooms.join[ROOM];
    expect(room.account_data.events.some((e: any) => e.type.includes(STICKY_EVENT_TYPE_PREFIX))).toBe(false);
  });

  it('advancing the sync token consumes the sticky event once', async () => {
    await putSticky(env, ROOM, 'once');
    const first = await request(syncApp, env, '/_matrix/client/v3/sync');
    const token = (first.body as any).next_batch as string;
    expect((first.body as any).rooms.join[ROOM].sticky.events).toHaveLength(1);

    h.getEventsSince.mockResolvedValue([]);
    const second = await request(syncApp, env, `/_matrix/client/v3/sync?since=${encodeURIComponent(token)}`);
    expect((second.body as any).rooms.join[ROOM].sticky).toBeUndefined();
  });

  it('sliding-sync MSC4480 extension returns sticky events for in-scope rooms only', async () => {
    await putSticky(env, ROOM, 'ss1');
    await putSticky(env, ROOM2, 'ss2');

    const res = await request(slidingSyncApp, env, V4, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extensions: {
          sticky_events: { enabled: true, rooms: [ROOM], limit: 10 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = res.body as any;
    const events = body.extensions.sticky_events.rooms[ROOM].events;
    expect(events).toHaveLength(1);
    expect(events[0].content.body).toBe('sticky ss1');
    expect(body.extensions['org.matrix.msc4354.sticky_events'].rooms[ROOM].events).toHaveLength(1);
    expect(body.extensions.sticky_events.rooms[ROOM2]).toBeUndefined();
    expect(body.rooms[ROOM]?.timeline ?? []).toEqual([]);
  });
});
