// Outbound federation EDUs for local typing and receipt client actions.
// Harness mirrors the outbound m.presence EDU tests in presence-api-routes.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import typingApp from '../src/api/typing';
import receiptsApp from '../src/api/receipts';

const USER = '@alice:example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const REMOTE2 = 'other.example.net';
const EVENT = '$event1:example.com';
const THREAD = '$thread1:example.com';
const NOW = 1_700_000_000_000;

type Membership = { room_id: string; user_id: string; membership: string };
type FedFetch = { url: string; method: string; body: any };

function createFederationStub(opts: { fail?: boolean } = {}) {
  const fetches: FedFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (opts.fail) throw new Error('federation send-edu boom');
      return Response.json({ ok: true });
    },
  };
}

type FedStub = ReturnType<typeof createFederationStub>;

function createRoomDOStub() {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createDb(opts: {
  memberships?: Membership[];
  acl?: { allow?: string[]; deny?: string[]; allow_ip_literals?: boolean } | null;
} = {}) {
  const memberships = opts.memberships ?? [];
  const acl = opts.acl === undefined ? null : opts.acl;
  const accountData: Array<{ user_id: string; room_id: string; content: string }> = [];

  const db = {
    memberships,
    acl,
    accountData,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes('FROM room_state rs')) {
                if (!acl) return null;
                // getStateEvent() rebuilds a PDU from these fields.
                return {
                  event_id: '$acl:example.com',
                  room_id: ROOM,
                  sender: `@admin:${SERVER}`,
                  event_type: 'm.room.server_acl',
                  state_key: '',
                  content: JSON.stringify(acl),
                  origin_server_ts: 0,
                  unsigned: null,
                  depth: 1,
                  auth_events: '[]',
                  prev_events: '[]',
                } as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              if (sql.includes('SELECT DISTINCT user_id FROM room_memberships')) {
                const [roomId] = args as string[];
                const rows = memberships
                  .filter((m) => m.room_id === roomId && m.membership === 'join')
                  .map((m) => ({ user_id: m.user_id }));
                return { results: rows as T[] };
              }
              throw new Error(`Unhandled all() SQL: ${sql.slice(0, 140)}`);
            },
            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                const [userId, roomId, content] = args as [string, string, string];
                accountData.push({ user_id: userId, room_id: roomId, content });
                return { success: true };
              }
              throw new Error(`Unhandled run() SQL: ${sql.slice(0, 140)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type Db = ReturnType<typeof createDb>;

function createEnv(opts: { db?: Db; roomDO?: RoomDOStub; federation?: FedStub } = {}) {
  const db = opts.db ?? createDb();
  const roomDO = opts.roomDO ?? createRoomDOStub();
  const federation = opts.federation ?? createFederationStub();
  const fedByServer = new Map<string, FedStub>();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => roomDO,
    },
    FEDERATION: {
      idFromName: (name: string) => {
        if (!fedByServer.has(name)) fedByServer.set(name, federation);
        return { name, toString: () => name };
      },
      get: (id: { name: string }) => {
        if (!fedByServer.has(id.name)) fedByServer.set(id.name, federation);
        return fedByServer.get(id.name) ?? federation;
      },
    },
    _db: db,
    _roomDO: roomDO,
    _federation: federation,
  };
  return env as unknown as Env & typeof env;
}

async function requestTo(
  app: { request: (input: string, init?: RequestInit, env?: Env) => Promise<Response> },
  env: Env,
  path: string,
  init: RequestInit
) {
  const res = await app.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function sharedRoomMemberships(servers: string[] = [REMOTE]): Membership[] {
  return [
    { room_id: ROOM, user_id: USER, membership: 'join' },
    ...servers.map((s) => ({ room_id: ROOM, user_id: `@remote:${s}`, membership: 'join' })),
  ];
}

function typingPath(userId = USER) {
  return `/_matrix/client/v3/rooms/${ROOM_ENC}/typing/${encodeURIComponent(userId)}`;
}

function receiptPath(type: string, eventId = EVENT) {
  return `/_matrix/client/v3/rooms/${ROOM_ENC}/receipt/${encodeURIComponent(type)}/${encodeURIComponent(eventId)}`;
}

const markersPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`;

function edusFor(federation: FedStub) {
  return federation.fetches.map((f) => ({
    url: f.url,
    method: f.method,
    destination: f.body.destination as string,
    edu_type: f.body.edu_type as string,
    content: f.body.content,
  }));
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('outbound m.typing EDUs', () => {
  it('queues the exact wire shape to each distinct remote server, excluding local', async () => {
    const db = createDb({
      memberships: [
        ...sharedRoomMemberships([REMOTE, REMOTE2, SERVER]),
        { room_id: ROOM, user_id: `@second:${REMOTE}`, membership: 'join' },
      ],
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    const res = await requestTo(typingApp, env, typingPath(), jsonInit('PUT', { typing: true, timeout: 1000 }));
    expect(res.status).toBe(200);

    const edus = edusFor(federation);
    expect(edus.map((e) => e.destination).sort()).toEqual([REMOTE2, REMOTE].sort());
    for (const edu of edus) {
      expect(edu.method).toBe('POST');
      expect(edu.url).toContain('/send-edu');
      expect(edu.edu_type).toBe('m.typing');
      expect(edu.content).toEqual({ room_id: ROOM, user_id: USER, typing: true });
    }
  });

  it('queues typing:false on stop, with no timeout field', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships() }),
      federation,
    });

    const res = await requestTo(typingApp, env, typingPath(), jsonInit('PUT', { typing: false }));
    expect(res.status).toBe(200);
    expect(edusFor(federation)).toEqual([
      expect.objectContaining({
        destination: REMOTE,
        edu_type: 'm.typing',
        content: { room_id: ROOM, user_id: USER, typing: false },
      }),
    ]);
  });

  it('queues nothing for a pure-local room', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships([]) }),
      federation,
    });

    const res = await requestTo(typingApp, env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(200);
    expect(federation.fetches).toHaveLength(0);
  });

  it('does not fail the client when federation queueing throws', async () => {
    const federation = createFederationStub({ fail: true });
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships() }),
      federation,
    });

    const res = await requestTo(typingApp, env, typingPath(), jsonInit('PUT', { typing: true }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._roomDO.fetches).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('outbound m.receipt EDUs', () => {
  it('queues m.read with the exact wire shape for the event and user', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships([REMOTE, REMOTE2]) }),
      federation,
    });

    const res = await requestTo(receiptsApp, env, receiptPath('m.read'), jsonInit('POST'));
    expect(res.status).toBe(200);

    const edus = edusFor(federation);
    expect(edus.map((e) => e.destination).sort()).toEqual([REMOTE2, REMOTE].sort());
    for (const edu of edus) {
      expect(edu.url).toContain('/send-edu');
      expect(edu.edu_type).toBe('m.receipt');
      expect(edu.content).toEqual({
        room_id: ROOM,
        content: { [EVENT]: { 'm.read': { [USER]: { ts: NOW } } } },
      });
    }
  });

  it('includes thread_id when supplied on a receipt PUT', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships() }),
      federation,
    });

    const res = await requestTo(
      receiptsApp,
      env,
      receiptPath('m.read'),
      jsonInit('POST', { thread_id: THREAD })
    );
    expect(res.status).toBe(200);
    expect(edusFor(federation)[0].content).toEqual({
      room_id: ROOM,
      content: {
        [EVENT]: { 'm.read': { [USER]: { ts: NOW, thread_id: THREAD } } },
      },
    });
  });

  it('never federates m.read.private or m.fully_read', async () => {
    for (const type of ['m.read.private', 'm.fully_read']) {
      const federation = createFederationStub();
      const env = createEnv({
        db: createDb({ memberships: sharedRoomMemberships() }),
        federation,
      });

      const res = await requestTo(receiptsApp, env, receiptPath(type), jsonInit('POST'));
      expect(res.status).toBe(200);
      expect(federation.fetches).toHaveLength(0);
    }
  });

  it('queues m.read from read_markers but not m.read.private', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships() }),
      federation,
    });

    const res = await requestTo(
      receiptsApp,
      env,
      markersPath,
      jsonInit('POST', {
        'm.fully_read': EVENT,
        'm.read': EVENT,
        'm.read.private': EVENT,
      })
    );
    expect(res.status).toBe(200);

    const edus = edusFor(federation);
    expect(edus).toHaveLength(1);
    expect(edus[0].edu_type).toBe('m.receipt');
    expect(edus[0].content).toEqual({
      room_id: ROOM,
      content: { [EVENT]: { 'm.read': { [USER]: { ts: NOW } } } },
    });
  });

  it('excludes servers denied by the room ACL', async () => {
    const db = createDb({
      memberships: sharedRoomMemberships([REMOTE, REMOTE2]),
      acl: { allow: [SERVER, REMOTE], deny: [] },
    });
    const federation = createFederationStub();
    const env = createEnv({ db, federation });

    const res = await requestTo(receiptsApp, env, receiptPath('m.read'), jsonInit('POST'));
    expect(res.status).toBe(200);
    expect(edusFor(federation).map((e) => e.destination)).toEqual([REMOTE]);
  });

  it('queues nothing when no remote members share the room', async () => {
    const federation = createFederationStub();
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships([]) }),
      federation,
    });

    const res = await requestTo(receiptsApp, env, receiptPath('m.read'), jsonInit('POST'));
    expect(res.status).toBe(200);
    expect(federation.fetches).toHaveLength(0);
  });

  it('does not fail the client when federation queueing throws', async () => {
    const federation = createFederationStub({ fail: true });
    const env = createEnv({
      db: createDb({ memberships: sharedRoomMemberships() }),
      federation,
    });

    const res = await requestTo(receiptsApp, env, receiptPath('m.read'), jsonInit('POST'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(env._db.accountData).toHaveLength(1);
    expect(console.warn).toHaveBeenCalled();
  });
});
