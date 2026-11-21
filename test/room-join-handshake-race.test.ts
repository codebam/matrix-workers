// The /join → send_join gap: locally written events had no federation
// destination yet, so the standard send path never queued them. These tests
// pin the durable re-sweep step in RoomJoinWorkflow that closes that window.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const storeEvent = vi.fn(async () => 1);
const storeEventIdempotent = vi.fn(async () => ({ inserted: true }));
const updateMembership = vi.fn(async () => undefined);
const getRoomMembers = vi.fn(async () => [] as Array<{ userId: string }>);
const getStateEvent = vi.fn(async () => null as { event_id: string } | null);
const getRoomEvents = vi.fn(async () => ({ events: [] as Array<{ event_id: string; depth: number }> }));
const getMembership = vi.fn(async () => null as { membership: string; eventId: string } | null);

vi.mock('../src/services/database', () => ({
  storeEvent: (...args: unknown[]) => storeEvent(...args),
  storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
  updateMembership: (...args: unknown[]) => updateMembership(...args),
  getRoomMembers: (...args: unknown[]) => getRoomMembers(...args),
  getStateEvent: (...args: unknown[]) => getStateEvent(...args),
  getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
  getMembership: (...args: unknown[]) => getMembership(...args),
}));

const template = {
  room_version: '12',
  event: {
    room_id: '!room:example.com',
    sender: '@alice:example.com',
    state_key: '@alice:example.com',
    type: 'm.room.member',
    content: { membership: 'join' },
    auth_events: ['$auth:example.com'],
    prev_events: ['$prev:example.com'],
    depth: 4,
  },
};
const federationGet = vi.fn(async () => new Response(JSON.stringify(template), { status: 200 }));
const federationPut = vi.fn(async () => new Response(JSON.stringify({ state: [], auth_chain: [] }), { status: 200 }));
const getServerSigningKey = vi.fn(async () => ({ keyId: 'ed25519:test', privateKeyJwk: {} }));

vi.mock('../src/services/federation-keys', () => ({
  federationGet: (...args: unknown[]) => federationGet(...args),
  federationPut: (...args: unknown[]) => federationPut(...args),
  getServerSigningKey: (...args: unknown[]) => getServerSigningKey(...args),
}));

vi.mock('../src/utils/crypto', () => ({
  calculateContentHash: vi.fn(async () => 'hash'),
  signJson: vi.fn(async (obj: Record<string, unknown>) => ({
    ...obj,
    signatures: { 'example.com': { 'ed25519:test': 'sig' } },
  })),
}));

vi.mock('../src/utils/event-signing', () => ({
  computeWireEventId: vi.fn(async () => '$wire:join'),
  redactEventForSigning: vi.fn((e: Record<string, unknown>) => e),
  toWireEventObject: vi.fn((e: Record<string, unknown>) => {
    const wire = { ...e };
    delete wire['event_id'];
    return wire;
  }),
  isMsc4291RoomVersion: vi.fn((v: string) => v === '12'),
}));

const deriveRoomWireEvents = vi.fn();
const wireForRoom = vi.fn();
const prepareOutboundPdu = vi.fn();
vi.mock('../src/services/event-wire', () => ({
  deriveRoomWireEvents: (...args: unknown[]) => deriveRoomWireEvents(...args),
  wireForRoom: (...args: unknown[]) => wireForRoom(...args),
  prepareOutboundPdu: (...args: unknown[]) => prepareOutboundPdu(...args),
}));

import { RoomJoinWorkflow } from '../src/workflows/RoomJoinWorkflow';

const ROOM = '!room:example.com';
const USER = '@alice:example.com';
const RESIDENT = 'remote.example';

type Row = Record<string, unknown>;

const residentMessage: Row = {
  event_id: '$resident:example.com',
  room_id: ROOM,
  sender: '@bob:example.com',
  event_type: 'm.room.message',
  state_key: null,
  content: JSON.stringify({ msgtype: 'm.text', body: 'sent during the race' }),
  origin_server_ts: 1_700_000_000_100,
  depth: 9,
  auth_events: JSON.stringify(['$auth:example.com']),
  prev_events: JSON.stringify(['$prev:example.com']),
  hashes: null,
  signatures: null,
};

const wireMessage = {
  type: 'm.room.message',
  room_id: ROOM,
  sender: '@bob:example.com',
  content: { msgtype: 'm.text', body: 'sent during the race' },
  origin_server_ts: residentMessage.origin_server_ts,
  depth: 9,
  auth_events: ['$auth-wire:example.com'],
  prev_events: ['$prev-wire:example.com'],
};
const wireRoom = {
  idMap: new Map<string, string>([['$resident:example.com', '$wire-message:example.com']]),
  wireById: new Map<string, Record<string, unknown>>([
    ['$resident:example.com', wireMessage],
    ['$wire-message:example.com', wireMessage],
  ]),
};

function createDb(
  rows: Row[] = [],
  opts: { roomVersion?: string; creator?: string } = {}
) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    queries,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          queries.push({ sql, args });
          return {
            async all<T>() {
              if (sql.includes('sender LIKE ?') && sql.includes('stream_ordering > ?')) {
                return { results: rows } as T;
              }
              return { results: [] } as T;
            },
            async first<T>() {
              if (sql.includes('FROM rooms')) {
                return { room_version: opts.roomVersion ?? '12' } as T;
              }
              if (sql.includes("rs.event_type = 'm.room.create'")) {
                return { sender: opts.creator ?? '@creator:example.com' } as T;
              }
              return null as T;
            },
          };
        },
      };
    },
  };
  return db;
}

