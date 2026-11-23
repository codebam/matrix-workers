// MSC4376 removed federation v1 send_join/send_leave in spec v1.18, but this
// server deliberately keeps the inbound v1 routes as lenient compatibility
// for older peers. Pin the response envelopes so that decision is intentional:
//   v1 send_join -> { origin, auth_chain, state, event }  (full v2-style envelope)
//   v2 send_join -> the same plus members_omitted / servers_in_room
//   v1 send_leave -> {}
//   v2 send_leave -> { event }
// Test-only: no route gate and no source changes to federation.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

let federationOriginSideChannel: string | null = null;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      if (federationOriginSideChannel) {
        c.set('federationOrigin', federationOriginSideChannel);
      }
      await next();
    };
  },
}));

import federation from '../src/api/federation';
import { calculateContentHash, generateSigningKeyPair } from '../src/utils/crypto';
import {
  seedPduVerifyKey,
  signEventForOrigin,
} from './helpers/federation-origin-signatures';

const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const USER = '@alice:example.com';
const REMOTE_USER = '@carol:remote.example.org';
const ROOM = '!room:example.com';
const EVENT = '$join:example.com';
const LEAVE_EVENT = '$leave:remote.example.org';
const CREATE = '$create:example.com';
const JOIN_RULES = '$join_rules:example.com';
const POWER = '$power:example.com';
const MEMBER = '$member:example.com';
const NOW = 1_700_000_000_000;

type EventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes: string | null;
  signatures: string | null;
};

function event(partial: Partial<EventRow> & Pick<EventRow, 'event_id'>): EventRow {
  return {
    event_id: partial.event_id,
    room_id: partial.room_id ?? ROOM,
    sender: partial.sender ?? USER,
    event_type: partial.event_type ?? 'm.room.member',
    state_key: partial.state_key !== undefined ? partial.state_key : null,
    content: partial.content ?? JSON.stringify({ membership: 'join' }),
    origin_server_ts: partial.origin_server_ts ?? NOW,
    depth: partial.depth ?? 3,
    auth_events: partial.auth_events ?? JSON.stringify([]),
    prev_events: partial.prev_events ?? JSON.stringify([]),
    hashes: partial.hashes ?? JSON.stringify({ sha256: 'abc' }),
    signatures: partial.signatures ?? JSON.stringify({ [SERVER]: { 'ed25519:1': 'sig' } }),
  };
}

/** Baseline public room: create, join_rules, power_levels and one local join. */
function baselineRows(): EventRow[] {
  return [
    event({
      event_id: CREATE,
      event_type: 'm.room.create',
      state_key: '',
      content: JSON.stringify({ creator: USER, room_version: '10' }),
      depth: 1,
    }),
    event({
      event_id: JOIN_RULES,
      event_type: 'm.room.join_rules',
      state_key: '',
      content: JSON.stringify({ join_rule: 'public' }),
      depth: 2,
      auth_events: JSON.stringify([CREATE]),
    }),
    event({
      event_id: POWER,
      event_type: 'm.room.power_levels',
      state_key: '',
      content: JSON.stringify({ users: { [USER]: 100 } }),
      depth: 2,
      auth_events: JSON.stringify([CREATE]),
    }),
    event({
      event_id: MEMBER,
      event_type: 'm.room.member',
      state_key: USER,
      content: JSON.stringify({ membership: 'join' }),
      depth: 3,
      auth_events: JSON.stringify([CREATE, JOIN_RULES, POWER]),
    }),
  ];
}

function kv() {
  const data: Record<string, string> = {};
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  } as unknown as KVNamespace;
}

function makeDb(opts: {
  events?: EventRow[];
  serverKey?: { key_id: string; private_key_jwk: string };
} = {}) {
  const events = opts.events ?? [];
  const state = events.filter((e) => e.state_key !== null);

  const asRow = (e: EventRow) => ({
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    event_type: e.event_type,
    state_key: e.state_key,
    content: e.content,
    origin_server_ts: e.origin_server_ts,
    unsigned: null,
    depth: e.depth,
    auth_events: e.auth_events,
    prev_events: e.prev_events,
    hashes: e.hashes,
    signatures: e.signatures,
  });

  function statement(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        args = bound;
        return this;
      },
      async first<T>() {
        if (sql.includes('FROM rooms WHERE room_id = ?')) {
          return { room_id: ROOM, room_version: '10' } as T;
        }
        if (sql.includes('FROM server_keys')) {
          return opts.serverKey
            ? ({
                key_id: opts.serverKey.key_id,
                private_key_jwk: opts.serverKey.private_key_jwk,
              } as T)
            : null;
        }
        if (sql.includes('FROM events WHERE event_id = ?')) {
          const row = events.find((e) => e.event_id === args[0]);
          return (row ? asRow(row) : null) as T;
        }
        // Wire derivation / policy-server lookups intentionally fall through:
        // the legacy as-stored path is what we want to pin.
        return null as T;
      },
      async all<T>() {
        if (sql.includes('FROM room_state rs')) {
          return { results: state.map(asRow) as T[] };
        }
        if (sql.includes('FROM events WHERE room_id = ?')) {
          return { results: events.map(asRow) as T[] };
        }
        if (sql.includes('FROM room_memberships')) {
          return { results: [] as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true };
      },
    };
  }

  return {
    prepare(sql: string) {
      return statement(sql);
    },
  } as unknown as D1Database;
}

