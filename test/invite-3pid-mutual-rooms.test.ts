/**
 * inviteBy3PID (Matrix v1.17): POST /rooms/{roomId}/invite with medium/address
 * resolves local bindings / identity associations / a remote identity server,
 * and stores m.room.third_party_invite when the 3PID is unbound.
 * Also covers MSC2666 query_mutual_rooms (advertised in unstable_features).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import rooms from '../src/api/rooms';

const SERVER = 'example.com';
const ALICE = `@alice:${SERVER}`;
const BOB = `@bob:${SERVER}`;
const CAROL = `@carol:${SERVER}`;
const ROOM = `!r:${SERVER}`;
const ROOM2 = `!s:${SERVER}`;

interface EvRow {
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
  stream_ordering: number;
}

function createDb(opts: { alicePower?: number } = {}) {
  const alicePower = opts.alicePower ?? 100;
  let stream = 3;
  const events: EvRow[] = [
    {
      event_id: '$create', room_id: ROOM, sender: ALICE, event_type: 'm.room.create', state_key: '',
      content: JSON.stringify({ room_version: '10', creator: ALICE }),
      origin_server_ts: 1, unsigned: null, depth: 0, auth_events: '[]', prev_events: '[]', stream_ordering: 1,
    },
    {
      event_id: '$pl', room_id: ROOM, sender: ALICE, event_type: 'm.room.power_levels', state_key: '',
      content: JSON.stringify({ users: { [ALICE]: alicePower }, invite: 50 }),
      origin_server_ts: 2, unsigned: null, depth: 1, auth_events: '[]', prev_events: '[]', stream_ordering: 2,
    },
    {
      event_id: '$alicejoin', room_id: ROOM, sender: ALICE, event_type: 'm.room.member', state_key: ALICE,
      content: JSON.stringify({ membership: 'join' }),
      origin_server_ts: 3, unsigned: null, depth: 2, auth_events: '[]', prev_events: '[]', stream_ordering: 3,
    },
  ];
  const state = [
    { room_id: ROOM, event_type: 'm.room.create', state_key: '', event_id: '$create' },
    { room_id: ROOM, event_type: 'm.room.power_levels', state_key: '', event_id: '$pl' },
    { room_id: ROOM, event_type: 'm.room.member', state_key: ALICE, event_id: '$alicejoin' },
  ];
  const memberships = [
    { room_id: ROOM, user_id: ALICE, membership: 'join', event_id: '$alicejoin' },
    { room_id: ROOM2, user_id: ALICE, membership: 'join', event_id: '$a2' },
    { room_id: ROOM, user_id: BOB, membership: 'join', event_id: '$bjoin' },
    { room_id: ROOM2, user_id: CAROL, membership: 'join', event_id: '$c2' },
  ];
  const users = new Map([ALICE, BOB, CAROL].map(u => [u, {
    user_id: u, localpart: u.slice(1).split(':')[0], display_name: null, avatar_url: null,
    password_hash: null, is_guest: 0, is_deactivated: 0, admin: 0, created_at: 1,
  }]));
  const threepids = [{ medium: 'email', address: 'bob@example.com', user_id: BOB }];
  const associations = [{ medium: 'email', address: 'carol@example.com', mxid: CAROL }];

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes('UPDATE stream_positions')) {
          stream += 1;
          return { position: stream } as T;
        }
        if (sql.includes('FROM room_memberships WHERE room_id = ? AND user_id = ?')) {
          const m = memberships.find(m => m.room_id === args[0] && m.user_id === args[1]);
          return (m ? { membership: m.membership, event_id: m.event_id } : null) as T | null;
        }
        if (sql.includes('FROM room_state rs') && sql.includes('rs.event_type = ?')) {
          const s = state.find(s => s.room_id === args[0] && s.event_type === args[1] && s.state_key === (args[2] ?? ''));
          const e = s ? events.find(e => e.event_id === s.event_id) : undefined;
          return (e ?? null) as T | null;
        }
        if (sql.includes('FROM rooms WHERE room_id')) {
          return (events.some(e => e.room_id === args[0])
            ? { room_id: args[0], room_version: '10', is_public: 0, creator_id: ALICE, created_at: 1 }
            : null) as T | null;
        }
        if (sql.includes('FROM user_threepids')) {
          const t = threepids.find(t => t.medium === args[0] && t.address === args[1]);
          return (t ? { user_id: t.user_id } : null) as T | null;
        }
        if (sql.includes('FROM identity_associations')) {
          const a = associations.find(a => a.medium === args[0] && a.address === args[1]);
          return (a ? { mxid: a.mxid } : null) as T | null;
        }
        if (sql.includes('FROM users WHERE user_id')) {
          return (users.get(args[0] as string) ?? null) as T | null;
        }
        return null as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes('FROM room_memberships a') && sql.includes('JOIN room_memberships b')) {
          const a = memberships.filter(m => m.user_id === args[0] && m.membership === 'join');
          const b = memberships.filter(m => m.user_id === args[1] && m.membership === 'join');
          const shared = a.filter(x => b.some(y => y.room_id === x.room_id));
          return { results: shared.map(m => ({ room_id: m.room_id })) as T[] };
        }
        if (sql.includes('FROM room_memberships WHERE room_id = ? AND membership')) {
          return {
            results: memberships
              .filter(m => m.room_id === args[0] && m.membership === 'join')
              .map(m => ({ user_id: m.user_id })) as T[],
          };
        }
        if (sql.includes('FROM events WHERE room_id')) {
          const rows = events
            .filter(e => e.room_id === args[0])
            .sort((a, b) => b.stream_ordering - a.stream_ordering);
          const limit = typeof args[1] === 'number' ? args[1] : rows.length;
          return { results: rows.slice(0, limit) as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes('INSERT INTO events')) {
          const [event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, , , stream_ordering] = args as any[];
          events.push({
            event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned,
            depth, auth_events, prev_events, stream_ordering,
          });
          if (state_key !== null && state_key !== undefined) {
            const existing = state.findIndex(s => s.room_id === room_id && s.event_type === event_type && s.state_key === state_key);
            const entry = { room_id, event_type, state_key, event_id };
            if (existing >= 0) state[existing] = entry;
            else state.push(entry);
          }
        }
        if (sql.includes('INSERT OR REPLACE INTO room_memberships')) {
          const [room_id, user_id, membership, event_id] = args as string[];
          const existing = memberships.findIndex(m => m.room_id === room_id && m.user_id === user_id);
          const entry = { room_id, user_id, membership, event_id };
          if (existing >= 0) memberships[existing] = entry;
          else memberships.push(entry);
        }
        return { success: true, meta: { changes: 1 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };

  return { events, state, memberships, prepare: (sql: string) => stmt(sql) };
}

type Db = ReturnType<typeof createDb>;

function envFor(db: Db): Env {
  const syncStub = {
    idFromName: (n: string) => n,
    get: () => ({ fetch: async () => new Response('{}') }),
  };
  return {
    SERVER_NAME: SERVER,
    DB: db as unknown as D1Database,
    SYNC: syncStub as unknown as Env['SYNC'],
    FEDERATION: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response('Queued') }),
    } as unknown as Env['FEDERATION'],
    CACHE: { get: async () => null, put: async () => {}, delete: async () => {} } as unknown as KVNamespace,
  } as unknown as Env;
}

async function invite(db: Db, body: unknown) {
  const res = await rooms.request(
    `http://localhost/_matrix/client/v3/rooms/${ROOM}/invite`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    envFor(db)
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invite by MXID (regression)', () => {
  it('rejects inviting a user who already joined', async () => {
    const db = createDb();
    const { status, body } = await invite(db, { user_id: BOB });
    expect(status).toBe(403);
    expect(body.error).toContain('already in the room');
  });

  it('invites a not-yet-member user', async () => {
    const db = createDb();
    db.memberships.splice(db.memberships.findIndex(m => m.user_id === BOB), 1);
    const { status } = await invite(db, { user_id: BOB });
    expect(status).toBe(200);
    const memberEvent = db.events.find(e => e.event_type === 'm.room.member' && e.state_key === BOB);
    expect(memberEvent).toBeDefined();
    expect(JSON.parse(memberEvent!.content).membership).toBe('invite');
    expect(db.memberships.find(m => m.user_id === BOB)?.membership).toBe('invite');
  });
});

describe('inviteBy3PID resolution', () => {
  it('resolves a bound email to the MXID and invites normally', async () => {
    const db = createDb();
    db.memberships.splice(db.memberships.findIndex(m => m.user_id === BOB), 1);
    const { status } = await invite(db, { medium: 'email', address: 'bob@example.com' });
    expect(status).toBe(200);
    const memberEvent = db.events.find(e => e.event_type === 'm.room.member' && e.state_key === BOB);
    expect(memberEvent).toBeDefined();
    expect(db.events.some(e => e.event_type === 'm.room.third_party_invite')).toBe(false);
  });

  it('resolves via identity_associations when no account binding exists', async () => {
    const db = createDb();
    const { status } = await invite(db, { medium: 'email', address: 'carol@example.com' });
    expect(status).toBe(200);
    expect(db.events.some(e => e.event_type === 'm.room.member' && e.state_key === CAROL)).toBe(true);
  });

  it('stores m.room.third_party_invite for an unbound 3PID', async () => {
    const db = createDb();
    const { status, body } = await invite(db, { medium: 'email', address: 'stranger@example.com' });
    expect(status).toBe(200);
    expect(body).toEqual({});
    const tpi = db.events.find(e => e.event_type === 'm.room.third_party_invite');
    expect(tpi).toBeDefined();
    expect(tpi!.state_key).toBeTruthy();
    expect(JSON.parse(tpi!.content)).toEqual({ display_name: 'stranger@example.com' });
    expect(tpi!.sender).toBe(ALICE);
    // No membership is fabricated for an unknown invitee.
    expect(db.memberships.some(m => m.user_id.includes('stranger'))).toBe(false);
  });

  it('rejects invalid medium and missing identifiers', async () => {
    const db = createDb();
    const badMedium = await invite(db, { medium: 'fax', address: '123' });
    expect(badMedium.status).toBe(400);
    expect(badMedium.body.errcode).toBe('M_INVALID_PARAM');
    const missing = await invite(db, {});
    expect(missing.status).toBe(400);
    expect(missing.body.errcode).toBe('M_MISSING_PARAM');
  });

  it('requires inviter membership and invite power', async () => {
    const db = createDb();
    db.memberships.splice(db.memberships.findIndex(m => m.user_id === ALICE && m.room_id === ROOM), 1);
    const nonMember = await invite(db, { medium: 'email', address: 'stranger@example.com' });
    expect(nonMember.status).toBe(403);

    const lowPower = createDb({ alicePower: 0 });
    const denied = await invite(lowPower, { medium: 'email', address: 'stranger@example.com' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toContain('power level');
    expect(lowPower.events.some(e => e.event_type === 'm.room.third_party_invite')).toBe(false);
  });

  it('resolves through a remote identity server when id_server is supplied', async () => {
    const db = createDb();
    // Answer hash_details with a pepper, and map whatever hash was looked up.
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/hash_details')) {
        return new Response(JSON.stringify({ lookup_pepper: 'pepper1', algorithms: ['sha256'] }));
      }
      if (u.endsWith('/lookup')) {
        const body = JSON.parse(String(init?.body)) as { addresses: string[] };
        return new Response(JSON.stringify({ mappings: { [body.addresses[0]]: '@dave:other.org' } }));
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { status } = await invite(db, {
      medium: 'email',
      address: 'dave@other.org',
      id_server: 'identity.other.org',
      id_access_token: 'is-token',
    });
    expect(status).toBe(200);
    expect(db.events.some(e => e.event_type === 'm.room.member' && e.state_key === '@dave:other.org')).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u) === 'https://identity.other.org/_matrix/identity/v2/hash_details')).toBe(true);
    const lookupCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/lookup'));
    expect(lookupCall).toBeDefined();
    expect((lookupCall![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer is-token' });
    vi.unstubAllGlobals();
  });
});

describe('MSC2666 query_mutual_rooms', () => {
  async function getMutual(db: Db, target: string) {
    const res = await rooms.request(
      `http://localhost/_matrix/client/unstable/uk.half-shot.msc2666/query_mutual_rooms/${encodeURIComponent(target)}`,
      { method: 'GET' },
      envFor(db)
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it('returns rooms both users have joined', async () => {
    const db = createDb();
    const { status, body } = await getMutual(db, BOB);
    expect(status).toBe(200);
    expect(body).toEqual({ joined: [ROOM] });
  });

  it('excludes rooms where either side is not joined', async () => {
    const db = createDb();
    // Carol shares ROOM2 with alice but not ROOM.
    const { body } = await getMutual(db, CAROL);
    expect(body).toEqual({ joined: [ROOM2] });
  });

  it('answers 404 for unknown users', async () => {
    const db = createDb();
    const { status, body } = await getMutual(db, '@nobody:example.com');
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });
});