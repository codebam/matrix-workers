/**
 * Legacy sync endpoints (deprecated but part of Matrix v1.17):
 * /initialSync, /events, /events/{eventId}, /rooms/{roomId}/initialSync.
 * Plain stream-position tokens, client-format events, membership gating.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

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

import legacySync from '../src/api/legacy-sync';

const SERVER = 'example.com';
const ALICE = `@alice:${SERVER}`;
const ROOM_A = `!a:${SERVER}`;
const ROOM_B = `!b:${SERVER}`;
const ROOM_C = `!c:${SERVER}`;
const ROOM_W = `!w:${SERVER}`;

interface EventRow {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  unsigned: string | null;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes: string | null;
  signatures: string | null;
  stream_ordering: number;
}

function ev(partial: Partial<EventRow> & Pick<EventRow, 'event_id' | 'room_id' | 'event_type' | 'stream_ordering'>): EventRow {
  return {
    sender: ALICE,
    state_key: null,
    content: JSON.stringify({ body: partial.event_id }),
    origin_server_ts: 1_700_000_000_000 + partial.stream_ordering,
    unsigned: null,
    depth: partial.stream_ordering,
    auth_events: '[]',
    prev_events: '[]',
    hashes: null,
    signatures: null,
    ...partial,
  };
}

function createDb() {
  const events: EventRow[] = [
    ev({ event_id: '$create', room_id: ROOM_A, event_type: 'm.room.create', state_key: '', content: JSON.stringify({ room_version: '10' }), stream_ordering: 1 }),
    ev({ event_id: '$member', room_id: ROOM_A, event_type: 'm.room.member', state_key: ALICE, content: JSON.stringify({ membership: 'join' }), stream_ordering: 2 }),
    ev({ event_id: '$hello', room_id: ROOM_A, event_type: 'm.room.message', stream_ordering: 3 }),
    ev({ event_id: '$world', room_id: ROOM_A, event_type: 'm.room.message', stream_ordering: 4 }),
    ev({ event_id: '$binvite', room_id: ROOM_B, event_type: 'm.room.member', state_key: ALICE, content: JSON.stringify({ membership: 'invite' }), stream_ordering: 5 }),
    ev({ event_id: '$cleave', room_id: ROOM_C, event_type: 'm.room.member', state_key: ALICE, content: JSON.stringify({ membership: 'leave' }), stream_ordering: 6 }),
    ev({ event_id: '$wvisible', room_id: ROOM_W, event_type: 'm.room.history_visibility', state_key: '', content: JSON.stringify({ history_visibility: 'world_readable' }), stream_ordering: 7 }),
    ev({ event_id: '$wmsg', room_id: ROOM_W, event_type: 'm.room.message', stream_ordering: 8 }),
  ];
  const state = [
    { room_id: ROOM_A, event_id: '$create' },
    { room_id: ROOM_A, event_id: '$member' },
    { room_id: ROOM_B, event_id: '$binvite' },
    { room_id: ROOM_C, event_id: '$cleave' },
    { room_id: ROOM_W, event_id: '$wvisible' },
  ];
  const memberships = [
    { room_id: ROOM_A, user_id: ALICE, membership: 'join', event_id: '$member' },
    { room_id: ROOM_B, user_id: ALICE, membership: 'invite', event_id: '$binvite' },
    { room_id: ROOM_C, user_id: ALICE, membership: 'leave', event_id: '$cleave' },
  ];
  const rooms = [
    { room_id: ROOM_A, is_public: 1 },
    { room_id: ROOM_B, is_public: 0 },
    { room_id: ROOM_C, is_public: 0 },
    { room_id: ROOM_W, is_public: 1 },
  ];
  const accountData = [
    { user_id: ALICE, room_id: '', event_type: 'm.push_rules', content: JSON.stringify({ global: {} }) },
    { user_id: ALICE, room_id: ROOM_A, event_type: 'm.fully_read', content: JSON.stringify({ event_id: '$hello' }) },
  ];

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes('MAX(stream_ordering)')) {
          const max = events.reduce((m, e) => Math.max(m, e.stream_ordering), 0);
          return { max_ordering: max } as T;
        }
        if (sql.includes('FROM rooms WHERE room_id')) {
          return (rooms.find(r => r.room_id === args[0]) ?? null) as T | null;
        }
        if (sql.includes('FROM room_memberships WHERE room_id')) {
          const row = memberships.find(m => m.room_id === args[0] && m.user_id === args[1]);
          return (row ? { membership: row.membership, event_id: row.event_id } : null) as T | null;
        }
        throw new Error('Unhandled first() SQL: ' + sql.slice(0, 120));
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes('FROM room_memberships WHERE user_id')) {
          const userId = args[0] as string;
          let rows = memberships.filter(m => m.user_id === userId);
          if (sql.includes("membership = 'join'")) {
            rows = rows.filter(m => m.membership === 'join');
          }
          return { results: rows as T[] };
        }
        if (sql.includes('FROM room_state rs')) {
          const roomId = args[0] as string;
          const rows = state
            .filter(s => s.room_id === roomId)
            .map(s => events.find(e => e.event_id === s.event_id))
            .filter((e): e is EventRow => Boolean(e));
          return { results: rows as T[] };
        }
        if (sql.includes('FROM account_data')) {
          const userId = args[0] as string;
          const rows = sql.includes("room_id = ''")
            ? accountData.filter(a => a.user_id === userId && a.room_id === '')
            : accountData.filter(a => a.user_id === userId && a.room_id === args[1]);
          return { results: rows as T[] };
        }
        if (sql.includes('event_id IN')) {
          const ids = args as string[];
          return { results: events.filter(e => ids.includes(e.event_id)) as T[] };
        }
        if (sql.includes('FROM events')) {
          let rows: EventRow[];
          let from: number;
          if (sql.includes('room_id IN')) {
            const roomIds = args.slice(0, -1) as string[];
            from = args[args.length - 1] as number;
            rows = events.filter(e => roomIds.includes(e.room_id) && e.stream_ordering > from);
          } else if (sql.includes('stream_ordering >')) {
            rows = events.filter(e => e.room_id === args[0] && e.stream_ordering > (args[1] as number));
          } else {
            rows = events.filter(e => e.room_id === args[0]);
          }
          rows.sort((a, b) =>
            sql.includes('DESC')
              ? b.stream_ordering - a.stream_ordering
              : a.stream_ordering - b.stream_ordering
          );
          const limitMatch = sql.match(/LIMIT (\d+)/);
          const limit = limitMatch
            ? parseInt(limitMatch[1], 10)
            : sql.includes('LIMIT ?')
              ? Number(args[args.length - 1])
              : undefined;
          if (limit !== undefined) rows = rows.slice(0, limit);
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };

  return {
    events,
    prepare: (sql: string) => stmt(sql),
  };
}

type Db = ReturnType<typeof createDb>;

function envFor(db: Db, extras: Partial<Env> = {}): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db as unknown as D1Database,
    ...extras,
  } as unknown as Env;
}

async function get(path: string, db: Db = createDb(), extras: Partial<Env> = {}) {
  const res = await legacySync.request(`http://localhost${path}`, { method: 'GET' }, envFor(db, extras));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('GET /initialSync', () => {
  it('returns joined rooms with state and messages, invites with invite_state, skips left rooms', async () => {
    const { status, body } = await get('/_matrix/client/v3/initialSync');
    expect(status).toBe(200);
    expect(body.end).toBe('8');
    expect(body.presence).toEqual([]);
    expect(body.account_data).toEqual([{ type: 'm.push_rules', content: { global: {} } }]);

    const byId = Object.fromEntries(body.rooms.map((r: any) => [r.room_id, r]));
    expect(Object.keys(byId).sort()).toEqual([ROOM_A, ROOM_B].sort());

    const joined = byId[ROOM_A];
    expect(joined.membership).toBe('join');
    expect(joined.visibility).toBe('public');
    expect(joined.state.map((e: any) => e.event_id).sort()).toEqual(['$create', '$member']);
    expect(joined.messages.chunk.map((e: any) => e.event_id)).toEqual(['$world', '$hello', '$member', '$create']);
    expect(joined.messages.start).toBe('4');
    expect(joined.messages.end).toBe('1');
    expect(joined.account_data).toEqual([{ type: 'm.fully_read', content: { event_id: '$hello' } }]);

    const invited = byId[ROOM_B];
    expect(invited.membership).toBe('invite');
    expect(invited.invite.invite_state.events[0].event_id).toBe('$binvite');
  });

  it('archived=true includes left rooms', async () => {
    const { status, body } = await get('/_matrix/client/v3/initialSync?archived=true');
    expect(status).toBe(200);
    const ids = body.rooms.map((r: any) => r.room_id);
    expect(ids).toContain(ROOM_C);
    expect(body.rooms.find((r: any) => r.room_id === ROOM_C).membership).toBe('leave');
  });

  it('limit caps the per-room message page', async () => {
    const { body } = await get('/_matrix/client/v3/initialSync?limit=1');
    const joined = body.rooms.find((r: any) => r.room_id === ROOM_A);
    expect(joined.messages.chunk).toHaveLength(1);
    expect(joined.messages.chunk[0].event_id).toBe('$world');
  });

  it('client events carry no federation-only fields', async () => {
    const { body } = await get('/_matrix/client/v3/initialSync');
    const joined = body.rooms.find((r: any) => r.room_id === ROOM_A);
    for (const e of [...joined.state, ...joined.messages.chunk]) {
      expect(e).not.toHaveProperty('auth_events');
      expect(e).not.toHaveProperty('prev_events');
      expect(e).not.toHaveProperty('depth');
      expect(e).not.toHaveProperty('signatures');
    }
  });
});

describe('GET /rooms/{roomId}/initialSync', () => {
  it('returns RoomInfo for a member', async () => {
    const { status, body } = await get(`/_matrix/client/v3/rooms/${ROOM_A}/initialSync`);
    expect(status).toBe(200);
    expect(body.room_id).toBe(ROOM_A);
    expect(body.membership).toBe('join');
    expect(body.messages.chunk.length).toBeGreaterThan(0);
  });

  it('answers 403 for a non-member', async () => {
    const { status, body } = await get(`/_matrix/client/v3/rooms/${ROOM_W}/initialSync`);
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_FORBIDDEN');
  });
});

describe('GET /events (legacy stream)', () => {
  it('streams joined-room events after the from token', async () => {
    const { status, body } = await get('/_matrix/client/v3/events?from=2');
    expect(status).toBe(200);
    expect(body.start).toBe('2');
    expect(body.end).toBe('4');
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$hello', '$world']);
  });

  it('accepts composite sync tokens', async () => {
    const { body } = await get('/_matrix/client/v3/events?from=s3_td0');
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$world']);
  });

  it('room_id scopes the stream and gates on membership', async () => {
    const ok = await get(`/_matrix/client/v3/events?room_id=${ROOM_A}&from=0`);
    expect(ok.status).toBe(200);
    expect(ok.body.chunk).toHaveLength(4);

    const forbidden = await get(`/_matrix/client/v3/events?room_id=${ROOM_C}`);
    expect(forbidden.status).toBe(403);
  });

  it('allows peeking world_readable rooms without membership', async () => {
    const { status, body } = await get(`/_matrix/client/v3/events?room_id=${ROOM_W}&from=0`);
    expect(status).toBe(200);
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$wvisible', '$wmsg']);
  });

  it('empty stream keeps start=end=from', async () => {
    const { body } = await get('/_matrix/client/v3/events?from=8');
    expect(body.chunk).toEqual([]);
    expect(body.start).toBe('8');
    expect(body.end).toBe('8');
  });

  it('long-polls on the Sync DO and re-reads after wakeup', async () => {
    const db = createDb();
    const syncDo = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          // A new event lands while the request is parked.
          db.events.push(ev({ event_id: '$late', room_id: ROOM_A, event_type: 'm.room.message', stream_ordering: 9 }));
          return new Response(JSON.stringify({ hasEvents: true }));
        },
      }),
    };
    const { status, body } = await get(
      '/_matrix/client/v3/events?from=8&timeout=100',
      db,
      { SYNC: syncDo as unknown as Env['SYNC'] }
    );
    expect(status).toBe(200);
    expect(body.chunk.map((e: any) => e.event_id)).toEqual(['$late']);
    expect(body.end).toBe('9');
  });
});

describe('GET /events/{eventId} (legacy single event)', () => {
  it('returns the client event for a member', async () => {
    const { status, body } = await get('/_matrix/client/v3/events/$hello');
    expect(status).toBe(200);
    expect(body.event_id).toBe('$hello');
    expect(body.room_id).toBe(ROOM_A);
    expect(body.type).toBe('m.room.message');
    expect(body).not.toHaveProperty('auth_events');
  });

  it('answers 404 for unknown events', async () => {
    const { status, body } = await get('/_matrix/client/v3/events/$nope');
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('answers 404 for events in rooms the user cannot see', async () => {
    const { status } = await get('/_matrix/client/v3/events/$cleave');
    expect(status).toBe(404);
  });

  it('serves events from world_readable rooms to non-members', async () => {
    const { status, body } = await get('/_matrix/client/v3/events/$wmsg');
    expect(status).toBe(200);
    expect(body.event_id).toBe('$wmsg');
  });
});