function createEnv(db: ReturnType<typeof createDb>, fetchImpl: (req: Request) => Promise<Response>) {
  const fetches: Request[] = [];
  return {
    DB: db,
    CACHE: {},
    SERVER_NAME: 'example.com',
    FEDERATION: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        async fetch(req: Request) {
          fetches.push(req);
          expect(id).toBe(RESIDENT);
          return fetchImpl(req);
        },
      }),
    },
    fetches,
  };
}

function stepRunner() {
  const names: string[] = [];
  return {
    names,
    async do(name: string, optsOrFn: unknown, maybeFn?: unknown) {
      names.push(name);
      const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
      return (fn as () => Promise<unknown>)();
    },
  };
}

function runJoin(env: ReturnType<typeof createEnv>, sinceStreamOrdering?: number) {
  const step = stepRunner();
  const wf = new RoomJoinWorkflow({} as any, env as any);
  return {
    step,
    result: wf.run({
      payload: {
        roomId: ROOM,
        userId: USER,
        isRemote: true,
        remoteServer: RESIDENT,
        sinceStreamOrdering,
      },
    } as any, step as any),
  };
}

describe('RoomJoinWorkflow closes the /join handshake race', () => {
  beforeEach(() => {
    storeEvent.mockClear();
    storeEventIdempotent.mockClear();
    updateMembership.mockClear();
    federationGet.mockClear();
    federationPut.mockClear();
    deriveRoomWireEvents.mockReset();
    wireForRoom.mockReset();
    prepareOutboundPdu.mockReset();
    deriveRoomWireEvents.mockResolvedValue(wireRoom);
    getRoomMembers.mockResolvedValue([]);
    getStateEvent.mockResolvedValue(null);
    getRoomEvents.mockResolvedValue({ events: [] });
    getMembership.mockResolvedValue(null);
  });

  it('re-sweeps a resident message sent after /join 200 to the joined server', async () => {
    const db = createDb([residentMessage]);
    const env = createEnv(db, async () => new Response('queued'));
    const { step, result } = runJoin(env, 41);

    expect((await result).success).toBe(true);
    expect(step.names).toContain('resweep-recent-events');
    // The sweep runs only after the handshake and membership registration.
    expect(step.names.indexOf('send-join')).toBeLessThan(step.names.indexOf('resweep-recent-events'));
    expect(step.names.indexOf('persist')).toBeLessThan(step.names.indexOf('resweep-recent-events'));

    const sweep = db.queries.find((q) => q.sql.includes('sender LIKE ?'));
    expect(sweep?.args).toEqual([ROOM, 41, '%:example.com', '$wire:join', 200]);
    expect(deriveRoomWireEvents).toHaveBeenCalledWith(env, ROOM, '12');

    expect(env.fetches).toHaveLength(1);
    const body = await env.fetches[0].json() as {
      destination: string; event_id: string; room_id: string; pdu: Record<string, unknown>;
    };
    expect(body.destination).toBe(RESIDENT);
    expect(body.event_id).toBe('$wire-message:example.com');
    expect(body.room_id).toBe(ROOM);
    expect(body.pdu).toEqual(wireMessage);
  });

  it('excludes already-delivered events and the join event itself from the sweep', async () => {
    const db = createDb([]);
    const env = createEnv(db, async () => new Response('queued'));
    const { result } = runJoin(env, 77);

    expect((await result).success).toBe(true);
    const sweep = db.queries.find((q) => q.sql.includes('sender LIKE ?'));
    expect(sweep?.args[1]).toBe(77);
    expect(sweep?.args[2]).toBe('%:example.com');
    expect(sweep?.args[3]).toBe('$wire:join');
    expect(env.fetches).toHaveLength(0);
  });

  it('survives a DO queue timeout without failing the accepted join', async () => {
    const db = createDb([residentMessage]);
    const env = createEnv(db, async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const { result } = runJoin(env, 5);

    const joined = await result;
    expect(joined.success).toBe(true);
    expect(joined.eventId).toBe('$wire:join');
    expect(env.fetches).toHaveLength(1);
  });

  it('does not add a sweep step when no /join watermark was supplied', async () => {
    const env = createEnv(createDb([residentMessage]), async () => new Response('queued'));
    const { step, result } = runJoin(env);

    expect((await result).success).toBe(true);
    expect(step.names).not.toContain('resweep-recent-events');
    expect(env.fetches).toHaveLength(0);
  });

  it('uses the as-stored serving form for a legacy remote-created room', async () => {
    const legacyDb = createDb([residentMessage], {
      roomVersion: '9',
      creator: '@someone:remote.org',
    });
    wireForRoom.mockResolvedValue(null);
    const env = createEnv(legacyDb, async () => new Response('queued'));
    const { step, result } = runJoin(env, 9);

    expect((await result).success).toBe(true);
    expect(step.names).toContain('resweep-recent-events');
    expect(deriveRoomWireEvents).not.toHaveBeenCalled();
    expect(wireForRoom).toHaveBeenCalledWith(env, ROOM, '9');
    expect(env.fetches).toHaveLength(0);
  });
});
