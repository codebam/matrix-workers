/**
 * Redacted state events must serve pruned content in legacy /initialSync,
 * both in invite stripped state and in a joined room's state.
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
const INVITE_ROOM = `!invite:${SERVER}`;
const JOINED_ROOM = `!joined:${SERVER}`;

interface EventRow {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  redacted_content: string | null;
  origin_server_ts: number;
  unsigned: string | null;
  depth: number;
  auth_events: string;
  prev_events: string;
  stream_ordering: number;
}

function ev(partial: Partial<EventRow> & Pick<EventRow, 'event_id' | 'room_id' | 'event_type' | 'stream_ordering'>): EventRow {
  return {
    sender: ALICE,
    state_key: '',
    content: JSON.stringify({ body: partial.event_id }),
    redacted_content: null,
    origin_server_ts: 1_700_000_000_000 + partial.stream_ordering,
    unsigned: null,
    depth: partial.stream_ordering,
    auth_events: '[]',
    prev_events: '[]',
    ...partial,
  };
}

function createDb() {
  const events: EventRow[] = [
    ev({ event_id: '$inv-member', room_id: INVITE_ROOM, event_type: 'm.room.member', state_key: ALICE,
      content: JSON.stringify({ membership: 'invite' }), stream_ordering: 1 }),
    ev({ event_id: '$inv-name', room_id: INVITE_ROOM, event_type: 'm.room.name',
      content: JSON.stringify({ name: 'SECRET original name' }),
      redacted_content: JSON.stringify({}), stream_ordering: 2 }),
    ev({ event_id: '$inv-topic', room_id: INVITE_ROOM, event_type: 'm.room.topic',
      content: JSON.stringify({ topic: 'visible topic' }), stream_ordering: 3 }),
    ev({ event_id: '$inv-avatar', room_id: INVITE_ROOM, event_type: 'm.room.avatar',
      content: JSON.stringify({ url: 'mxc://example.com/raw' }),
      redacted_content: '{not valid json', stream_ordering: 4 }),
    ev({ event_id: '$join-member', room_id: JOINED_ROOM, event_type: 'm.room.member', state_key: ALICE,
      content: JSON.stringify({ membership: 'join' }), stream_ordering: 5 }),
    ev({ event_id: '$join-name', room_id: JOINED_ROOM, event_type: 'm.room.name',
      content: JSON.stringify({ name: 'SECRET joined name' }),
      redacted_content: JSON.stringify({}), stream_ordering: 6 }),
  ];
  const state = [
    { room_id: INVITE_ROOM, event_id: '$inv-member' },
    { room_id: INVITE_ROOM, event_id: '$inv-name' },
    { room_id: INVITE_ROOM, event_id: '$inv-topic' },
    { room_id: INVITE_ROOM, event_id: '$inv-avatar' },
    { room_id: JOINED_ROOM, event_id: '$join-member' },
    { room_id: JOINED_ROOM, event_id: '$join-name' },
  ];
  const memberships = [
    { room_id: INVITE_ROOM, user_id: ALICE, membership: 'invite', event_id: '$inv-member' },
    { room_id: JOINED_ROOM, user_id: ALICE, membership: 'join', event_id: '$join-member' },
  ];
  const rooms = [
    { room_id: INVITE_ROOM, is_public: 0 },
    { room_id: JOINED_ROOM, is_public: 0 },
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
          return { results: memberships.filter(m => m.user_id === args[0]) as T[] };
        }
        if (sql.includes('FROM room_state rs')) {
          const roomId = args[0] as string;
          const rows = state
            .filter(s => s.room_id === roomId)
            .map(s => events.find(e => e.event_id === s.event_id))
            .filter((e): e is EventRow => Boolean(e));
          if (sql.includes('redacted_content IS NOT NULL')) {
            return { results: rows.filter(e => e.redacted_content !== null) as T[] };
          }
          return { results: rows as T[] };
        }
        if (sql.includes('FROM account_data')) {
          return { results: [] as T[] };
        }
        if (sql.includes('FROM events')) {
          const skipSnapshots = sql.includes('stream_ordering > 0');
          const rows = events.filter(
            e => e.room_id === args[0] && (!skipSnapshots || e.stream_ordering > 0)
          );
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first };
  };

  return { events, prepare: (sql: string) => stmt(sql) };
}

type Db = ReturnType<typeof createDb>;

async function get(path: string, db: Db) {
  const env = {
    SERVER_NAME: SERVER,
    DB: db as unknown as D1Database,
  } as unknown as Env;
  const res = await legacySync.request(`http://localhost${path}`, { method: 'GET' }, env);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('legacy /initialSync redacted state content', () => {
  it('serves pruned content in invite stripped state and leaves raw/unredacted content intact', async () => {
    const { status, body } = await get('/_matrix/client/v3/initialSync', createDb());
    expect(status).toBe(200);
    const invite = body.rooms.find((r: any) => r.room_id === INVITE_ROOM);
    expect(invite.membership).toBe('invite');

    const byId = Object.fromEntries(
      invite.invite.invite_state.events.map((e: any) => [e.event_id, e])
    );
    expect(byId['$inv-name'].content).toEqual({});
    expect(byId['$inv-topic'].content).toEqual({ topic: 'visible topic' });
    // Malformed redacted_content falls back to the original content.
    expect(byId['$inv-avatar'].content).toEqual({ url: 'mxc://example.com/raw' });
  });

  it('also prunes redacted events in joined room state', async () => {
    const { status, body } = await get(
      `/_matrix/client/v3/rooms/${JOINED_ROOM}/initialSync`,
      createDb()
    );
    expect(status).toBe(200);
    const byId = Object.fromEntries(body.state.map((e: any) => [e.event_id, e]));
    expect(byId['$join-name'].content).toEqual({});
    expect(byId['$join-member'].content).toEqual({ membership: 'join' });
  });
});
