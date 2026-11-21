/**
 * Targeted conformance tests for client-server pagination parameters:
 * /messages `to` + `filter`, /context `before`/`after`, /members `at`, and
 * space hierarchy `from` cursor pagination.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../src/types';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!space:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const EVENT = '$target:example.com';
const EVENT_ENC = encodeURIComponent(EVENT);
const NOW = 1_700_000_000_000;

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
}));

const getMembership = vi.fn();
const getRoomEvents = vi.fn();
const getEvent = vi.fn();
const getRoomState = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...args: unknown[]) => getMembership(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    getEvent: (...args: unknown[]) => getEvent(...args),
    getRoomState: (...args: unknown[]) => getRoomState(...args),
  };
});

import rooms from '../src/api/rooms';
import spaces from '../src/api/spaces';

type SqlCall = { sql: string; args: unknown[] };
type AllHandler = (sql: string, args: unknown[]) => unknown[];
type FirstHandler = (sql: string, args: unknown[]) => unknown | null;

function makeDb(all: AllHandler = () => [], first: FirstHandler = () => null) {
  const calls: SqlCall[] = [];
  const handle = (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    return { sql, args };
  };
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              const hit = handle(sql, args);
              return { results: all(hit.sql, hit.args) as T[] };
            },
            async first<T>() {
              const hit = handle(sql, args);
              return first(hit.sql, hit.args) as T | null;
            },
          };
        },
      };
    },
  };
}

type Db = ReturnType<typeof makeDb>;

function envFor(db: Db): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    CACHE: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true }),
    },
  } as unknown as Env;
}

async function request(
  app: { request: (...args: unknown[]) => Promise<Response> },
  path: string,
  db: Db
): Promise<{ status: number; body: any }> {
  const res = await app.request(`http://localhost${path}`, {
    headers: { Authorization: 'Bearer test-token' },
  }, envFor(db));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function timelineEvent(id: string, type: string, sender: string, content: Record<string, unknown> = {}) {
  return {
    event_id: id,
    room_id: ROOM,
    sender,
    type,
    content,
    origin_server_ts: 1,
    state_key: undefined,
    unsigned: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMembership.mockResolvedValue({ membership: 'join', eventId: '$join' });
  getRoomEvents.mockResolvedValue({ events: [], end: 0 });
  getEvent.mockResolvedValue(null);
  getRoomState.mockResolvedValue([]);
});

describe('GET /messages pagination params', () => {
  const prefix = `/_matrix/client/v3/rooms/${ROOM_ENC}/messages`;

  it('to stops backward pagination at the exclusive stream position', async () => {
    const positions: Record<string, number> = {
      '$e99': 99, '$e98': 98, '$e97': 97, '$e96': 96,
    };
    const db = makeDb((sql, args) => {
      if (sql.includes('SELECT event_id, stream_ordering FROM events')) {
        return args.map((id) => ({ event_id: id, stream_ordering: positions[id as string] ?? null }));
      }
      return [];
    });
    getRoomEvents.mockResolvedValue({
      events: [
        timelineEvent('$e99', 'm.room.message', USER),
        timelineEvent('$e98', 'm.room.message', USER),
        timelineEvent('$e97', 'm.room.message', USER),
        timelineEvent('$e96', 'm.room.message', USER),
      ],
      end: 96,
    });

    const { status, body } = await request(rooms, `${prefix}?dir=b&from=s100&to=s97&limit=10`, db);

    expect(status).toBe(200);
    expect(getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, 100, 2, 'b');
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$e99', '$e98']);
  });

  it('to bounds forward pagination without a from token', async () => {
    const positions: Record<string, number> = { '$e1': 1, '$e2': 2, '$e3': 3, '$e4': 4, '$e5': 5 };
    const db = makeDb((sql, args) => {
      if (sql.includes('SELECT event_id, stream_ordering FROM events')) {
        return args.map((id) => ({ event_id: id, stream_ordering: positions[id as string] ?? null }));
      }
      return [];
    });
    getRoomEvents.mockResolvedValue({
      events: [1, 2, 3, 4, 5].map((n) => timelineEvent(`$e${n}`, 'm.room.message', USER)),
      end: 5,
    });

    const { status, body } = await request(rooms, `${prefix}?dir=f&to=4&limit=10`, db);

    expect(status).toBe(200);
    expect(getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, undefined, 3, 'f');
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$e1', '$e2', '$e3']);
  });

  it('applies types/not_types, senders/not_senders, rooms/not_rooms and contains_url', async () => {
    getRoomEvents.mockResolvedValue({
      events: [
        timelineEvent('$keep', 'm.room.message', USER, { url: 'mxc://example.com/a' }),
        timelineEvent('$img', 'm.room.image', USER, { url: 'mxc://example.com/b' }),
        timelineEvent('$bob', 'm.room.message', BOB, { url: 'mxc://example.com/c' }),
        timelineEvent('$carol', 'm.room.message', '@carol:example.com', { url: 'mxc://example.com/d' }),
        timelineEvent('$plain', 'm.room.message', USER, { body: 'no url' }),
      ],
      end: 100,
    });
    const filter = {
      types: ['m.room.*'],
      not_types: ['m.room.image'],
      senders: [USER, BOB],
      not_senders: [BOB],
      rooms: [ROOM],
      not_rooms: ['!other:example.com'],
      contains_url: true,
      unrecognized_key: 'ignored',
    };

    const { status, body } = await request(
      rooms,
      `${prefix}?dir=b&filter=${encodeURIComponent(JSON.stringify(filter))}`,
      makeDb()
    );

    expect(status).toBe(200);
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$keep']);
  });

  it('rejects malformed filter JSON with M_BAD_JSON', async () => {
    const { status, body } = await request(rooms, `${prefix}?filter=%7Bnot-json`, makeDb());
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_BAD_JSON');
    expect(getRoomEvents).not.toHaveBeenCalled();
  });

  it('leaves the existing read unchanged when to/filter are absent', async () => {
    getRoomEvents.mockResolvedValue({ events: [timelineEvent('$e1', 'm.room.message', USER)], end: 42 });
    const db = makeDb();
    const { status, body } = await request(rooms, `${prefix}?from=s42&dir=b&limit=5`, db);
    expect(status).toBe(200);
    expect(getRoomEvents).toHaveBeenCalledWith(expect.anything(), ROOM, 42, 5, 'b');
    expect(body.chunk).toHaveLength(1);
    expect(db.calls.some((c) => c.sql.includes('SELECT event_id, stream_ordering'))).toBe(false);
  });
});

describe('GET /context per-side limits', () => {
  const prefix = `/_matrix/client/v3/rooms/${ROOM_ENC}/context/${EVENT_ENC}`;
  const dbRow = (id: string, ts: number) => ({
    event_id: id,
    room_id: ROOM,
    sender: USER,
    event_type: 'm.room.message',
    state_key: null,
    content: JSON.stringify({ body: id }),
    origin_server_ts: ts,
  });

  beforeEach(() => {
    getEvent.mockResolvedValue({
      event_id: EVENT,
      room_id: ROOM,
      sender: USER,
      type: 'm.room.message',
      event_type: 'm.room.message',
      content: JSON.stringify({ body: 'target' }),
      origin_server_ts: NOW,
      state_key: null,
    });
  });

  it('before and after override the even split independently', async () => {
    const db = makeDb((sql, args) => {
      if (sql.includes('origin_server_ts < ?')) {
        return [1, 2, 3, 4].map((n) => dbRow(`$b${n}`, NOW - n)).slice(0, args[2] as number);
      }
      if (sql.includes('origin_server_ts > ?')) {
        return [1, 2, 3, 4].map((n) => dbRow(`$a${n}`, NOW + n)).slice(0, args[2] as number);
      }
      return [];
    });

    const { status, body } = await request(rooms, `${prefix}?limit=10&before=3&after=1`, db);

    expect(status).toBe(200);
    const before = db.calls.find((c) => c.sql.includes('origin_server_ts < ?'));
    const after = db.calls.find((c) => c.sql.includes('origin_server_ts > ?'));
    expect(before?.args[2]).toBe(3);
    expect(after?.args[2]).toBe(1);
    expect(body.events_before).toHaveLength(3);
    expect(body.events_after).toHaveLength(1);
  });

  it('keeps the even split when before/after are absent', async () => {
    const db = makeDb((sql) => {
      if (sql.includes('origin_server_ts < ?') || sql.includes('origin_server_ts > ?')) {
        return [1, 2, 3, 4].map((n) => dbRow(`$x${n}`, NOW + n));
      }
      return [];
    });
    const { status } = await request(rooms, `${prefix}?limit=6`, db);
    expect(status).toBe(200);
    const limits = db.calls
      .filter((c) => c.sql.includes('origin_server_ts < ?') || c.sql.includes('origin_server_ts > ?'))
      .map((c) => c.args[2]);
    expect(limits).toEqual([3, 3]);
  });
});

describe('GET /members at', () => {
  const prefix = `/_matrix/client/v3/rooms/${ROOM_ENC}/members`;
  const memberEvent = (user: string, membership: string, position: number) => ({
    event_id: `$${user}-${position}`,
    room_id: ROOM,
    sender: user,
    event_type: 'm.room.member',
    state_key: user,
    content: JSON.stringify({ membership }),
    origin_server_ts: position,
    unsigned: null,
    stream_ordering: position,
  });
  const history = [
    memberEvent(USER, 'join', 5),
    memberEvent(BOB, 'join', 6),
    memberEvent(USER, 'leave', 8),
    memberEvent('@carol:example.com', 'join', 12),
  ];
  const db = makeDb((sql, args) => {
    if (sql.includes('e.stream_ordering <= ?')) {
      return history.filter((row) => row.stream_ordering <= (args[1] as number));
    }
    return [];
  });

  it('reconstructs membership as of the token position', async () => {
    const { status, body } = await request(rooms, `${prefix}?at=s7`, db);
    expect(status).toBe(200);
    expect(body.chunk.map((e: any) => e.state_key)).toEqual([USER, BOB]);
    const query = db.calls.find((c) => c.sql.includes('e.stream_ordering <= ?'));
    expect(query?.args).toEqual([ROOM, 7]);
  });

  it('uses the latest membership event at or before the token', async () => {
    const { status, body } = await request(rooms, `${prefix}?at=8`, db);
    expect(status).toBe(200);
    const byUser = new Map(body.chunk.map((e: any) => [e.state_key, e.content.membership]));
    expect(byUser.get(USER)).toBe('leave');
    expect(byUser.get(BOB)).toBe('join');
    expect(byUser.has('@carol:example.com')).toBe(false);
  });
});

describe('GET /v1/rooms/:roomId/hierarchy from cursor', () => {
  const prefix = `/_matrix/client/v1/rooms/${ROOM_ENC}/hierarchy`;
  const childIds = Array.from({ length: 120 }, (_, i) => `!child${String(i).padStart(3, '0')}:example.com`);

  function hierarchyDb() {
    const children = childIds.map((id) => ({
      state_key: id,
      content: JSON.stringify({ via: ['example.com'] }),
    }));
    return makeDb(
      (sql) => {
        if (sql.includes("rs.event_type = 'm.space.child'")) return children;
        return [];
      },
      (sql, args) => {
        if (sql.includes('SELECT room_id FROM rooms WHERE room_id') && !sql.includes('is_public')) {
          return args[0] === ROOM ? { room_id: ROOM } : null;
        }
        if (sql.includes('SELECT room_id, is_public FROM rooms')) {
          return { room_id: args[0], is_public: 1 };
        }
        if (sql.includes('SELECT COUNT(*) as count FROM room_memberships')) return { count: 1 };
        return null;
      }
    );
  }

  it('resumes strictly after the token with no gaps or duplicates', async () => {
    const db = hierarchyDb();
    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;

    do {
      const query = `?limit=10${token ? `&from=${encodeURIComponent(token)}` : ''}`;
      const { status, body } = await request(spaces, `${prefix}${query}`, db);
      expect(status).toBe(200);
      const ids: string[] = body.rooms.map((r: any) => r.room_id);
      if (pages === 0) {
        expect(ids[0]).toBe(ROOM);
      } else {
        expect(ids[0]).not.toBe(ROOM);
      }
      seen.push(...ids.filter((id) => id !== ROOM));
      token = body.next_batch;
      pages += 1;
    } while (token && pages < 200);

    expect(pages).toBeLessThan(200);
    expect(seen).toEqual(childIds);
    expect(new Set(seen).size).toBe(childIds.length);
  });
});
