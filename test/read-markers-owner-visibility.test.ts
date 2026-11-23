/**
 * Spec-cited tests: read_markers owner visibility.
 * - read_markers writes m.fully_read + m.read + m.read.private (src/api/receipts.ts:145-205)
 * - private receipts never federate
 * - getReceiptsForRoom filters m.read.private to owner (src/api/receipts.ts:216-270)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
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

vi.mock('../src/services/federation-edus', () => ({
  queueFederationEdu: vi.fn(),
}));

import receiptsApp from '../src/api/receipts';
import { getReceiptsForRoom } from '../src/api/receipts';
import { queueFederationEdu } from '../src/services/federation-edus';

const USER = '@alice:example.com';
const ROOM = '!r:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const E1 = '$e1:example.com';
const E2 = '$e2:example.com';
const E3 = '$e3:example.com';

type Membership = { room_id: string; user_id: string; membership: string };

type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

type SqlCall = { sql: string; args: unknown[] };

type RoomFetch = { url: string; method: string; body?: unknown };

function createRoomDOStub() {
  const fetches: RoomFetch[] = [];
  return {
    fetches,
    async fetch(req: Request): Promise<Response> {
      let body: unknown;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
      }
      fetches.push({ url: req.url, method: req.method, body });
      return Response.json({ ok: true });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createReceiptsDb(opts: { memberships?: Membership[] } = {}) {
  const memberships = opts.memberships ?? [];
  const accountData: AccountDataRow[] = [];
  const inserts: SqlCall[] = [];
  const selects: SqlCall[] = [];

  const db = {
    memberships,
    accountData,
    inserts,
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              throw new Error(`Unhandled first() SQL: ${sql.slice(0, 140)}`);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO account_data')) {
                inserts.push({ sql, args });
                const [userId, roomId, content] = args as [string, string, string];
                const idx = accountData.findIndex(
                  (a) => a.user_id === userId && a.room_id === roomId && a.event_type === 'm.fully_read'
                );
                const row: AccountDataRow = { user_id: userId, room_id: roomId, event_type: 'm.fully_read', content };
                if (idx >= 0) accountData[idx] = row;
                else accountData.push(row);
                return { success: true, meta: { changes: 1, last_row_id: 1 } };
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

type ReceiptsDb = ReturnType<typeof createReceiptsDb>;

function createEnv(opts: { db?: ReceiptsDb; roomDO?: RoomDOStub } = {}) {
  const db = opts.db ?? createReceiptsDb();
  const roomDO = opts.roomDO ?? createRoomDOStub();
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => roomDO,
    },
    _db: db,
    _roomDO: roomDO,
  };
  return env as unknown as Env & typeof env;
}

async function request(env: Env, path: string, init: RequestInit = {}) {
  const res = await receiptsApp.request(`http://localhost${path}`, init, env);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function joinDb() {
  return createReceiptsDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] });
}

const markersPath = `/_matrix/client/v3/rooms/${ROOM_ENC}/read_markers`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('read_markers owner visibility', () => {
  it('POST with all three markers: account_data for fully_read E1, DO fetches for read+private, federation once for m.read only', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', {
      'm.fully_read': E1,
      'm.read': E2,
      'm.read.private': E3,
    }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    // account_data insert for m.fully_read with E1
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0].args).toEqual([USER, ROOM, JSON.stringify({ event_id: E1 })]);

    // Room DO fetches for m.read and m.read.private
    expect(roomDO.fetches).toHaveLength(2);
    expect(roomDO.fetches[0].body).toMatchObject({ receipt_type: 'm.read', event_id: E2, user_id: USER });
    expect(roomDO.fetches[1].body).toMatchObject({ receipt_type: 'm.read.private', event_id: E3, user_id: USER });

    // federation called once for m.read only
    expect(queueFederationEdu).toHaveBeenCalledTimes(1);
    expect(queueFederationEdu).toHaveBeenCalledWith(
      env,
      ROOM,
      'm.receipt',
      expect.objectContaining({
        room_id: ROOM,
        content: expect.objectContaining({
          [E2]: expect.objectContaining({
            'm.read': expect.objectContaining({ [USER]: expect.anything() }),
          }),
        }),
      })
    );
  });

  it('POST with only m.read.private: no federation call at all', async () => {
    const db = joinDb();
    const roomDO = createRoomDOStub();
    const env = createEnv({ db, roomDO });
    const res = await request(env, markersPath, jsonInit('POST', { 'm.read.private': E3 }));
    expect(res.status).toBe(200);
    expect(roomDO.fetches).toHaveLength(1);
    expect(roomDO.fetches[0].body).toMatchObject({ receipt_type: 'm.read.private', event_id: E3 });
    expect(db.inserts).toHaveLength(0);
    expect(queueFederationEdu).not.toHaveBeenCalled();
  });
});

describe('getReceiptsForRoom owner filtering', () => {
  const RECEIPTS = {
    [E1]: {
      'm.read': { alice: { ts: 1 }, bob: { ts: 2 } },
      'm.read.private': { alice: { ts: 3 } },
    },
  };

  function makeEnv() {
    const roomDO = {
      async fetch() {
        return Response.json({ receipts: RECEIPTS });
      },
    };
    const env = {
      DB: {} as D1Database,
      SERVER_NAME: 'example.com',
      ROOMS: {
        idFromName: (name: string) => ({ name, toString: () => name }),
        get: () => roomDO,
      },
    };
    return env as unknown as Env;
  }

  it('requesting user alice includes her private receipt', async () => {
    const env = makeEnv();
    const result = await getReceiptsForRoom(env, ROOM, 'alice');
    expect(result.type).toBe('m.receipt');
    expect(result.content[E1]['m.read']).toMatchObject({ alice: { ts: 1 }, bob: { ts: 2 } });
    expect(result.content[E1]['m.read.private']).toMatchObject({ alice: { ts: 3 } });
  });

  it('requesting user bob excludes alice private but keeps m.read', async () => {
    const env = makeEnv();
    const result = await getReceiptsForRoom(env, ROOM, 'bob');
    expect(result.content[E1]['m.read']).toMatchObject({ alice: { ts: 1 }, bob: { ts: 2 } });
    expect(result.content[E1]['m.read.private']).toBeUndefined();
  });

  it('undefined requesting user returns all receipts unfiltered', async () => {
    const env = makeEnv();
    const result = await getReceiptsForRoom(env, ROOM, undefined);
    expect(result.content).toEqual(RECEIPTS);
  });
});
