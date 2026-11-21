/**
 * Appservice event fanout integration:
 * - service-level: namespace matching, transaction delivery, failure isolation
 * - local send path: POST /rooms/{roomId}/send delivers to interested ASes
 * - federation inbound: PUT /_matrix/federation/v1/send delivers stored PDUs
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';
import { signSendBodyPdus } from './helpers/federation-origin-signatures';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', '@alice:example.com');
        c.set('deviceId', 'DEVICE');
        await next();
      };
    },
  };
});

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      c.set('federationOrigin', 'remote.example');
      await next();
    };
  },
}));

import rooms from '../src/api/rooms';
import federation from '../src/api/federation';
import { fanoutEventToAppServices } from '../src/services/appservice-fanout';

const SERVER = 'example.com';
const ALICE = `@alice:${SERVER}`;
const ROOM = `!r:${SERVER}`;

interface AsRow {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
}

function asRow(id: string, roomRegex: string): AsRow {
  return {
    id,
    url: `https://${id}.example.com`,
    as_token: `as-${id}`,
    hs_token: `hs-${id}`,
    sender_localpart: id,
    rate_limited: 0,
    protocols: null,
    namespaces: JSON.stringify({ users: [], rooms: [{ exclusive: false, regex: roomRegex }], aliases: [] }),
  };
}

type ToDeviceRow = {
  recipient_user_id: string;
  sender_user_id: string;
  event_type: string;
  content: string;
};

function createDb(opts: {
  appservices?: AsRow[];
  roomVersion?: string;
  remoteMember?: boolean;
  toDevice?: ToDeviceRow[];
} = {}) {
  const appservices = opts.appservices ?? [];
  const roomVersion = opts.roomVersion ?? '10';
  const remoteMember = opts.remoteMember ?? false;
  const toDevice = opts.toDevice ?? [];
  let stream = 10;
  let txnCounter = 0;
  const transactions: Array<{ id: number; asId: string; events: string }> = [];
  const sentUpdates: unknown[][] = [];
  const retryUpdates: unknown[][] = [];
  const storedEvents: Array<Record<string, unknown>> = [];

  const stateEvents = [
    {
      event_id: '$create', room_id: ROOM, sender: ALICE, event_type: 'm.room.create', state_key: '',
      content: JSON.stringify({ room_version: roomVersion, creator: ALICE }),
      origin_server_ts: 1, unsigned: null, depth: 0, auth_events: '[]', prev_events: '[]',
    },
    {
      event_id: '$pl', room_id: ROOM, sender: ALICE, event_type: 'm.room.power_levels', state_key: '',
      content: JSON.stringify({ users: { [ALICE]: 100 }, events_default: 0 }),
      origin_server_ts: 2, unsigned: null, depth: 1, auth_events: '[]', prev_events: '[]',
    },
    {
      event_id: '$alicejoin', room_id: ROOM, sender: ALICE, event_type: 'm.room.member', state_key: ALICE,
      content: JSON.stringify({ membership: 'join' }),
      origin_server_ts: 3, unsigned: null, depth: 2, auth_events: '[]', prev_events: '[]',
    },
    ...(remoteMember ? [{
      event_id: '$bobjoin', room_id: ROOM, sender: '@bob:remote.example', event_type: 'm.room.member', state_key: '@bob:remote.example',
      content: JSON.stringify({ membership: 'join' }),
      origin_server_ts: 4, unsigned: null, depth: 3, auth_events: '[]', prev_events: '[]',
    }] : []),
  ];

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes('UPDATE stream_positions')) {
          stream += 1;
          return { position: stream } as T;
        }
        if (sql.includes('FROM room_memberships WHERE room_id = ? AND user_id = ?')) {
          if (args[1] === ALICE) return { membership: 'join', event_id: '$alicejoin' } as T;
          if (remoteMember && args[1] === '@bob:remote.example') return { membership: 'join', event_id: '$bobjoin' } as T;
          return null as T;
        }
        if (sql.includes('FROM room_state rs') && sql.includes('rs.event_type = ?')) {
          const row = stateEvents.find(e => e.room_id === args[0] && e.event_type === args[1] && e.state_key === (args[2] ?? ''));
          return (row ?? null) as T | null;
        }
        if (sql.includes('FROM rooms WHERE room_id')) {
          return { room_id: args[0], room_version: roomVersion, is_public: 0, creator_id: ALICE, created_at: 1 } as T;
        }
        if (sql.includes('sender NOT LIKE')) {
          return null as T;
        }
        if (sql.includes('FROM federation_transactions')) {
          return null as T;
        }
        if (sql.includes('FROM processed_pdus')) {
          return null as T;
        }
        return null as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes('FROM appservice_registrations')) {
          return { results: appservices as T[] };
        }
        if (sql.includes('FROM room_memberships') && sql.includes('join')) {
          return { results: [{ user_id: ALICE }] as T[] };
        }
        if (sql.includes('FROM events WHERE room_id')) {
          return { results: [...stateEvents].reverse() as T[] };
        }
        if (sql.includes('FROM room_state rs')) {
          return { results: stateEvents as T[] };
        }
        if (sql.includes('FROM to_device_messages')) {
          return { results: toDevice as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes('INSERT INTO events') || sql.includes('INSERT OR IGNORE INTO events')) {
          storedEvents.push({ sql, args });
          return { success: true, meta: { changes: 1, last_row_id: 0 } };
        }
        if (sql.includes('INSERT INTO appservice_transactions')) {
          txnCounter += 1;
          transactions.push({ id: txnCounter, asId: args[0] as string, events: args[1] as string });
          return { success: true, meta: { changes: 1, last_row_id: txnCounter } };
        }
        if (sql.includes('SET sent_at')) {
          sentUpdates.push(args);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('retry_count')) {
          retryUpdates.push(args);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };

  return {
    transactions,
    sentUpdates,
    retryUpdates,
    storedEvents,
    prepare: (sql: string) => stmt(sql),
  };
}

type Db = ReturnType<typeof createDb>;

function envFor(db: Db, ephemeralState: {
  typing?: string[];
  receipts?: Record<string, Record<string, Record<string, { ts: number }>>>;
} = {}): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db as unknown as D1Database,
    CACHE: (() => {
      const kv = new Map<string, string>();
      return {
        get: async (key: string, type?: string) => {
          const v = kv.get(key);
          if (v === undefined) return null;
          return type === 'json' ? JSON.parse(v) : v;
        },
        put: async (key: string, value: string) => { kv.set(key, value); },
        delete: async (key: string) => { kv.delete(key); },
      } as unknown as KVNamespace;
    })(),
    ROOMS: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === '/typing') {
            return Response.json({ user_ids: ephemeralState.typing ?? [] });
          }
          if (path === '/receipts') {
            return Response.json({ receipts: ephemeralState.receipts ?? {} });
          }
          return new Response('not found', { status: 404 });
        },
      }),
    } as unknown as Env['ROOMS'],
    SYNC: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response('{}') }),
    } as unknown as Env['SYNC'],
    FEDERATION: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response('Queued') }),
    } as unknown as Env['FEDERATION'],
    PUSH_NOTIFICATION_WORKFLOW: {
      create: async () => ({ id: 'push-1' }),
    } as unknown as Env['PUSH_NOTIFICATION_WORKFLOW'],
  } as unknown as Env;
}

function execCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) { promises.push(p); },
    passThroughOnException() {},
    promises,
  };
}

const EVENT: PDU = {
  event_id: '$evt1',
  room_id: ROOM,
  sender: ALICE,
  type: 'm.room.message',
  content: { body: 'hello' },
  origin_server_ts: 1000,
  depth: 3,
  auth_events: [],
  prev_events: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fanoutEventToAppServices (service)', () => {
  it('delivers only to namespace-matching appservices with the hs_token', async () => {
    const db = createDb({
      appservices: [asRow('interested', '^!r:example\\.com$'), asRow('bored', '^!other:')],
    });
    await fanoutEventToAppServices(envFor(db), EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://interested.example.com/_matrix/app/v1/transactions/1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hs-interested');
    expect(JSON.parse(String(init.body))).toEqual({
      events: [EVENT],
      ephemeral: [],
      to_device: [],
    });
    expect(db.transactions).toHaveLength(1);
    expect(db.sentUpdates).toHaveLength(1);
  });

  it('includes typing, public receipts and namespace-matched to_device messages', async () => {
    const bot = '@_bridge_bot:example.com';
    const bridge = {
      ...asRow('bridge', '^!r:example\\.com$'),
      namespaces: JSON.stringify({
        users: [{ exclusive: true, regex: '^@_bridge_.*:example\\.com$' }],
        rooms: [{ exclusive: false, regex: '^!r:example\\.com$' }],
        aliases: [],
      }),
    };
    const db = createDb({
      appservices: [bridge],
      toDevice: [
        {
          recipient_user_id: bot,
          sender_user_id: ALICE,
          event_type: 'm.room_key',
          content: JSON.stringify({ algorithm: 'm.megolm.v1.aes-sha2' }),
        },
        {
          recipient_user_id: '@alice:example.com',
          sender_user_id: ALICE,
          event_type: 'm.room_key',
          content: JSON.stringify({ algorithm: 'not-for-the-bridge' }),
        },
      ],
    });
    const env = envFor(db, {
      typing: [ALICE, bot],
      receipts: {
        '$evt': {
          'm.read': { [ALICE]: { ts: 123 } },
          'm.read.private': { [ALICE]: { ts: 456 } },
        },
      },
    });

    await fanoutEventToAppServices(env, EVENT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as {
      events: unknown[];
      ephemeral: Array<Record<string, unknown>>;
      to_device: Array<Record<string, unknown>>;
    };
    expect(sent.events).toEqual([EVENT]);
    expect(sent.ephemeral).toEqual([
      { type: 'm.typing', room_id: ROOM, content: { user_ids: [ALICE, bot] } },
      {
        type: 'm.receipt',
        room_id: ROOM,
        content: { '$evt': { 'm.read': { [ALICE]: { ts: 123 } } } },
      },
    ]);
    expect(sent.to_device).toEqual([
      {
        type: 'm.room_key',
        sender: ALICE,
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      },
    ]);
  });

  it('does nothing when no appservices are registered', async () => {
    const db = createDb();
    await fanoutEventToAppServices(envFor(db), EVENT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.transactions).toHaveLength(0);
  });

  it('isolates delivery failures and records the retry', async () => {
    fetchMock.mockRejectedValue(new Error('bridge down'));
    const db = createDb({ appservices: [asRow('broken', '^!r:')] });
    await expect(fanoutEventToAppServices(envFor(db), EVENT)).resolves.toBeUndefined();
    expect(db.retryUpdates).toHaveLength(1);
    expect(db.sentUpdates).toHaveLength(0);
  });

  it('matches user namespaces on sender and membership state_key', async () => {
    const db = createDb({
      appservices: [{
        ...asRow('userns', '^!nomatch:'),
        namespaces: JSON.stringify({ users: [{ exclusive: false, regex: '^@bob:' }], rooms: [], aliases: [] }),
      }],
    });
    const memberEvent: PDU = { ...EVENT, type: 'm.room.member', state_key: '@bob:elsewhere.org', content: { membership: 'invite' } };
    await fanoutEventToAppServices(envFor(db), memberEvent);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('local send → appservice fanout', () => {
  it('POST /rooms/{roomId}/send delivers the stored event to interested ASes', async () => {
    const db = createDb({ appservices: [asRow('bridge', '^!r:example\\.com$')] });
    const ctx = execCtx();
    const res = await rooms.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM}/send/m.room.message/txn1`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'hello' }) },
      envFor(db),
      ctx as never
    );
    expect(res.status).toBe(200);
    const { event_id } = (await res.json()) as { event_id: string };
    expect(event_id).toBeTruthy();
    await Promise.all(ctx.promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://bridge.example.com/_matrix/app/v1/transactions/');
    const sent = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
    expect(sent.events).toHaveLength(1);
    expect(sent.events[0].event_id).toBe(event_id);
    expect(sent.events[0].type).toBe('m.room.message');
    expect(sent.events[0].content).toEqual({ body: 'hello' });
  });

  it('non-matching appservices receive nothing', async () => {
    const db = createDb({ appservices: [asRow('bored', '^!other:')] });
    const ctx = execCtx();
    const res = await rooms.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM}/send/m.room.message/txn2`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'hi' }) },
      envFor(db),
      ctx as never
    );
    expect(res.status).toBe(200);
    await Promise.all(ctx.promises);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('federation inbound /send → appservice fanout', () => {
  it('delivers accepted remote PDUs to interested ASes', async () => {
    const db = createDb({ appservices: [asRow('bridge', '^!r:example\\.com$')], roomVersion: '1', remoteMember: true });
    const env = envFor(db);
    const pdu = {
      event_id: '$remote1',
      room_id: ROOM,
      sender: '@bob:remote.example',
      type: 'm.room.message',
      content: { body: 'from remote' },
      origin_server_ts: 1234,
      depth: 5,
      auth_events: [],
      prev_events: [],
    };
    const body = await signSendBodyPdus(env, { pdus: [pdu], edus: [] });
    const res = await federation.request(
      'http://localhost/_matrix/federation/v1/send/txn-remote-1',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      env
    );
    expect(res.status).toBe(200);
    const body2 = (await res.json()) as { pdus: Record<string, unknown> };
    expect(body2.pdus['$remote1']).toEqual({});

    const asCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/_matrix/app/v1/transactions/')
    );
    expect(asCalls).toHaveLength(1);
    const [url, init] = asCalls[0] as [string, RequestInit];
    expect(url).toContain('https://bridge.example.com/_matrix/app/v1/transactions/');
    const sent = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
    expect(sent.events[0].event_id).toBe('$remote1');
    expect(sent.events[0].sender).toBe('@bob:remote.example');
  });

  it('does not redeliver duplicate PDUs to appservices', async () => {
    const db = createDb({ appservices: [asRow('bridge', '^!r:')], roomVersion: '1', remoteMember: true });
    // First delivery inserts; simulate the second transaction hitting the
    // processed_pdus dedup by pre-marking the PDU accepted.
    const originalPrepare = db.prepare;
    let seenInsert = false;
    db.prepare = (sql: string) => {
      const inner = originalPrepare(sql);
      if (sql.includes('FROM processed_pdus')) {
        return {
          ...inner,
          bind: (...args: unknown[]) => ({
            ...inner.bind(...args),
            first: async () => (seenInsert ? { accepted: 1, rejection_reason: null } : null),
          }),
        } as ReturnType<typeof originalPrepare>;
      }
      if (sql.includes('INSERT OR IGNORE INTO events')) {
        seenInsert = true;
      }
      return inner;
    };

    const pdu = {
      event_id: '$remote2',
      room_id: ROOM,
      sender: '@bob:remote.example',
      type: 'm.room.message',
      content: { body: 'dup' },
      origin_server_ts: 1234,
      depth: 5,
      auth_events: [],
      prev_events: [],
    };
    const env = envFor(db);
    const signedBody = await signSendBodyPdus(env, { pdus: [pdu], edus: [] });
    const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signedBody) };
    const asCalls = () => fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/_matrix/app/v1/transactions/')
    );
    await federation.request('http://localhost/_matrix/federation/v1/send/txn-a', init, env);
    expect(asCalls()).toHaveLength(1);
    await federation.request('http://localhost/_matrix/federation/v1/send/txn-b', init, env);
    expect(asCalls()).toHaveLength(1);
  });
});