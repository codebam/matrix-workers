import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const getMembership = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...args: unknown[]) => getMembership(...args),
  };
});

import rooms from '../src/api/rooms';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const NOW = 1_700_000_000_000;

type TsEvent = { event_id: string; origin_server_ts: number; room_id: string };

function createSqlDb(tsEvents: TsEvent[] = []) {
  const selects: Array<{ sql: string; args: unknown[] }> = [];
  return {
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('origin_server_ts >= ?')) {
                const [roomId, ts] = args as [string, number];
                const hit = tsEvents
                  .filter((e) => e.room_id === roomId && e.origin_server_ts >= ts)
                  .sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }
              if (sql.includes('origin_server_ts <= ?')) {
                const [roomId, ts] = args as [string, number];
                const hit = tsEvents
                  .filter((e) => e.room_id === roomId && e.origin_server_ts <= ts)
                  .sort((a, b) => b.origin_server_ts - a.origin_server_ts)[0];
                return (hit
                  ? { event_id: hit.event_id, origin_server_ts: hit.origin_server_ts }
                  : null) as T;
              }
              return null as T;
            },
          };
        },
      };
    },
  };
}

type SqlDb = ReturnType<typeof createSqlDb>;

function mockKv() {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function envFor(db: SqlDb): Env {
  return {
    DB: db as unknown as D1Database,
    CACHE: mockKv(),
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function request(path: string, db: SqlDb = createSqlDb()) {
  const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  const res = await rooms.request(`http://localhost${path}`, {}, envFor(db), execCtx as never);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  getMembership.mockReset().mockResolvedValue({ membership: 'join', eventId: '$alice-join' });
});

describe('GET timestamp_to_event on the spec v1 path', () => {
  it('returns the closest event for a member', async () => {
    const db = createSqlDb([
      { event_id: '$early', origin_server_ts: NOW - 100, room_id: ROOM },
      { event_id: '$late', origin_server_ts: NOW + 100, room_id: ROOM },
    ]);
    const { status, body } = await request(
      `/_matrix/client/v1/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`,
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$late', origin_server_ts: NOW + 100 });
  });

  it('returns 404 for an unknown room with no matching events', async () => {
    const unknownRoom = encodeURIComponent('!missing:example.com');
    const { status, body } = await request(
      `/_matrix/client/v1/rooms/${unknownRoom}/timestamp_to_event?ts=${NOW}&dir=f`
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('returns 403 for a non-member', async () => {
    getMembership.mockResolvedValueOnce(null);
    const db = createSqlDb([
      { event_id: '$late', origin_server_ts: NOW + 100, room_id: ROOM },
    ]);
    const { status, body } = await request(
      `/_matrix/client/v1/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=f`,
      db
    );
    expect(status).toBe(403);
    expect(body).toMatchObject({ errcode: 'M_FORBIDDEN' });
  });
});

describe('GET timestamp_to_event on the legacy v3 path', () => {
  it('still serves the legacy route', async () => {
    const db = createSqlDb([
      { event_id: '$early', origin_server_ts: NOW - 100, room_id: ROOM },
    ]);
    const { status, body } = await request(
      `/_matrix/client/v3/rooms/${ROOM_ENC}/timestamp_to_event?ts=${NOW}&dir=b`,
      db
    );
    expect(status).toBe(200);
    expect(body).toEqual({ event_id: '$early', origin_server_ts: NOW - 100 });
  });
});
