/**
 * Federation /backfill and /get_missing_events parameter validation.
 *
 * /backfill requires `v`, every starting event must exist in the room, and
 * the limit is capped at 100. /get_missing_events caps `limit` at 10 and
 * requires both event arrays (empty arrays are still valid).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

import federation from '../src/api/federation';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_PATH = encodeURIComponent(ROOM);

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

const EVENTS: EventRow[] = Array.from({ length: 30 }, (_, i) => ({
  event_id: `$e${i + 1}:example.com`,
  room_id: ROOM,
  sender: '@alice:example.com',
  event_type: 'm.room.message',
  state_key: null,
  content: JSON.stringify({ body: String(i + 1) }),
  origin_server_ts: 1_700_000_000_000 + i,
  depth: i + 1,
  auth_events: '[]',
  prev_events: i === 0 ? '[]' : JSON.stringify([`$e${i}:example.com`]),
  hashes: null,
  signatures: null,
}));

const EVENT_BY_ID = new Map(EVENTS.map((e) => [e.event_id, e]));

function makeDb() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        async first<T>() {
          if (sql.includes('SELECT room_id, room_version FROM rooms')) {
            return (args[0] === ROOM
              ? { room_id: ROOM, room_version: '10' }
              : null) as T;
          }
          if (sql.includes('MIN(depth) as min_depth')) {
            const depths = (args as string[])
              .map((id) => EVENT_BY_ID.get(id)?.depth)
              .filter((d): d is number => d !== undefined);
            return { min_depth: depths.length ? Math.min(...depths) : 0 } as T;
          }
          if (
            sql.includes('FROM events') &&
            sql.includes('WHERE event_id = ?') &&
            sql.includes('AND room_id = ?') &&
            sql.includes('AND depth >= ?')
          ) {
            const [id, roomId, minDepth] = args as [string, string, number];
            const e = EVENT_BY_ID.get(id);
            return (e && e.room_id === roomId && e.depth >= minDepth ? e : null) as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes('COUNT(DISTINCT event_id) as found')) {
            const ids = args.slice(1) as string[];
            const found = ids.filter((id) => {
              const e = EVENT_BY_ID.get(id);
              return e && e.room_id === args[0];
            }).length;
            return { results: [{ found }] as T[] };
          }
          if (sql.includes('depth < ?') && sql.includes('ORDER BY depth DESC')) {
            const [roomId, maxDepth, limit] = args as [string, number, number];
            return {
              results: EVENTS
                .filter((e) => e.room_id === roomId && e.depth < maxDepth)
                .sort((a, b) => b.depth - a.depth)
                .slice(0, limit) as T[],
            };
          }
          if (sql.includes('FROM events') && sql.includes('ORDER BY depth DESC')) {
            const [roomId, limit] = args as [string, number];
            return {
              results: EVENTS
                .filter((e) => e.room_id === roomId)
                .sort((a, b) => b.depth - a.depth)
                .slice(0, limit) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { success: true };
        },
        bind(...bound: unknown[]) {
          args = bound;
          return stmt;
        },
      };
      return stmt;
    },
  };
}

function makeEnv() {
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  } as unknown as KVNamespace;
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: makeDb() as unknown as D1Database,
    SESSIONS: kv,
    CACHE: kv,
    ONE_TIME_KEYS: kv,
    USER_KEYS: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
    } as unknown as DurableObjectNamespace,
  } as Env;
}

async function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await federation.request(`http://localhost${path}`, init, makeEnv());
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : null,
  };
}

describe('federation /backfill validation', () => {
  it('rejects a missing or empty v with 400 M_MISSING_PARAM', async () => {
    for (const path of [
      `/_matrix/federation/v1/backfill/${ROOM_PATH}`,
      `/_matrix/federation/v1/backfill/${ROOM_PATH}?v=`,
    ]) {
      const res = await request('GET', path);
      expect(res.status).toBe(400);
      expect(res.body?.errcode).toBe('M_MISSING_PARAM');
    }
  });

  it('rejects an unknown starting event with 404 M_NOT_FOUND', async () => {
    const unknown = await request(
      'GET',
      `/_matrix/federation/v1/backfill/${ROOM_PATH}?v=${encodeURIComponent('$missing:example.com')}`
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body?.errcode).toBe('M_NOT_FOUND');

    const mixed = await request(
      'GET',
      `/_matrix/federation/v1/backfill/${ROOM_PATH}?v=${encodeURIComponent('$e5:example.com')},${encodeURIComponent('$missing:example.com')}`
    );
    expect(mixed.status).toBe(404);
  });

  it('returns historical events for a known v', async () => {
    const res = await request(
      'GET',
      `/_matrix/federation/v1/backfill/${ROOM_PATH}?v=${encodeURIComponent('$e5:example.com')}&limit=10`
    );
    expect(res.status).toBe(200);
    const pdus = res.body?.pdus as Array<{ depth: number }>;
    expect(pdus.length).toBeGreaterThan(0);
    expect(pdus.every((p) => p.depth < 5)).toBe(true);
  });
});

describe('federation /get_missing_events validation', () => {
  const path = `/_matrix/federation/v1/get_missing_events/${ROOM_PATH}`;

  it('caps limit at 10 even when the caller asks for 50', async () => {
    const res = await request('POST', path, {
      earliest_events: [],
      latest_events: ['$e30:example.com'],
      limit: 50,
    });
    expect(res.status).toBe(200);
    expect((res.body?.events as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('requires earliest_events and latest_events to be present', async () => {
    const missingEarliest = await request('POST', path, { latest_events: [] });
    expect(missingEarliest.status).toBe(400);
    expect(missingEarliest.body?.errcode).toBe('M_MISSING_PARAM');

    const missingLatest = await request('POST', path, { earliest_events: [] });
    expect(missingLatest.status).toBe(400);
    expect(missingLatest.body?.errcode).toBe('M_MISSING_PARAM');
  });

  it('accepts explicitly empty arrays', async () => {
    const res = await request('POST', path, { earliest_events: [], latest_events: [] });
    expect(res.status).toBe(200);
    expect(res.body?.events).toEqual([]);
  });
});
