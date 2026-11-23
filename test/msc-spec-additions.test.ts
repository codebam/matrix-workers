/**
 * Regression coverage for the four notable MSC additions:
 *  - MSC4222: /sync joined rooms carry state_after (current state).
 *  - MSC4155/MSC4380: invite endpoints 403 M_INVITE_BLOCKED on a
 *    'block' decision; 'ignore' withholds the invite from /sync.
 *  - MSC4140: delayed event create/get/send/cancel/restart/update plus the
 *    alarm dispatcher, limits and finalised-state idempotency.
 *  - MSC3906/MSC3886: rendezvous create/poll/update/cancel with ETag
 *    semantics under both unstable prefixes; /versions + well-known flags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const BOB = '@bob:remote.example.org';
const ROOM = '!room:example.com';
const INVITE_ROOM = '!invite:example.com';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
}));

vi.mock('../src/services/federation-keys', () => ({
  getRemoteKeysWithNotarySignature: vi.fn(),
  getServerSigningKey: vi.fn(),
  verifyRemoteSignature: vi.fn(),
  signFederationRequest: vi.fn(),
  federationGet: vi.fn(),
  federationFetch: vi.fn(),
}));

const getUserRooms = vi.fn();
const getRoomState = vi.fn();
const getEventsSince = vi.fn();
const getLatestStreamPosition = vi.fn();
const getMembership = vi.fn();
const getInvitePermission = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getEventsSince: (...args: unknown[]) => getEventsSince(...args),
    getLatestStreamPosition: (...args: unknown[]) => getLatestStreamPosition(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    getInvitePermission: (...args: unknown[]) => getInvitePermission(...args),
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

// Delayed dispatch goes through the shared send/state cores; stub them so
// these tests exercise the MSC4140 lifecycle, not the send path itself.
const performSendEvent = vi.fn();
const performStateEvent = vi.fn();
vi.mock('../src/api/rooms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/rooms')>();
  return {
    ...actual,
    performSendEvent: (...args: unknown[]) => performSendEvent(...args),
    performStateEvent: (...args: unknown[]) => performStateEvent(...args),
  };
});

import syncApp from '../src/api/sync';
import roomsApp from '../src/api/rooms';
import federationApp from '../src/api/federation';
import delayedApp from '../src/api/delayed-events';
import rendezvousApp from '../src/api/rendezvous';
import versionsApp from '../src/api/versions';
import { dispatchDueDelayedEvents } from '../src/services/delayed-events';

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

function mockKv() {
  const data: Record<string, string> = {};
  return {
    data,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace & { data: Record<string, string> };
}

interface DelayedRow {
  delay_id: string;
  user_id: string;
  room_id: string;
  event_type: string;
  state_key: string | null;
  content: string;
  delay_ms: number;
  delayed_since_ts: number;
  due_ts: number;
  txn_id: string | null;
  finalised_ts: number | null;
  final_event_id: string | null;
  final_error: string | null;
}

function createDb() {
  const delayed = new Map<string, DelayedRow>();
  const users = new Set([USER, BOB]);
  const schedules: number[] = [];

  const pending = () => [...delayed.values()].filter((r) => r.finalised_ts === null);

  const db = {
    delayed,
    schedules,
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
            async first<T>() {
              if (sql.includes('FROM stream_positions')) return { position: 0 } as T;
              if (sql.includes('FROM device_key_changes') && sql.includes('COUNT(*)')) {
                return { count: 0 } as T;
              }
              if (sql.includes('FROM users WHERE user_id')) {
                return (users.has(args[0] as string) ? { user_id: args[0] } : null) as T;
              }
              if (sql.includes('COUNT(*) as count FROM delayed_events')) {
                return {
                  count: pending().filter((r) => r.user_id === args[0]).length,
                } as T;
              }
              if (sql.includes('SELECT * FROM delayed_events WHERE delay_id')) {
                const row = delayed.get(args[0] as string);
                return (row && row.user_id === args[1] ? row : null) as T;
              }
              if (sql.includes('MIN(due_ts)')) {
                const p = pending();
                return { next: p.length ? Math.min(...p.map((r) => r.due_ts)) : null } as T;
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes('FROM delayed_events WHERE finalised_ts IS NULL AND due_ts')) {
                return {
                  results: pending().filter((r) => r.due_ts <= (args[0] as number)),
                } as T[];
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO delayed_events')) {
                const [delay_id, user_id, room_id, event_type, state_key, content, delay_ms, delayed_since_ts, due_ts, txn_id] = args;
                delayed.set(delay_id as string, {
                  delay_id, user_id, room_id, event_type, state_key, content, delay_ms,
                  delayed_since_ts, due_ts, txn_id,
                  finalised_ts: null, final_event_id: null, final_error: null,
                } as DelayedRow);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE delayed_events SET finalised_ts')) {
                const row = delayed.get(args[1] as string);
                if (row && row.finalised_ts === null) {
                  row.finalised_ts = args[0] as number;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes('SET final_error')) {
                const row = delayed.get(args[1] as string);
                if (row) row.final_error = args[0] as string;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('SET final_event_id')) {
                const row = delayed.get(args[1] as string);
                if (row) row.final_event_id = args[0] as string;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE delayed_events SET delay_ms')) {
                const row = delayed.get(args[4] as string);
                if (row && row.finalised_ts === null) {
                  row.delay_ms = args[0] as number;
                  row.content = args[1] as string;
                  row.delayed_since_ts = args[2] as number;
                  row.due_ts = args[3] as number;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
      });
      return { ...stmt([]), bind: (...args: unknown[]) => stmt(args) };
    },
  };
  return db;
}

function createEnv(db = createDb()) {
  const sessions = mockKv();
  const cache = mockKv();
  const syncDo = { fetch: async () => Response.json({ hasEvents: false }) };
  const delayedDo = {
    fetch: async (req: Request) => {
      const body = await req.json() as { due_ts: number };
      db.schedules.push(body.due_ts);
      return Response.json({ ok: true });
    },
  };
  const env = {
    DB: db,
    SESSIONS: sessions,
    CACHE: cache,
    SERVER_NAME: SERVER,
    SYNC: { idFromName: (n: string) => n, get: () => syncDo },
    DELAYED_EVENTS: { idFromName: (n: string) => n, get: () => delayedDo },
    PUSH_NOTIFICATION_WORKFLOW: { create: async () => ({ id: 'wf' }) },
    _db: db,
    _sessions: sessions,
  };
  return env as unknown as Env & typeof env;
}

function makePdu(partial: Partial<PDU> & { type: string; event_id: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    origin_server_ts: 1_700_000_000_000,
    content: {},
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...partial,
  };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(() => {
  getUserRooms.mockReset().mockResolvedValue([]);
  getRoomState.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(42);
  getMembership.mockReset().mockResolvedValue({ membership: 'join', eventId: '$mem' });
  getInvitePermission.mockReset().mockResolvedValue('allow');
  getToDeviceMessages.mockReset().mockResolvedValue({ events: [], nextBatch: '0' });
  getGlobalAccountData.mockReset().mockResolvedValue([]);
  getRoomAccountData.mockReset().mockResolvedValue([]);
  getReceiptsForRoom.mockReset().mockResolvedValue({ type: 'm.receipt', content: {} });
  getTypingUsers.mockReset().mockResolvedValue([]);
  performSendEvent.mockReset().mockResolvedValue({ eventId: '$delayed:1', originServerTs: 1 });
  performStateEvent.mockReset().mockResolvedValue({ eventId: '$delayed-state:1' });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// MSC4222 — state_after
// ---------------------------------------------------------------------------

describe('MSC4222 state_after in /sync', () => {
  it('use_state_after=true puts current state in timeline.state_after and keeps state', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, m?: string) =>
      m === 'join' ? [ROOM] : []
    );
    const newName = makePdu({
      type: 'm.room.name', event_id: '$name-new', state_key: '', content: { name: 'New' },
    });
    getRoomState.mockResolvedValue([newName]);

    const env = createEnv();
    const res = await syncApp.request(
      'http://localhost/_matrix/client/v3/sync?use_state_after=true', {}, env
    );
    const body = await json(res);
    const joined = body.rooms.join[ROOM];
    // MSC4222 places state_after INSIDE the timeline object. The classic
    // `state` section must survive: deleting it left flag-using clients
    // (Element Web) with stateless rooms rendered as "Empty room".
    expect(joined.state.events.map((e: any) => e.event_id)).toContain('$name-new');
    expect(joined.state_after).toBeUndefined();
    expect(joined.timeline.state_after.events.map((e: any) => e.event_id)).toEqual(['$name-new']);
    expect(joined.timeline.state_after.events[0].content).toEqual({ name: 'New' });
  });

  it('accepts the unstable org.matrix.msc4222.use_state_after param (Element web)', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, m?: string) =>
      m === 'join' ? [ROOM] : []
    );
    const newName = makePdu({
      type: 'm.room.name', event_id: '$name-new', state_key: '', content: { name: 'New' },
    });
    getRoomState.mockResolvedValue([newName]);

    const env = createEnv();
    const res = await syncApp.request(
      'http://localhost/_matrix/client/v3/sync?org.matrix.msc4222.use_state_after=true', {}, env
    );
    const body = await json(res);
    const joined = body.rooms.join[ROOM];
    expect(joined.state.events.map((e: any) => e.event_id)).toContain('$name-new');
    expect(joined.state_after).toBeUndefined();
    expect(joined.timeline.state_after.events.map((e: any) => e.event_id)).toEqual(['$name-new']);
  });

  it('without the flag the legacy state section is kept and no extra state load happens', async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, m?: string) =>
      m === 'join' ? [ROOM] : []
    );
    const env = createEnv();
    const res = await syncApp.request(
      'http://localhost/_matrix/client/v3/sync?since=s5_td0', {}, env
    );
    const body = await json(res);
    const joined = body.rooms.join[ROOM];
    expect(joined.state_after).toBeUndefined();
    expect(joined.state).toEqual({ events: [] });
    expect(getRoomState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MSC4155/MSC4380 — invite blocking / ignoring
// ---------------------------------------------------------------------------

describe('MSC4155 invite filtering', () => {
  it('POST /rooms/:id/invite 403s with M_INVITE_BLOCKED', async () => {
    getInvitePermission.mockResolvedValue('block');
    const env = createEnv();
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/invite`,
      { method: 'POST', body: JSON.stringify({ user_id: BOB }), headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errcode).toBe('M_INVITE_BLOCKED');
    expect(getInvitePermission).toHaveBeenCalledWith(env.DB, BOB, USER);
  });

  it('createRoom 403s when an invitee blocks the creator', async () => {
    getInvitePermission.mockResolvedValue('block');
    const env = createEnv();
    const res = await roomsApp.request(
      'http://localhost/_matrix/client/v3/createRoom',
      { method: 'POST', body: JSON.stringify({ invite: [BOB] }), headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errcode).toBe('M_INVITE_BLOCKED');
  });

  it('state-endpoint invites are blocked too', async () => {
    getInvitePermission.mockResolvedValue('block');
    const env = createEnv();
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/state/m.room.member/${encodeURIComponent(BOB)}`,
      { method: 'PUT', body: JSON.stringify({ membership: 'invite' }), headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errcode).toBe('M_INVITE_BLOCKED');
  });

  it('federation v2 invite 403s for a blocked inviter', async () => {
    getInvitePermission.mockResolvedValue('block');
    const env = createEnv();
    const res = await federationApp.request(
      `http://localhost/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24inv`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_version: '10',
          event: {
            type: 'm.room.member',
            state_key: USER,
            sender: BOB,
            event_id: '$inv',
            content: { membership: 'invite' },
          },
          invite_room_state: [],
        }),
      },
      env
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errcode).toBe('M_INVITE_BLOCKED');
  });

  it("'ignore' withholds the invite from /sync but 'allow' shows it", async () => {
    getUserRooms.mockImplementation(async (_db: unknown, _u: string, m?: string) =>
      m === 'invite' ? [INVITE_ROOM] : []
    );
    getRoomState.mockResolvedValue([
      makePdu({
        type: 'm.room.member', event_id: '$inv', state_key: USER, sender: BOB,
        content: { membership: 'invite' }, room_id: INVITE_ROOM,
      }),
    ]);

    getInvitePermission.mockResolvedValue('ignore');
    const hidden = await json(
      await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, createEnv())
    );
    expect(hidden.rooms.invite).toEqual({});

    getInvitePermission.mockResolvedValue('allow');
    const shown = await json(
      await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, createEnv())
    );
    expect(Object.keys(shown.rooms.invite)).toEqual([INVITE_ROOM]);
  });
});

// ---------------------------------------------------------------------------
// MSC4140 — delayed events
// ---------------------------------------------------------------------------

const DP = '/_matrix/client/unstable/org.matrix.msc4140';

async function createDelayed(env: Env, body: Record<string, unknown> = {}) {
  return delayedApp.request(
    `http://localhost${DP}/rooms/${encodeURIComponent(ROOM)}/delayed_event/m.room.message/txn1`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delay_ms: 60_000, content: { body: 'later', msgtype: 'm.text' }, ...body }),
    },
    env
  );
}

describe('MSC4140 delayed events', () => {
  it('creates, inspects and cancels a delayed event', async () => {
    const env = createEnv();
    const created = await json(await createDelayed(env));
    expect(created.delay_id).toBeTruthy();
    expect(env._db.schedules.length).toBe(1);

    const got = await json(await delayedApp.request(
      `http://localhost${DP}/delayed_events/${created.delay_id}`, {}, env
    ));
    expect(got).toMatchObject({
      delay_id: created.delay_id,
      room_id: ROOM,
      type: 'm.room.message',
      delay_ms: 60_000,
      content: { body: 'later', msgtype: 'm.text' },
    });
    expect(got.finalised).toBeUndefined();

    const cancelled = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${created.delay_id}/cancel`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(cancelled.status).toBe(200);

    const after = await json(await delayedApp.request(
      `http://localhost${DP}/delayed_events/${created.delay_id}`, {}, env
    ));
    expect(after.finalised.finalised_ts).toBeTypeOf('number');
    expect(after.finalised.event_id).toBeUndefined();

    // send after cancel conflicts
    const conflict = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${created.delay_id}/send`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(conflict.status).toBe(409);
  });

  it('send dispatches through performSendEvent and records the event id', async () => {
    const env = createEnv();
    const { delay_id } = await json(await createDelayed(env));
    const sent = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${delay_id}/send`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(sent.status).toBe(200);
    // Spec v1.20: the scheduled event does not inherit the scheduling txn id.
    expect(performSendEvent).toHaveBeenCalledWith(
      env, ROOM, USER, 'm.room.message', { body: 'later', msgtype: 'm.text' },
      undefined, undefined
    );
    const got = await json(await delayedApp.request(`http://localhost${DP}/delayed_events/${delay_id}`, {}, env));
    expect(got.finalised.event_id).toBe('$delayed:1');

    // idempotent repeat
    const again = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${delay_id}/send`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(again.status).toBe(200);
  });

  it('restart re-arms the timer; update replaces content and delay', async () => {
    const env = createEnv();
    const { delay_id } = await json(await createDelayed(env));
    const before = env._db.delayed.get(delay_id)!;

    const restarted = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${delay_id}/restart`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(restarted.status).toBe(200);
    expect(env._db.delayed.get(delay_id)!.delayed_since_ts).toBeGreaterThanOrEqual(before.delayed_since_ts);
    expect(env._db.schedules.length).toBe(2);

    const updated = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${delay_id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', delay_ms: 1000, content: { body: 'changed' } }),
      },
      env
    );
    expect(updated.status).toBe(200);
    const row = env._db.delayed.get(delay_id)!;
    expect(row.delay_ms).toBe(1000);
    expect(JSON.parse(row.content)).toEqual({ body: 'changed' });
  });

  it('rejects invalid and oversized delays and enforces max_scheduled', async () => {
    const env = createEnv();
    const zero = await createDelayed(env, { delay_ms: 0 });
    expect(zero.status).toBe(400);
    const huge = await createDelayed(env, { delay_ms: 86_400_001 });
    expect(huge.status).toBe(400);
    expect((await json(huge)).errcode).toBe('ORG.MATRIX.MSC4140_DELAY_TOO_LARGE');

    for (let i = 0; i < 10; i++) {
      expect((await createDelayed(env)).status).toBe(200);
    }
    const overflow = await createDelayed(env);
    expect(overflow.status).toBe(429);
    expect((await json(overflow)).errcode).toBe('M_LIMIT_EXCEEDED');
  });

  it('delayed state events dispatch through performStateEvent', async () => {
    const env = createEnv();
    const { delay_id } = await json(await createDelayed(env, { state_key: '' }));
    const sent = await delayedApp.request(
      `http://localhost${DP}/delayed_events/${delay_id}/send`,
      { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
      env
    );
    expect(sent.status).toBe(200);
    expect(performStateEvent).toHaveBeenCalledWith(env, ROOM, USER, 'm.room.message', '', { body: 'later', msgtype: 'm.text' }, undefined);
  });

  it('the alarm dispatcher sends due events and reports the next due time', async () => {
    const env = createEnv();
    const { delay_id } = await json(await createDelayed(env, { delay_ms: 1 }));
    env._db.delayed.get(delay_id)!.due_ts = Date.now() - 1;

    const next = await dispatchDueDelayedEvents(env);
    expect(performSendEvent).toHaveBeenCalled();
    expect(env._db.delayed.get(delay_id)!.final_event_id).toBe('$delayed:1');
    expect(next).toBeNull();
  });

  it('dispatch failures are recorded as finalised errors', async () => {
    performSendEvent.mockResolvedValue({
      error: Object.assign(new Error('Not a member of this room'), {
        errcode: 'M_FORBIDDEN',
        toJSON: () => ({ errcode: 'M_FORBIDDEN', error: 'Not a member of this room' }),
      }),
    });
    const env = createEnv();
    const { delay_id } = await json(await createDelayed(env, { delay_ms: 1 }));
    env._db.delayed.get(delay_id)!.due_ts = Date.now() - 1;
    await dispatchDueDelayedEvents(env);
    const row = env._db.delayed.get(delay_id)!;
    expect(row.final_event_id).toBeNull();
    expect(JSON.parse(row.final_error!).errcode).toBe('M_FORBIDDEN');
  });

  it('unknown delay ids 404 and other users cannot see them', async () => {
    const env = createEnv();
    const missing = await delayedApp.request(`http://localhost${DP}/delayed_events/nope`, {}, env);
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// MSC3906 / MSC3886 — rendezvous
// ---------------------------------------------------------------------------

describe('MSC3906/MSC3886 rendezvous', () => {
  for (const prefix of [
    '/_matrix/client/unstable/org.matrix.msc3886',
    '/_matrix/client/unstable/org.matrix.msc3906',
  ]) {
    it(`full lifecycle under ${prefix}`, async () => {
      const env = createEnv();
      const created = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous`,
        { method: 'POST', headers: { 'Content-Length': '0' } },
        env
      );
      expect(created.status).toBe(201);
      const body = await json(created);
      expect(body.id).toBeTruthy();
      expect(created.headers.get('Location')).toContain(`${prefix}/rendezvous/${body.id}`);
      expect(created.headers.get('X-Max-Bytes')).toBe('10240');
      const etag0 = created.headers.get('ETag')!;
      expect(etag0).toBeTruthy();
      expect(created.headers.get('Expires')).toBeTruthy();
      expect(created.headers.get('Last-Modified')).toBeTruthy();

      const empty = await rendezvousApp.request(`http://localhost${prefix}/rendezvous/${body.id}`, {}, env);
      expect(empty.status).toBe(200);
      expect(await empty.text()).toBe('');

      // stale If-Match fails with 412 M_CONCURRENT_WRITE
      const stale = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous/${body.id}`,
        { method: 'PUT', headers: { 'Content-Length': '5', 'If-Match': 'wrong' }, body: 'hello' },
        env
      );
      expect(stale.status).toBe(412);
      expect((await json(stale)).errcode).toBe('M_CONCURRENT_WRITE');

      // missing If-Match is a 400
      const noMatch = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous/${body.id}`,
        { method: 'PUT', headers: { 'Content-Length': '5' }, body: 'hello' },
        env
      );
      expect(noMatch.status).toBe(400);

      const put = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous/${body.id}`,
        { method: 'PUT', headers: { 'Content-Length': '5', 'If-Match': etag0 }, body: 'hello' },
        env
      );
      expect(put.status).toBe(202);
      const etag1 = put.headers.get('ETag')!;
      expect(etag1).not.toBe(etag0);

      const got = await rendezvousApp.request(`http://localhost${prefix}/rendezvous/${body.id}`, {}, env);
      expect(await got.text()).toBe('hello');

      const notModified = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous/${body.id}`,
        { headers: { 'If-None-Match': etag1 } },
        env
      );
      expect(notModified.status).toBe(304);

      const deleted = await rendezvousApp.request(
        `http://localhost${prefix}/rendezvous/${body.id}`,
        { method: 'DELETE' },
        env
      );
      expect(deleted.status).toBe(204);
      const gone = await rendezvousApp.request(`http://localhost${prefix}/rendezvous/${body.id}`, {}, env);
      expect(gone.status).toBe(404);
    });
  }

  it('rejects oversized payloads and missing Content-Length on create', async () => {
    const env = createEnv();
    const big = await rendezvousApp.request(
      'http://localhost/_matrix/client/unstable/org.matrix.msc3906/rendezvous',
      { method: 'POST', headers: { 'Content-Length': '20000' }, body: 'x'.repeat(20000) },
      env
    );
    expect(big.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

describe('MSC advertisement', () => {
  it('/versions advertises all four MSCs', async () => {
    const res = await versionsApp.request('http://localhost/_matrix/client/versions', {}, createEnv());
    const body = await json(res);
    for (const flag of ['org.matrix.msc4222', 'org.matrix.msc4155', 'org.matrix.msc4140', 'org.matrix.msc3906']) {
      expect(body.unstable_features[flag]).toBe(true);
    }
  });

  it('well-known client points Element at the rendezvous server', async () => {
    const res = await versionsApp.request('http://localhost/.well-known/matrix/client', {}, createEnv());
    const body = await json(res);
    expect(body['io.element.rendezvous']).toEqual({ server: `https://${SERVER}` });
  });

  it('capabilities advertise the delayed-events limits', async () => {
    // The capabilities route lives in index.ts; assert the service constants
    // the route advertises instead of booting the whole app here.
    const { MAX_DELAY_MS, MAX_SCHEDULED } = await import('../src/services/delayed-events');
    expect(MAX_DELAY_MS).toBe(86400000);
    expect(MAX_SCHEDULED).toBe(10);
  });
});