function makeEnv(opts: {
  db: D1Database;
  cache: KVNamespace;
  origin?: string | null;
}): Env {
  federationOriginSideChannel = opts.origin ?? null;
  const stubDo = {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => Response.json({ ok: true }) }),
  };
  return {
    DB: opts.db,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    SESSIONS: kv(),
    DEVICE_KEYS: kv(),
    ONE_TIME_KEYS: kv(),
    CROSS_SIGNING_KEYS: kv(),
    CACHE: opts.cache,
    ACCOUNT_DATA: kv(),
    MEDIA: {} as R2Bucket,
    USER_KEYS: stubDo,
    FEDERATION: stubDo,
    ROOM: stubDo,
    SYNC: stubDo,
    ADMIN: stubDo,
    PUSH: stubDo,
    RATE_LIMIT: stubDo,
    CALL_ROOM: stubDo,
  } as unknown as Env;
}

async function request(env: Env, path: string, body: unknown) {
  const res = await federation.request(
    `http://localhost${path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

function joinBody() {
  return {
    event_id: EVENT,
    room_id: ROOM,
    type: 'm.room.member',
    sender: REMOTE_USER,
    state_key: REMOTE_USER,
    content: { membership: 'join' },
    auth_events: [CREATE, JOIN_RULES, POWER],
    prev_events: [],
    origin_server_ts: NOW,
    depth: 5,
  };
}

async function makeEnvForJoin(cache: KVNamespace) {
  const pair = await generateSigningKeyPair();
  return makeEnv({
    db: makeDb({
      events: baselineRows(),
      serverKey: {
        key_id: pair.keyId,
        private_key_jwk: JSON.stringify(pair.privateKeyJwk),
      },
    }),
    cache,
    origin: REMOTE,
  });
}

async function makeEnvForLeave(cache: KVNamespace) {
  const pair = await generateSigningKeyPair();
  return makeEnv({
    db: makeDb({
      // No room state: authorizeInboundLeave is permissive when we have not
      // synced state; that keeps this test about the envelope, not auth.
      events: [],
      serverKey: {
        key_id: pair.keyId,
        private_key_jwk: JSON.stringify(pair.privateKeyJwk),
      },
    }),
    cache,
    origin: REMOTE,
  });
}

async function signedLeave() {
  const base: Record<string, unknown> = {
    event_id: LEAVE_EVENT,
    room_id: ROOM,
    sender: REMOTE_USER,
    state_key: REMOTE_USER,
    type: 'm.room.member',
    content: { membership: 'leave' },
    origin_server_ts: NOW,
    depth: 4,
    auth_events: [],
    prev_events: [],
  };
  return signEventForOrigin(
    { ...base, hashes: { sha256: await calculateContentHash(base) } },
    REMOTE
  );
}

beforeEach(() => {
  federationOriginSideChannel = null;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  federationOriginSideChannel = null;
});

describe('MSC4376 compat: v1 send_join keeps the full envelope', () => {
  it('v1 send_join returns { origin, auth_chain, state, event }', async () => {
    const cache = kv();
    await seedPduVerifyKey(cache, REMOTE);
    const env = await makeEnvForJoin(cache);
    const res = await request(
      env,
      `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      joinBody()
    );

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'auth_chain',
      'event',
      'origin',
      'state',
    ]);
    expect(res.body.origin).toBe(SERVER);
    expect(res.body.state).toEqual(expect.any(Array));
    expect(res.body.auth_chain).toEqual(expect.any(Array));
    expect(res.body.event).toMatchObject({
      type: 'm.room.member',
      sender: REMOTE_USER,
      state_key: REMOTE_USER,
      content: { membership: 'join' },
    });
    // Superset of the legacy { state, auth_chain } shape: no keys removed.
    expect(res.body).toMatchObject({
      state: expect.any(Array),
      auth_chain: expect.any(Array),
    });
  });

  it('v2 send_join adds members_omitted and servers_in_room', async () => {
    const cache = kv();
    await seedPduVerifyKey(cache, REMOTE);
    const env = await makeEnvForJoin(cache);
    const res = await request(
      env,
      `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      joinBody()
    );

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'auth_chain',
      'event',
      'members_omitted',
      'origin',
      'servers_in_room',
      'state',
    ]);
    expect(res.body.members_omitted).toBe(false);
    expect(res.body.servers_in_room).toEqual([SERVER]);
    expect(res.body.event).toMatchObject({ type: 'm.room.member' });
  });
});

describe('MSC4376 compat: v1 send_leave keeps the empty envelope', () => {
  it('v1 send_leave returns {} exactly', async () => {
    const cache = kv();
    await seedPduVerifyKey(cache, REMOTE);
    const env = await makeEnvForLeave(cache);
    const res = await request(
      env,
      `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(LEAVE_EVENT)}`,
      await signedLeave()
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('v2 send_leave returns { event }', async () => {
    const cache = kv();
    await seedPduVerifyKey(cache, REMOTE);
    const env = await makeEnvForLeave(cache);
    const res = await request(
      env,
      `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(LEAVE_EVENT)}`,
      await signedLeave()
    );

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['event']);
    expect(res.body.event).toMatchObject({
      type: 'm.room.member',
      sender: REMOTE_USER,
      content: { membership: 'leave' },
    });
  });
});
