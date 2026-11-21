/**
 * Restricted rooms (MSC3083/MSC3787) on the federation surface:
 * make_join allow-list authorisation, inbound send_join resident-server
 * checks, and federation /refresh_room ACL + resync wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const FED_ORIGIN = 'remote.example.org';
let federationOrigin: string | null = FED_ORIGIN;

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    if (federationOrigin) c.set('federationOrigin', federationOrigin);
    await next();
  },
  optionalFederationAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    if (federationOrigin) c.set('federationOrigin', federationOrigin);
    await next();
  },
}));

const getRoomState = vi.fn(async (): Promise<PDU[]> => []);
const getStateEvent = vi.fn(async () => null as PDU | null);
const getMembership = vi.fn(async () => null as { membership: string; eventId: string } | null);
const storeEventIdempotent = vi.fn(async () => ({ inserted: true, streamOrdering: 1 }));
const updateMembership = vi.fn(async () => undefined);

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoomState: (...args: unknown[]) => getRoomState(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    updateMembership: (...args: unknown[]) => updateMembership(...args),
  };
});

const federationGet = vi.fn();
vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return {
    ...actual,
    federationGet: (...args: unknown[]) => federationGet(...args),
  };
});

const refreshRestrictedRoomStateSpy = vi.fn(async () => 1);
vi.mock('../src/services/restricted-joins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/restricted-joins')>();
  return {
    ...actual,
    refreshRestrictedRoomState: (...args: unknown[]) => refreshRestrictedRoomStateSpy(...args),
  };
});

import federation, { authorizeInboundJoin } from '../src/api/federation';
import { evaluateRestrictedJoin } from '../src/services/restricted-joins';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ALLOWED = '!allowed:example.com';
const JOINER = '@carol:remote.example.org';
const AUTHORIZER = '@alice:example.com';
const REMOTE_AUTHORIZER = '@eve:remote.example.org';
const NOW = 1_700_000_000_000;

type StateRow = { eventType: string; stateKey: string; eventId: string };

function stateEvent(
  eventId: string,
  eventType: string,
  content: Record<string, unknown>,
  stateKey = '',
  sender = AUTHORIZER
): PDU {
  return {
    event_id: eventId,
    room_id: ROOM,
    sender,
    type: eventType,
    state_key: stateKey,
    content,
    origin_server_ts: NOW,
    depth: 2,
    auth_events: [],
    prev_events: [],
  };
}

function restrictedState(opts: { allow?: unknown[]; rule?: string; authorizer?: string } = {}): PDU[] {
  return [
    stateEvent('$create', 'm.room.create', { creator: AUTHORIZER, room_version: '10' }),
    stateEvent('$jr', 'm.room.join_rules', {
      join_rule: opts.rule ?? 'restricted',
      allow: opts.allow ?? [{ type: 'm.room_membership', room_id: ALLOWED }],
    }),
    stateEvent('$pl', 'm.room.power_levels', {
      users: { [AUTHORIZER]: 100 },
      users_default: 0,
      invite: 50,
    }),
    stateEvent('$authorizer-join', 'm.room.member', { membership: 'join' }, opts.authorizer ?? AUTHORIZER),
  ];
}

function makeDb(roomVersion = '10') {
  const stateRows: StateRow[] = [
    { eventType: 'm.room.create', stateKey: '', eventId: '$create' },
    { eventType: 'm.room.join_rules', stateKey: '', eventId: '$jr' },
    { eventType: 'm.room.power_levels', stateKey: '', eventId: '$pl' },
  ];
  return {
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM rooms WHERE room_id = ?') && sql.includes('room_version')) {
            return { room_id: args[0], room_version: roomVersion } as T;
          }
          if (sql.includes("rs.event_type = 'm.room.create'")) {
            return { event_id: '$create' } as T;
          }
          if (sql.includes("rs.event_type = 'm.room.join_rules'")) {
            return { event_id: '$jr' } as T;
          }
          if (sql.includes("rs.event_type = 'm.room.power_levels'")) {
            return { event_id: '$pl' } as T;
          }
          if (sql.includes('FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1')) {
            return { event_id: '$latest', depth: 5 } as T;
          }
          if (sql.includes('UPDATE stream_positions')) return { position: 1 } as T;
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("e.event_type, e.state_key, e.content, e.sender") &&
              sql.includes('FROM room_state rs')) {
            return { results: stateRows as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      });
      return { ...exec([]), bind: (...args: unknown[]) => exec(args) };
    },
  } as unknown as D1Database;
}

function makeEnv(db = makeDb()): Env {
  return {
    DB: db,
    CACHE: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
  } as unknown as Env;
}

async function request(env: Env, path: string, init: RequestInit = {}) {
  const waitUntil = vi.fn(async (p: Promise<unknown>) => { await p; });
  const res = await federation.request(`http://localhost${path}`, init, env, { waitUntil } as never);
  return { status: res.status, body: await res.json(), waitUntil };
}

function joinPath(roomId = ROOM, userId = JOINER) {
  return `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}`;
}

beforeEach(() => {
  federationOrigin = FED_ORIGIN;
  getRoomState.mockReset().mockResolvedValue(restrictedState());
  getStateEvent.mockReset().mockResolvedValue(null);
  getMembership.mockReset().mockResolvedValue(null);
  storeEventIdempotent.mockReset().mockResolvedValue({ inserted: true, streamOrdering: 1 });
  updateMembership.mockReset().mockResolvedValue(undefined);
  federationGet.mockReset();
  refreshRestrictedRoomStateSpy.mockReset().mockResolvedValue(1);
});

afterEach(() => {
  federationOrigin = FED_ORIGIN;
});

describe('make_join for restricted rooms', () => {
  it('embeds a joined, invite-power local authoriser when the allow list is satisfied', async () => {
    getMembership.mockImplementation(async (_db, roomId: string, userId: string) => {
      if (roomId === ALLOWED && userId === JOINER) return { membership: 'join', eventId: '$allowed-join' };
      return null;
    });
    const { status, body } = await request(makeEnv(), joinPath());
    expect(status).toBe(200);
    expect(body.event.content).toMatchObject({
      membership: 'join',
      join_authorised_via_users_server: AUTHORIZER,
    });
    expect(body.event.auth_events).toContain('$authorizer-join');
  });

  it('403s when the joiner is in none of the allowed rooms', async () => {
    const { status, body } = await request(makeEnv(), joinPath());
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });

  it('403s when no local member has invite power', async () => {
    getMembership.mockResolvedValue({ membership: 'join', eventId: '$allowed-join' });
    getRoomState.mockResolvedValue(restrictedState().map((ev) =>
      ev.type === 'm.room.power_levels'
        ? { ...ev, content: { users: {}, invite: 100 } }
        : ev
    ));
    const { status } = await request(makeEnv(), joinPath());
    expect(status).toBe(403);
  });

  it('serves the plain template for an invited user even in a restricted room', async () => {
    getRoomState.mockResolvedValue([
      ...restrictedState(),
      stateEvent('$invite', 'm.room.member', { membership: 'invite' }, JOINER),
    ]);
    const { status, body } = await request(makeEnv(), joinPath());
    expect(status).toBe(200);
    expect(body.event.content).toEqual({ membership: 'join' });
  });
});

describe('inbound join authorisation', () => {
  const joinEvent = (content: Record<string, unknown>) => ({
    event_id: '$join',
    room_id: ROOM,
    sender: JOINER,
    state_key: JOINER,
    type: 'm.room.member',
    content: { membership: 'join', ...content },
    origin_server_ts: NOW,
    depth: 6,
    auth_events: [],
    prev_events: [],
  });

  it('accepts a join with a valid local authorising user', async () => {
    getRoomState.mockResolvedValue(restrictedState());
    expect(await authorizeInboundJoin(makeEnv(), ROOM, '10', joinEvent({
      join_authorised_via_users_server: AUTHORIZER,
    }), FED_ORIGIN)).toBeNull();
  });

  it('refuses a join missing the authorising field', async () => {
    getRoomState.mockResolvedValue(restrictedState());
    expect(await authorizeInboundJoin(makeEnv(), ROOM, '10', joinEvent({}), FED_ORIGIN))
      .toMatch(/not authorized/i);
  });

  it('refuses a non-local authorising user even with the right power level', async () => {
    getRoomState.mockResolvedValue(restrictedState({ authorizer: REMOTE_AUTHORIZER }));
    const remotePlState = restrictedState().map((ev) =>
      ev.type === 'm.room.power_levels'
        ? { ...ev, content: { users: { [REMOTE_AUTHORIZER]: 100 }, invite: 50 } }
        : ev
    );
    getRoomState.mockResolvedValue(remotePlState);
    expect(await authorizeInboundJoin(makeEnv(), ROOM, '10', joinEvent({
      join_authorised_via_users_server: REMOTE_AUTHORIZER,
    }), FED_ORIGIN)).toMatch(/not on this server/i);
  });

  it('accepts a valid restricted join over send_join v1 and refuses a missing authoriser', async () => {
    getRoomState.mockResolvedValue(restrictedState());
    const sendPath = `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/$rj`;
    const post = (content: Record<string, unknown>): RequestInit => ({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...joinEvent(content), event_id: '$rj' }),
    });
    const ok = await request(makeEnv(), sendPath, post({
      join_authorised_via_users_server: AUTHORIZER,
    }));
    expect(ok.status).toBe(200);

    const missing = await request(makeEnv(), sendPath, post({}));
    expect(missing.status).toBe(403);
    expect(missing.body.errcode).toBe('M_FORBIDDEN');

    const foreign = await request(makeEnv(), sendPath, post({
      join_authorised_via_users_server: REMOTE_AUTHORIZER,
    }));
    expect(foreign.status).toBe(403);
  });
});

describe('share helper evaluation', () => {
  it('rejects knock_restricted on room versions before v10', async () => {
    const decision = await evaluateRestrictedJoin({
      db: makeDb('8'),
      cache: makeEnv().CACHE,
      localServerName: SERVER,
      roomId: ROOM,
      userId: JOINER,
      roomState: restrictedState({ rule: 'knock_restricted' }),
      roomVersion: '8',
    });
    expect(decision.error).toMatch(/version 10/i);
  });

  it('falls back to via-server state when the allowed room is not held locally', async () => {
    getRoomState.mockImplementation(async (_db, roomId: string) =>
      roomId === ROOM
        ? restrictedState({
            allow: [{ type: 'm.room_membership', room_id: ALLOWED, via: ['via.example.org'] }],
          })
        : []
    );
    federationGet
      .mockResolvedValueOnce(new Response(JSON.stringify({ pdu_ids: ['$member:allowed'] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pdus: [{
          event_id: '$member:allowed',
          room_id: ALLOWED,
          type: 'm.room.member',
          state_key: JOINER,
          content: { membership: 'join' },
          sender: JOINER,
          origin_server_ts: NOW,
          depth: 1,
          auth_events: [],
          prev_events: [],
        }],
      })));
    const decision = await evaluateRestrictedJoin({
      db: makeDb(),
      cache: makeEnv().CACHE,
      localServerName: SERVER,
      roomId: ROOM,
      userId: JOINER,
      roomState: restrictedState({
        allow: [{ type: 'm.room_membership', room_id: ALLOWED, via: ['via.example.org'] }],
      }),
      roomVersion: '10',
    });
    expect(decision.authorizedBy).toBe(AUTHORIZER);
    expect(federationGet.mock.calls[0][1]).toContain('/state_ids/');
    expect(federationGet.mock.calls[1][1]).toContain('/state/');
  });
});

describe('POST /refresh_room/:roomId', () => {
  const path = `/_matrix/federation/v1/refresh_room/${encodeURIComponent(ROOM)}`;
  const init = (body: unknown = { via: ['via.example.org'] }): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('refuses servers denied by the room ACL', async () => {
    getStateEvent.mockResolvedValue({
      ...stateEvent('$acl', 'm.room.server_acl', { allow: ['*'], deny: [FED_ORIGIN] }),
    });
    const { status, body, waitUntil } = await request(makeEnv(), path, init());
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(refreshRestrictedRoomStateSpy).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('returns 200 and triggers the resync for an allowed server', async () => {
    const { status, body, waitUntil } = await request(makeEnv(), path, init());
    expect(status).toBe(200);
    expect(body).toEqual({});
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(refreshRestrictedRoomStateSpy).toHaveBeenCalledWith(
      expect.anything(), ROOM, ['via.example.org'], '10'
    );
  });

  it('rejects a room version without restricted joins', async () => {
    const { status, body } = await request(makeEnv(makeDb('7')), path, init());
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_UNSUPPORTED_ROOM_VERSION');
  });

  it('rejects a missing via list', async () => {
    const { status, body } = await request(makeEnv(), path, init({}));
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_INVALID_PARAM');
  });
});

describe('refreshRestrictedRoomState helper', () => {
  it('stores current state PDUs from a via server', async () => {
    federationGet.mockResolvedValue(new Response(JSON.stringify({
      pdus: [
        stateEvent('$remote-create', 'm.room.create', { creator: AUTHORIZER, room_version: '10' }),
        stateEvent('$remote-join', 'm.room.member', { membership: 'join' }, JOINER),
      ],
    })));
    const env = makeEnv();
    // The module-level export is wrapped in a spy for the endpoint tests;
    // exercise the real implementation here.
    const actual = await vi.importActual<typeof import('../src/services/restricted-joins')>(
      '../src/services/restricted-joins'
    );
    const count = await actual.refreshRestrictedRoomState(env, ROOM, ['via.example.org'], '10');
    expect(count).toBe(2);
    expect(federationGet.mock.calls[0][1]).toBe(`/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(storeEventIdempotent).toHaveBeenCalledTimes(2);
    expect(updateMembership).toHaveBeenCalledWith(expect.anything(), ROOM, JOINER, 'join', '$remote-join');
  });
});
