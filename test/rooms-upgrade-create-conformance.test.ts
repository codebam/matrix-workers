/**
 * Focused conformance coverage for the two room-management gaps:
 *  - POST /rooms/:roomId/upgrade: invite all old members, copy state
 *    generically, freeze the old room with a federated PL update.
 *  - POST /createRoom: honour creation_content and
 *    power_level_content_override without letting clients own server fields.
 *
 * Tests-only; fixtures use example.com / remote.example only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const authState = vi.hoisted(() => ({ userId: '@alice:example.com' }));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', authState.userId);
    c.set('deviceId', 'DEVICEA');
    await next();
  },
}));

const dbMocks = vi.hoisted(() => ({
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  storeEvent: vi.fn(),
  getRoomState: vi.fn(),
  getStateEvent: vi.fn(),
  getRoomEvents: vi.fn(),
  updateMembership: vi.fn(),
  getMembership: vi.fn(),
  getRoomMembers: vi.fn(),
  getInvitePermission: vi.fn(),
  notifyUsersOfEvent: vi.fn(),
  getUserRooms: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    ...dbMocks,
  };
});

const idsMocks = vi.hoisted(() => ({
  generateRoomId: vi.fn(async () => '!upgraded:example.com'),
  generateEventId: vi.fn(async () => '$evt:example.com'),
}));

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return { ...actual, ...idsMocks };
});

// Bypass WebCrypto/signing-key setup but keep the real event-wire helpers so
// auth-event augmentation and legacy wire mapping still run.
let wireSeq = 0;
const prepareOutboundPdu = vi.fn(async (_env: unknown, event: PDU) => {
  const wireId = `$wire${++wireSeq}:example.com`;
  return {
    wireId,
    hashes: { sha256: 'hash' },
    signatures: {},
    wire: { ...event, event_id: undefined, hashes: { sha256: 'hash' } },
  };
});

vi.mock('../src/services/event-wire', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/event-wire')>();
  return { ...actual, prepareOutboundPdu: (...args: unknown[]) => prepareOutboundPdu(...(args as [Env, PDU])) };
});

const modMocks = vi.hoisted(() => ({
  getActivePolicyRules: vi.fn(async () => ({ subscriptions: 0 })),
  isUserBannedByPolicy: vi.fn(() => null),
  isServerBannedByPolicy: vi.fn(() => null),
}));

vi.mock('../src/services/moderation-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/moderation-policy')>();
  return { ...actual, ...modMocks };
});

const policyMocks = vi.hoisted(() => ({
  getRoomPolicyServer: vi.fn(async () => null as { via: string; ed25519: string } | null),
  askPolicyServerSignature: vi.fn(async () => ({ signature: 'ps-signature' })),
  attachPolicySignature: vi.fn(() => undefined),
  eventExemptFromPolicy: vi.fn(() => false),
  verifyPolicySignature: vi.fn(async () => true),
}));

vi.mock('../src/services/policy-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/policy-server')>();
  return { ...actual, ...policyMocks };
});

import rooms from '../src/api/rooms';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const DAVE = '@dave:remote.example';
const ERIN = '@erin:remote.example';
const SERVER = 'example.com';
const ROOM = '!old:example.com';
const NEW_ROOM = '!upgraded:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const NOW = 1_700_000_000_000;

function pdu(partial: Partial<PDU> & { event_id: string; type: string; content: unknown }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    state_key: '',
    origin_server_ts: NOW,
    depth: 0,
    auth_events: [],
    prev_events: [],
    ...partial,
  } as PDU;
}

type FedCall = { url: string; payload: Record<string, unknown> };

type BatchStmt = { sql: string; args: unknown[] };

function createDb(remoteJoined: string[] = []) {
  const batches: BatchStmt[][] = [];
  const db: Record<string, unknown> = {
    batches,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async first<T>() {
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                return { position: 20 + Number(args[0]) } as T;
              }
              if (sql.includes('ORDER BY depth DESC LIMIT 1')) {
                return { event_id: '$last', depth: 9 } as T;
              }
              return null as T;
            },
            async all() {
              if (sql.includes('SELECT DISTINCT user_id FROM room_memberships')) {
                return { results: remoteJoined.map((user_id) => ({ user_id })) };
              }
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        },
      };
    },
    async batch(stmts: BatchStmt[]) {
      batches.push(stmts);
      return [];
    },
  };
  return db;
}

function batchedEventContent(db: ReturnType<typeof createDb>, type: string): Record<string, unknown> | undefined {
  const insert = db.batches
    .flat()
    .find((stmt) => stmt.sql.includes('INSERT INTO events') && stmt.args[3] === type);
  return insert ? JSON.parse(insert.args[5] as string) : undefined;
}

function envFor(db: ReturnType<typeof createDb>, fedCalls: FedCall[], failPaths: string[] = []) {
  return {
    DB: db,
    CACHE: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    SERVER_NAME: SERVER,
    FEDERATION: {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(req: Request) {
          const text = await req.text();
          const url = new URL(req.url).pathname;
          fedCalls.push({ url, payload: text ? JSON.parse(text) : {} });
          if (failPaths.includes(url)) throw new Error('federation delivery failed');
          return new Response('Queued');
        },
      }),
    },
  } as unknown as Env;
}

async function request(
  path: string,
  body: unknown,
  db = createDb(),
  fedCalls: FedCall[] = [],
  failPaths: string[] = []
) {
  const env = envFor(db, fedCalls, failPaths);
  const res = await rooms.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify(body),
  }, env, { waitUntil() {}, passThroughOnException() {}, props: {} } as never);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const OLD_PL = pdu({
  event_id: '$pl',
  type: 'm.room.power_levels',
  state_key: '',
  content: {
    users: { [USER]: 100, [BOB]: 50 },
    events: { 'm.room.tombstone': 100 },
    events_default: 0,
    state_default: 50,
    invite: 50,
  },
});

function seedState(extra: PDU[] = []) {
  const oldState = [
    pdu({ event_id: '$create', type: 'm.room.create', content: { creator: USER, room_version: '10' } }),
    OLD_PL,
    pdu({ event_id: '$jr', type: 'm.room.join_rules', content: { join_rule: 'invite' } }),
    pdu({ event_id: '$hv', type: 'm.room.history_visibility', content: { history_visibility: 'shared' } }),
    pdu({ event_id: '$bob', type: 'm.room.member', state_key: BOB, content: { membership: 'join' } }),
    ...extra,
  ];
  dbMocks.getRoomState.mockResolvedValue(oldState);
  dbMocks.getStateEvent.mockImplementation(async (_db: unknown, roomId: string, type: string, stateKey?: string) => {
    const key = `${type}\u0000${stateKey ?? ''}`;
    if (roomId === ROOM) {
      const found = oldState.find((e) => `${e.type}\u0000${e.state_key ?? ''}` === key);
      return found ?? null;
    }
    if (roomId === NEW_ROOM) {
      const newState: Record<string, PDU> = {
        'm.room.create\u0000': pdu({ event_id: '$newcreate', type: 'm.room.create', content: { creator: USER, room_version: '10' } }),
        'm.room.power_levels\u0000': pdu({ event_id: '$newpl', type: 'm.room.power_levels', content: { users: { [USER]: 100 }, invite: 50 } }),
        'm.room.join_rules\u0000': pdu({ event_id: '$newjr', type: 'm.room.join_rules', content: { join_rule: 'invite' } }),
      };
      return newState[key] ?? null;
    }
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireSeq = 0;
  prepareOutboundPdu.mockImplementation(async (_env: unknown, event: PDU) => {
    const wireId = `$wire${++wireSeq}:example.com`;
    return {
      wireId,
      hashes: { sha256: 'hash' },
      signatures: {},
      wire: { ...event, event_id: undefined, hashes: { sha256: 'hash' } },
    };
  });
  dbMocks.getRoom.mockImplementation(async (_db: unknown, roomId: string) => ({
    room_id: roomId,
    room_version: '10',
  }));
  dbMocks.getMembership.mockImplementation(async (_db: unknown, roomId: string, userId: string) =>
    roomId === ROOM && userId === USER ? { membership: 'join', eventId: '$alice-join' } : null
  );
  dbMocks.getRoomMembers.mockResolvedValue([]);
  dbMocks.getInvitePermission.mockResolvedValue('allow');
  dbMocks.getRoomEvents.mockResolvedValue({ events: [] });
  dbMocks.getUserRooms.mockResolvedValue([]);
  dbMocks.storeEvent.mockResolvedValue(undefined);
  policyMocks.getRoomPolicyServer.mockResolvedValue(null);
  seedState();
});

describe('room upgrade conformance', () => {
  it('invites every joined/invited local and remote old member to the new room', async () => {
    seedState([
      pdu({ event_id: '$carol', type: 'm.room.member', state_key: CAROL, content: { membership: 'invite' } }),
      pdu({ event_id: '$dave', type: 'm.room.member', state_key: DAVE, content: { membership: 'join' } }),
      pdu({ event_id: '$erin', type: 'm.room.member', state_key: ERIN, content: { membership: 'invite' } }),
    ]);
    dbMocks.getRoomMembers.mockResolvedValue([
      { userId: USER, membership: 'join' },
      { userId: BOB, membership: 'join' },
      { userId: CAROL, membership: 'invite' },
      { userId: DAVE, membership: 'join' },
      { userId: ERIN, membership: 'invite' },
    ]);
    policyMocks.getRoomPolicyServer.mockResolvedValue({ via: 'policy.example', ed25519: 'key' });

    const fedCalls: FedCall[] = [];
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      { new_version: '11' },
      createDb(),
      fedCalls
    );

    expect(status).toBe(200);
    expect(body).toEqual({ replacement_room: NEW_ROOM });

    const newInvites = dbMocks.storeEvent.mock.calls
      .map((call: unknown[]) => call[1] as PDU)
      .filter((e: PDU) => e.room_id === NEW_ROOM && e.type === 'm.room.member' && e.state_key !== USER);
    const byStateKey = new Map(newInvites.map((e) => [e.state_key, e]));
    for (const member of [BOB, CAROL, DAVE, ERIN]) {
      expect(byStateKey.get(member)?.content).toMatchObject({ membership: 'invite' });
      expect(dbMocks.updateMembership).toHaveBeenCalledWith(
        expect.anything(), NEW_ROOM, member, 'invite', expect.any(String)
      );
    }
    // The upgrader joins but is not sent a duplicate invite.
    expect(newInvites.some((e: PDU) => e.state_key === USER)).toBe(false);

    const inviteCalls = fedCalls.filter((c) => c.url === '/invite');
    expect(inviteCalls.map((c) => (c.payload.event as Record<string, unknown>).state_key).sort())
      .toEqual([DAVE, ERIN].sort());
    expect(inviteCalls.every((c) => c.payload.room_id === NEW_ROOM)).toBe(true);

    // Invites travel through the normal event pipeline, which asks the room's
    // policy server to countersign non-exempt events.
    const asked = policyMocks.askPolicyServerSignature.mock.calls.map((call: unknown[]) => call[2] as PDU);
    expect(asked.some((e) => e.type === 'm.room.member' && e.content?.membership === 'invite')).toBe(true);
  });

  it('keeps upgrading when an invite is refused or federation delivery fails', async () => {
    seedState([
      pdu({ event_id: '$bob', type: 'm.room.member', state_key: BOB, content: { membership: 'join' } }),
      pdu({ event_id: '$dave', type: 'm.room.member', state_key: DAVE, content: { membership: 'join' } }),
    ]);
    dbMocks.getRoomMembers.mockResolvedValue([
      { userId: USER, membership: 'join' },
      { userId: BOB, membership: 'join' },
      { userId: DAVE, membership: 'join' },
    ]);
    dbMocks.getInvitePermission.mockImplementation(async (_db: unknown, invitee: string) =>
      invitee === BOB ? 'block' : 'allow'
    );

    const fedCalls: FedCall[] = [];
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      { new_version: '11' },
      createDb(),
      fedCalls,
      ['/invite']
    );
    expect(status).toBe(200);

    const newInviteKeys = dbMocks.storeEvent.mock.calls
      .map((call: unknown[]) => call[1] as PDU)
      .filter((e: PDU) => e.room_id === NEW_ROOM && e.type === 'm.room.member' && e.state_key !== USER)
      .map((e: PDU) => e.state_key);
    expect(newInviteKeys).toContain(DAVE);
    expect(newInviteKeys).not.toContain(BOB);
    expect(fedCalls.some((c) => c.url === '/invite')).toBe(true);
  });

  it('copies non-whitelisted state generically and leaves create/member/tombstone behind', async () => {
    seedState([
      pdu({ event_id: '$acl', type: 'm.room.server_acl', content: { allow_ip: ['*'], deny: ['evil.example'] } }),
      pdu({ event_id: '$alias', type: 'm.room.canonical_alias', content: { alias: '#main:example.com' } }),
      pdu({ event_id: '$tomb', type: 'm.room.tombstone', content: { replacement_room: '$elsewhere' } }),
    ]);

    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      { new_version: '11' }
    );
    expect(status).toBe(200);

    const newEvents = dbMocks.storeEvent.mock.calls
      .map((call: unknown[]) => call[1] as PDU)
      .filter((e: PDU) => e.room_id === NEW_ROOM);
    const acl = newEvents.find((e) => e.type === 'm.room.server_acl');
    expect(acl?.content).toEqual({ allow_ip: ['*'], deny: ['evil.example'] });
    expect(acl?.state_key).toBe('');
    expect(newEvents.find((e) => e.type === 'm.room.canonical_alias')?.content)
      .toEqual({ alias: '#main:example.com' });
    expect(newEvents.some((e) => e.type === 'm.room.tombstone')).toBe(false);
    const creates = newEvents.filter((e) => e.type === 'm.room.create');
    expect(creates).toHaveLength(1);
    expect(creates[0].content).toMatchObject({ predecessor: { room_id: ROOM } });
    // No copied old membership: the only join in the new room is the upgrader.
    expect(newEvents.filter((e) => e.type === 'm.room.member' && e.content?.membership === 'join')
      .map((e) => e.state_key)).toEqual([USER]);
  });

  it('zeroes every user power in the old room and federates the freeze', async () => {
    const fedCalls: FedCall[] = [];
    const { status } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/upgrade`,
      { new_version: '11' },
      createDb([DAVE]),
      fedCalls
    );
    expect(status).toBe(200);

    const restrict = dbMocks.storeEvent.mock.calls
      .map((call: unknown[]) => call[1] as PDU)
      .find((e: PDU) => e.room_id === ROOM && e.type === 'm.room.power_levels');
    expect(restrict?.content).toMatchObject({
      users: { [USER]: 0, [BOB]: 0 },
      events_default: 100,
      invite: 100,
      state_default: 100,
    });
    expect((restrict?.content as Record<string, unknown>).users).not.toMatchObject({ [USER]: 100 });

    const queuedFreeze = fedCalls.find(
      (c) => c.url === '/queue' &&
        c.payload.room_id === ROOM &&
        (c.payload.pdu as Record<string, unknown>)?.type === 'm.room.power_levels'
    );
    expect(queuedFreeze?.payload.destination).toBe('remote.example');
    expect((queuedFreeze?.payload.pdu as Record<string, unknown>)?.content).toMatchObject({
      users: { [USER]: 0, [BOB]: 0 },
      events_default: 100,
      state_default: 100,
    });
  });
});

describe('createRoom spec parameters', () => {
  it('merges creation_content but protects server-owned create fields', async () => {
    const db = createDb();
    const { status } = await request('/_matrix/client/v3/createRoom', {
      creation_content: {
        'm.federate': false,
        type: 'org.example.custom',
        room_version: '99',
        creator: '@evil:remote.example',
      },
    }, db);
    expect(status).toBe(200);
    expect(batchedEventContent(db, 'm.room.create')).toMatchObject({
      creator: USER,
      room_version: '10',
      'm.federate': false,
      type: 'org.example.custom',
    });
  });

  it('accepts the m.policy room type (spec v1.20, MSC3784)', async () => {
    const db = createDb();
    const { status } = await request(
      '/_matrix/client/v3/createRoom',
      { creation_content: { type: 'm.policy' } },
      db
    );
    expect(status).toBe(200);
    expect(batchedEventContent(db, 'm.room.create')).toMatchObject({ type: 'm.policy' });
  });

  it('merges power_level_content_override but keeps the creator at 100', async () => {
    const db = createDb();
    const { status } = await request('/_matrix/client/v3/createRoom', {
      power_level_content_override: {
        events: { 'm.room.custom': 42 },
        ban: 10,
        kick: 9,
        redact: 8,
        invite: 0,
        notifications: { room: 7 },
        users: { [BOB]: 50, [USER]: 1 },
        users_default: 5,
      },
    }, db);
    expect(status).toBe(200);
    const pl = batchedEventContent(db, 'm.room.power_levels');
    expect(pl).toMatchObject({
      ban: 10,
      kick: 9,
      redact: 8,
      invite: 0,
      users_default: 5,
      notifications: { room: 7 },
      users: { [USER]: 100, [BOB]: 50 },
    });
    expect((pl?.events as Record<string, number>)['m.room.custom']).toBe(42);
  });

  it('rejects non-object creation_content and power_level_content_override', async () => {
    for (const [field, value] of [
      ['creation_content', 'nope'],
      ['creation_content', ['nope']],
      ['creation_content', null],
      ['power_level_content_override', 42],
      ['power_level_content_override', []],
      ['power_level_content_override', null],
    ] as const) {
      const { status, body } = await request('/_matrix/client/v3/createRoom', { [field]: value });
      expect(status).toBe(400);
      expect(body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
    }
    expect(dbMocks.createRoom).not.toHaveBeenCalled();
  });
});
