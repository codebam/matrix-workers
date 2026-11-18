/**
 * Public rooms directory (Matrix v1.17): GET query params, POST filter body,
 * pagination tokens, member-count ordering, directory metadata, and remote
 * `server` passthrough over federation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitType: () => 'default',
  getClientId: () => 'unknown',
  RATE_LIMITS: {},
}));

vi.mock('hono/logger', () => ({
  logger: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/middleware/analytics', () => ({
  analyticsMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
  optionalAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      await next();
    };
  },
  extractAccessToken: () => 'test-token',
  validateAccessToken: async () => ({ userId: '@alice:example.com', deviceId: 'DEVICE' }),
}));

vi.mock('../src/durable-objects', () => ({
  RoomDurableObject: class {},
  SyncDurableObject: class {},
  FederationDurableObject: class {},
  CallRoomDurableObject: class {},
  AdminDurableObject: class {},
  UserKeysDurableObject: class {},
  PushDurableObject: class {},
  RateLimitDurableObject: class {},
}));

vi.mock('../src/workflows', () => ({
  RoomJoinWorkflow: class {},
  PushNotificationWorkflow: class {},
  FederationCatchupWorkflow: class {},
  MediaCleanupWorkflow: class {},
  StateCompactionWorkflow: class {},
}));

const fedMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return { ...actual, federationGet: fedMocks.get, federationPost: fedMocks.post };
});

import app from '../src/index';

const SERVER = 'example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';
const ROOM_S = '!s:example.com';

interface StateRow { room_id: string; event_type: string; content: string }

function createDb() {
  const rooms = [
    { room_id: ROOM_A, room_version: '10', is_public: 1 },
    { room_id: ROOM_B, room_version: '10', is_public: 1 },
    { room_id: ROOM_S, room_version: '10', is_public: 1 },
    { room_id: '!private:example.com', room_version: '10', is_public: 0 },
  ];
  const memberCounts: Record<string, number> = {
    [ROOM_A]: 2,
    [ROOM_B]: 5,
    [ROOM_S]: 1,
  };
  const state: StateRow[] = [
    { room_id: ROOM_A, event_type: 'm.room.name', content: JSON.stringify({ name: 'Alpha' }) },
    { room_id: ROOM_A, event_type: 'm.room.topic', content: JSON.stringify({ topic: 'first letter' }) },
    { room_id: ROOM_A, event_type: 'm.room.canonical_alias', content: JSON.stringify({ alias: '#alpha:example.com' }) },
    { room_id: ROOM_A, event_type: 'm.room.history_visibility', content: JSON.stringify({ history_visibility: 'world_readable' }) },
    { room_id: ROOM_A, event_type: 'm.room.guest_access', content: JSON.stringify({ guest_access: 'can_join' }) },
    { room_id: ROOM_A, event_type: 'm.room.join_rules', content: JSON.stringify({ join_rule: 'public' }) },
    { room_id: ROOM_B, event_type: 'm.room.name', content: JSON.stringify({ name: 'Beta' }) },
    { room_id: ROOM_B, event_type: 'm.room.avatar', content: JSON.stringify({ url: 'mxc://example.com/beta' }) },
    { room_id: ROOM_S, event_type: 'm.room.name', content: JSON.stringify({ name: 'Space Room' }) },
    { room_id: ROOM_S, event_type: 'm.room.create', content: JSON.stringify({ room_version: '10', type: 'm.space' }) },
  ];

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes("rs.event_type = 'm.room.name'")) {
          const row = state.find(s => s.room_id === args[0] && s.event_type === 'm.room.name');
          return (row ? { content: row.content } : null) as T | null;
        }
        if (sql.includes("rs.event_type = 'm.room.topic'")) {
          const row = state.find(s => s.room_id === args[0] && s.event_type === 'm.room.topic');
          return (row ? { content: row.content } : null) as T | null;
        }
        if (sql.includes('COUNT(*) as count FROM room_memberships')) {
          return { count: memberCounts[args[0] as string] ?? 0 } as T;
        }
        return null as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes('FROM rooms r') && sql.includes('is_public = 1')) {
          return {
            results: rooms
              .filter(r => r.is_public === 1)
              .map(r => ({ room_id: r.room_id, room_version: r.room_version })) as T[],
          };
        }
        if (sql.includes('rs.event_type IN')) {
          return {
            results: state
              .filter(s => s.room_id === args[0])
              .map(s => ({ event_type: s.event_type, content: s.content })) as T[],
          };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };

  return { prepare: (sql: string) => stmt(sql) };
}

function envFor(): Env {
  return {
    SERVER_NAME: SERVER,
    DB: createDb() as unknown as D1Database,
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace,
  } as unknown as Env;
}

async function request(path: string, init: RequestInit = {}) {
  const res = await app.request(`http://localhost${path}`, init, envFor());
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function post(body: unknown) {
  return request('/_matrix/client/v3/publicRooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fedMocks.get.mockReset();
  fedMocks.post.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /publicRooms ordering and metadata', () => {
  it('sorts by joined member count (largest first) and exposes directory metadata', async () => {
    const { status, body } = await request('/_matrix/client/v3/publicRooms');
    expect(status).toBe(200);
    expect(body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_B, ROOM_A, ROOM_S]);
    expect(body.total_room_count_estimate).toBe(3);

    const alpha = body.chunk.find((r: any) => r.room_id === ROOM_A);
    expect(alpha.name).toBe('Alpha');
    expect(alpha.topic).toBe('first letter');
    expect(alpha.canonical_alias).toBe('#alpha:example.com');
    expect(alpha.world_readable).toBe(true);
    expect(alpha.guest_can_join).toBe(true);
    expect(alpha.join_rule).toBe('public');

    const beta = body.chunk.find((r: any) => r.room_id === ROOM_B);
    expect(beta.avatar_url).toBe('mxc://example.com/beta');
    expect(beta.world_readable).toBe(false);
    expect(beta.guest_can_join).toBe(false);

    const space = body.chunk.find((r: any) => r.room_id === ROOM_S);
    expect(space.room_type).toBe('m.space');
  });
});

describe('GET /publicRooms pagination', () => {
  it('limit + since walk the directory with next_batch/prev_batch', async () => {
    const page1 = await request('/_matrix/client/v3/publicRooms?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_B, ROOM_A]);
    expect(page1.body.total_room_count_estimate).toBe(3);
    expect(typeof page1.body.next_batch).toBe('string');
    expect(page1.body.prev_batch).toBeUndefined();

    const page2 = await request(`/_matrix/client/v3/publicRooms?limit=2&since=${page1.body.next_batch}`);
    expect(page2.status).toBe(200);
    expect(page2.body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_S]);
    expect(page2.body.next_batch).toBeUndefined();
    expect(typeof page2.body.prev_batch).toBe('string');

    const back = await request(`/_matrix/client/v3/publicRooms?limit=2&since=${page2.body.prev_batch}`);
    expect(back.body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_B, ROOM_A]);
  });

  it('tolerates a malformed since token by starting at the beginning', async () => {
    const { status, body } = await request('/_matrix/client/v3/publicRooms?since=not-a-token');
    expect(status).toBe(200);
    expect(body.chunk).toHaveLength(3);
  });
});

describe('publicRooms remote server passthrough', () => {
  it('GET server=remote proxies over federationGet and passes the response through', async () => {
    fedMocks.get.mockResolvedValue(new Response(JSON.stringify({ chunk: [{ room_id: '!remote:other.org' }], total_room_count_estimate: 1 }), { status: 200 }));
    const { status, body } = await request('/_matrix/client/v3/publicRooms?server=other.org&limit=5');
    expect(status).toBe(200);
    expect(body.chunk[0].room_id).toBe('!remote:other.org');
    expect(fedMocks.get).toHaveBeenCalledTimes(1);
    const [serverName, path, origin] = fedMocks.get.mock.calls[0];
    expect(serverName).toBe('other.org');
    expect(path).toContain('/_matrix/federation/v1/publicRooms?');
    expect(path).toContain('limit=5');
    expect(origin).toBe(SERVER);
  });

  it('POST server=remote proxies the filter body over federationPost', async () => {
    fedMocks.post.mockResolvedValue(new Response(JSON.stringify({ chunk: [], total_room_count_estimate: 0 }), { status: 200 }));
    const filterBody = { limit: 3, filter: { generic_search_term: 'foo' } };
    const { status } = await request('/_matrix/client/v3/publicRooms?server=other.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filterBody),
    });
    expect(status).toBe(200);
    expect(fedMocks.post).toHaveBeenCalledTimes(1);
    const [serverName, path, body, origin] = fedMocks.post.mock.calls[0];
    expect(serverName).toBe('other.org');
    expect(path).toBe('/_matrix/federation/v1/publicRooms');
    expect(body).toEqual(filterBody);
    expect(origin).toBe(SERVER);
  });

  it('answers 502 when the remote directory query fails', async () => {
    fedMocks.get.mockRejectedValue(new Error('connection refused'));
    const { status, body } = await request('/_matrix/client/v3/publicRooms?server=other.org');
    expect(status).toBe(502);
    expect(body.errcode).toBe('M_UNKNOWN');
  });

  it('server equal to the local name is served locally', async () => {
    const { status, body } = await request(`/_matrix/client/v3/publicRooms?server=${SERVER}`);
    expect(status).toBe(200);
    expect(body.total_room_count_estimate).toBe(3);
    expect(fedMocks.get).not.toHaveBeenCalled();
  });
});

describe('POST /publicRooms filters', () => {
  it('room_types selects typed rooms', async () => {
    const { status, body } = await post({ filter: { room_types: ['m.space'] } });
    expect(status).toBe(200);
    expect(body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_S]);
    expect(body.total_room_count_estimate).toBe(1);
  });

  it('room_types [null, "m.space"] selects untyped and space rooms', async () => {
    const { body } = await post({ filter: { room_types: [null, 'm.space'] } });
    expect(body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_B, ROOM_A, ROOM_S]);
  });

  it('generic_search_term matches topic and canonical alias', async () => {
    const topic = await post({ filter: { generic_search_term: 'first letter' } });
    expect(topic.body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_A]);
    const alias = await post({ filter: { generic_search_term: '#alpha' } });
    expect(alias.body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_A]);
  });

  it('limit applies after filtering', async () => {
    const { body } = await post({ limit: 1, filter: { room_types: [null] } });
    expect(body.chunk.map((r: any) => r.room_id)).toEqual([ROOM_B]);
    expect(body.total_room_count_estimate).toBe(2);
    expect(typeof body.next_batch).toBe('string');
  });
});