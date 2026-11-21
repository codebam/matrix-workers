/**
 * Real incremental presence in legacy /sync.
 *
 * Covers the full write -> stamp -> delta path: local PUT /presence, inbound
 * federation m.presence EDU, the _pr cursor in next_batch, legacy tokens
 * without _pr, shared-room scoping, and the D1-backed sliding-sync fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';
const ROOM = '!room:example.com';
const NOW = 1_700_000_000_000;

const syncMocks = vi.hoisted(() => ({
  getUserRooms: vi.fn(),
  getLatestStreamPosition: vi.fn(),
  getInvitePermission: vi.fn(),
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserRooms: syncMocks.getUserRooms,
    getLatestStreamPosition: syncMocks.getLatestStreamPosition,
    getInvitePermission: syncMocks.getInvitePermission,
  };
});

const noopMocks = vi.hoisted(() => ({
  getToDeviceMessages: vi.fn(),
  getGlobalAccountData: vi.fn(),
  getRoomAccountData: vi.fn(),
  getReceiptsForRoom: vi.fn(),
  getTypingUsers: vi.fn(),
}));

vi.mock('../src/api/to-device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/to-device')>();
  return { ...actual, getToDeviceMessages: noopMocks.getToDeviceMessages };
});
vi.mock('../src/api/account-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/account-data')>();
  return {
    ...actual,
    getGlobalAccountData: noopMocks.getGlobalAccountData,
    getRoomAccountData: noopMocks.getRoomAccountData,
  };
});
vi.mock('../src/api/receipts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/receipts')>();
  return { ...actual, getReceiptsForRoom: noopMocks.getReceiptsForRoom };
});
vi.mock('../src/api/typing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/typing')>();
  return { ...actual, getTypingUsers: noopMocks.getTypingUsers };
});

import presenceApp from '../src/api/presence';
import syncApp, { buildSyncToken, parseSyncToken } from '../src/api/sync';
import federationApp from '../src/api/federation';

type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
  currently_active: number;
  stream_position: number;
};

type Membership = { room_id: string; user_id: string; membership: string };
type SqlCall = { sql: string; args: unknown[]; kind: 'first' | 'all' | 'run' };

function createDb(opts: {
  presence?: PresenceRow[];
  memberships?: Membership[];
  presencePos?: number;
  withBatch?: boolean;
} = {}) {
  const presence = new Map<string, PresenceRow>(
    (opts.presence ?? []).map((row) => [row.user_id, { ...row }])
  );
  const memberships: Membership[] = opts.memberships ?? [
    { room_id: ROOM, user_id: USER, membership: 'join' },
    { room_id: ROOM, user_id: BOB, membership: 'join' },
  ];
  const streamPositions = new Map<string, number>([
    ['presence', opts.presencePos ?? 0],
    ['events', 100],
  ]);
  const sqlCalls: SqlCall[] = [];

  function bumpPresence(): number {
    const next = (streamPositions.get('presence') ?? 0) + 1;
    streamPositions.set('presence', next);
    return next;
  }

  function sharedUsers(userId: string): Set<string> {
    const roomIds = new Set(
      memberships
        .filter((m) => m.user_id === userId && m.membership === 'join')
        .map((m) => m.room_id)
    );
    const ids = new Set<string>([userId]);
    for (const m of memberships) {
      if (roomIds.has(m.room_id) && m.membership === 'join') ids.add(m.user_id);
    }
    return ids;
  }

  const db = {
    presence,
    memberships,
    streamPositions,
    sqlCalls,
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        sql,
        async first<T>() {
          sqlCalls.push({ sql, args, kind: 'first' });
          if (sql.includes('FROM stream_positions') && sql.includes('stream_name = ?')) {
            return { position: streamPositions.get(String(args[0])) ?? 0 } as T;
          }
          if (sql.includes('FROM device_key_changes') && sql.includes('COUNT(*)')) {
            return { count: 0 } as T;
          }
          return null as T;
        },
        async all<T>() {
          sqlCalls.push({ sql, args, kind: 'all' });
          if (sql.includes('policy_list_subscriptions')) return { results: [] as T[] };

          // The production query must scope deltas to the caller's own row or
          // users sharing a joined room; mirror that predicate here.
          if (sql.includes('FROM presence p') && sql.includes('stream_position > ?')) {
            expect(sql).toContain('rm2.user_id = p.user_id');
            const [since, caller, requester] = args as [number, string, string];
            expect(caller).toBe(requester);
            const allowed = sharedUsers(caller);
            const rows = [...presence.values()]
              .filter((row) => row.stream_position > since && allowed.has(row.user_id))
              .sort((a, b) => a.stream_position - b.stream_position);
            return { results: rows as unknown as T[] };
          }
          if (sql.includes('FROM presence') && sql.includes('IN (')) {
            const rows = (args as string[])
              .map((id) => presence.get(id))
              .filter((row): row is PresenceRow => Boolean(row));
            return { results: rows as unknown as T[] };
          }
          if (sql.includes('FROM room_memberships')) {
            const [roomId] = args as string[];
            return {
              results: memberships
                .filter((m) => m.room_id === roomId && m.membership === 'join')
                .map((m) => ({ user_id: m.user_id })) as unknown as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          sqlCalls.push({ sql, args, kind: 'run' });
          if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
            bumpPresence();
          } else if (sql.includes('INSERT INTO presence') && sql.includes('stream_position')) {
            // The batched statement reads the just-bumped counter via a
            // subquery instead of binding the position.
            const [userId, state, statusMsg, ts, active] = args as [
              string, string, string | null, number, number,
            ];
            presence.set(userId, {
              user_id: userId,
              presence: state,
              status_msg: statusMsg,
              last_active_ts: ts,
              currently_active: active,
              stream_position: streamPositions.get('presence') ?? 0,
            });
          } else if (sql.includes('UPDATE presence SET last_active_ts') && sql.includes('stream_position')) {
            const [ts, userId] = args as [number, string];
            const row = presence.get(userId);
            if (row) {
              presence.set(userId, {
                ...row,
                last_active_ts: ts,
                stream_position: streamPositions.get('presence') ?? row.stream_position,
              });
            }
          } else if (sql.includes('INSERT INTO presence')) {
            const [userId, state, statusMsg, ts] = args as [string, string, string | null, number];
            presence.set(userId, {
              user_id: userId,
              presence: state,
              status_msg: statusMsg,
              last_active_ts: ts,
              currently_active: state === 'online' ? 1 : 0,
              stream_position: 0,
            });
          } else if (sql.includes('UPDATE presence SET last_active_ts')) {
            const [ts, userId] = args as [number, string];
            const row = presence.get(userId);
            if (row) presence.set(userId, { ...row, last_active_ts: ts });
          }
          return { success: true, meta: { changes: 1, last_row_id: 0 } };
        },
      });
      return {
        ...stmt([]),
        bind(...bound: unknown[]) {
          return stmt(bound);
        },
      };
    },
    batch: opts.withBatch
      ? async (statements: Array<{ run: () => Promise<unknown> }>) => {
          for (const statement of statements) await statement.run();
          return [];
        }
      : undefined,
  };
  return db;
}

type TestDb = ReturnType<typeof createDb>;

function createKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string, type?: string) {
      const raw = data.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

function createEnv(db: TestDb): Env {
  const kv = createKv();
  const syncDo = { async fetch() { return Response.json({ hasEvents: false }); } };
  const federationDo = { async fetch() { return Response.json({ ok: true }); } };
  return {
    SERVER_NAME: 'example.com',
    SERVER_VERSION: 'test-0.1.0',
    DB: db as unknown as D1Database,
    CACHE: kv as unknown as KVNamespace,
    SESSIONS: kv as unknown as KVNamespace,
    ONE_TIME_KEYS: kv as unknown as KVNamespace,
    SYNC: {
      idFromName: () => ({} as DurableObjectId),
      get: () => syncDo as unknown as DurableObjectStub,
    },
    FEDERATION: {
      idFromName: () => ({} as DurableObjectId),
      get: () => federationDo as unknown as DurableObjectStub,
    },
  } as unknown as Env;
}

type SyncBody = { next_batch: string; presence: { events: unknown[] } };

async function syncRequest(env: Env, since?: string) {
  const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
  const res = await syncApp.request(`http://localhost/_matrix/client/v3/sync${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as SyncBody };
}

async function putStatus(env: Env, userId: string, body: unknown) {
  const path = `/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
  const res = await presenceApp.request(
    `http://localhost${path}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify(body),
    },
    env
  );
  return { status: res.status, body: await res.json() };
}

async function sendPresenceEdu(env: Env, txnId: string, push: unknown[]) {
  const res = await federationApp.request(
    `http://localhost/_matrix/federation/v1/send/${txnId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdus: [],
        edus: [{ edu_type: 'm.presence', content: { push } }],
      }),
    },
    env
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  syncMocks.getUserRooms.mockImplementation(async (_db, _userId, membership?: string) =>
    membership === 'join' ? [ROOM] : []
  );
  syncMocks.getLatestStreamPosition.mockResolvedValue(100);
  syncMocks.getInvitePermission.mockResolvedValue('allow');
  noopMocks.getToDeviceMessages.mockResolvedValue({ events: [], nextBatch: '0' });
  noopMocks.getGlobalAccountData.mockResolvedValue([]);
  noopMocks.getRoomAccountData.mockResolvedValue([]);
  noopMocks.getReceiptsForRoom.mockResolvedValue({ type: 'm.receipt', content: {} });
  noopMocks.getTypingUsers.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('presence stream token', () => {
  it('round-trips _pr alone and alongside _ad/_dk', () => {
    expect(parseSyncToken('s1_td2_pr3')).toEqual({ events: 1, toDevice: 2, presence: 3 });
    expect(parseSyncToken('s1_td2_ad3_dk4_pr5')).toEqual({
      events: 1,
      toDevice: 2,
      accountData: 3,
      deviceKeys: 4,
      presence: 5,
    });
    expect(buildSyncToken(1, 2, 0, 0, 3)).toBe('s1_td2_pr3');
    expect(buildSyncToken(1, 2, 3, 4, 5)).toBe('s1_td2_ad3_dk4_pr5');
    expect(parseSyncToken(buildSyncToken(7, 8, 0, 0, 9))).toEqual({
      events: 7,
      toDevice: 8,
      presence: 9,
    });
  });

  it('keeps legacy tokens valid without a presence field', () => {
    expect(parseSyncToken('s1_td2')).toEqual({ events: 1, toDevice: 2 });
    expect(parseSyncToken('42')).toEqual({ events: 42, toDevice: 42 });
    expect(buildSyncToken(1, 2)).toBe('s1_td2');
    expect(parseSyncToken('s1_td2_pr')).toEqual({ events: 0, toDevice: 0 });
  });
});

describe('incremental presence in legacy /sync', () => {
  it('bumps and stamps in one D1 batch when batch() is available', async () => {
    const db = createDb({ withBatch: true });
    const env = createEnv(db);
    await putStatus(env, USER, { presence: 'online' });

    expect(db.streamPositions.get('presence')).toBe(1);
    expect(db.presence.get(USER)?.stream_position).toBe(1);
    const counterBumps = db.sqlCalls.filter(
      (call) => call.kind === 'run' && call.sql.includes('UPDATE stream_positions')
    );
    const rowWrites = db.sqlCalls.filter(
      (call) => call.kind === 'run' && call.sql.includes('INSERT INTO presence')
    );
    expect(counterBumps).toHaveLength(1);
    expect(rowWrites).toHaveLength(1);
    expect(rowWrites[0].sql).toContain("SELECT position FROM stream_positions");
  });

  it('PUT then sync with an old token emits one event and advances _pr', async () => {
    const db = createDb();
    const env = createEnv(db);

    const before = await syncRequest(env, 's0_td0');
    expect(before.status).toBe(200);
    expect(before.body.next_batch).toBe('s100_td0');

    const put = await putStatus(env, USER, { presence: 'online', status_msg: 'here' });
    expect(put.status).toBe(200);
    expect(db.streamPositions.get('presence')).toBe(1);
    expect(db.presence.get(USER)).toMatchObject({
      presence: 'online',
      currently_active: 1,
      stream_position: 1,
      last_active_ts: NOW,
    });

    vi.setSystemTime(NOW + 5_000);
    const after = await syncRequest(env, before.body.next_batch);
    expect(after.body.presence.events).toEqual([
      {
        type: 'm.presence',
        sender: USER,
        content: {
          presence: 'online',
          status_msg: 'here',
          last_active_ago: 5_000,
          currently_active: true,
        },
      },
    ]);
    expect(after.body.next_batch).toBe('s100_td0_pr1');
  });

  it('a second sync with the returned token emits nothing until another change', async () => {
    const db = createDb();
    const env = createEnv(db);

    await putStatus(env, USER, { presence: 'online' });
    const first = await syncRequest(env, 's0_td0');
    expect(first.body.presence.events).toHaveLength(1);
    expect(first.body.next_batch).toBe('s100_td0_pr1');

    const second = await syncRequest(env, first.body.next_batch);
    expect(second.body.presence.events).toEqual([]);
    expect(second.body.next_batch).toBe('s100_td0_pr1');

    vi.setSystemTime(NOW + 10_000);
    await putStatus(env, USER, { presence: 'offline' });
    vi.setSystemTime(NOW + 12_000);
    const third = await syncRequest(env, first.body.next_batch);
    expect(third.body.presence.events).toEqual([
      {
        type: 'm.presence',
        sender: USER,
        content: {
          presence: 'offline',
          last_active_ago: 2_000,
          currently_active: false,
        },
      },
    ]);
    expect(third.body.next_batch).toBe('s100_td0_pr2');
  });

  it('an inbound m.presence EDU stamps the row and is emitted by /sync', async () => {
    const db = createDb();
    const env = createEnv(db);
    const before = await syncRequest(env, 's0_td0');

    const edu = await sendPresenceEdu(env, 'txn-pres-1', [
      {
        user_id: BOB,
        presence: 'online',
        status_msg: 'remote',
        last_active_ago: 2_000,
        currently_active: true,
      },
    ]);
    expect(edu.status).toBe(200);
    expect(db.streamPositions.get('presence')).toBe(1);
    expect(db.presence.get(BOB)).toMatchObject({
      presence: 'online',
      status_msg: 'remote',
      last_active_ts: NOW - 2_000,
      currently_active: 1,
      stream_position: 1,
    });

    const after = await syncRequest(env, before.body.next_batch);
    expect(after.body.presence.events).toEqual([
      {
        type: 'm.presence',
        sender: BOB,
        content: {
          presence: 'online',
          status_msg: 'remote',
          last_active_ago: 2_000,
          currently_active: true,
        },
      },
    ]);
    expect(after.body.next_batch).toBe('s100_td0_pr1');
  });

  it('excludes users who do not share a room with the caller', async () => {
    const db = createDb({
      presence: [
        {
          user_id: CAROL,
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW,
          currently_active: 1,
          stream_position: 1,
        },
      ],
      presencePos: 1,
    });
    const env = createEnv(db);

    const { body } = await syncRequest(env, 's0_td0');
    expect(body.presence.events).toEqual([]);
    expect(
      db.sqlCalls.some(
        (call) => call.kind === 'all' && call.sql.includes('rm2.user_id = p.user_id')
      )
    ).toBe(true);
  });

  it('an initial sync still sends current presence for shared-room users', async () => {
    const db = createDb({
      presence: [
        {
          user_id: BOB,
          presence: 'online',
          status_msg: 'hi',
          last_active_ts: NOW - 1_000,
          currently_active: 1,
          stream_position: 1,
        },
      ],
      presencePos: 1,
    });
    const env = createEnv(db);

    const { body } = await syncRequest(env);
    expect(body.presence.events).toEqual([
      {
        type: 'm.presence',
        sender: BOB,
        content: {
          presence: 'online',
          status_msg: 'hi',
          last_active_ago: 1_000,
          currently_active: true,
        },
      },
    ]);
    expect(body.next_batch).toBe('s100_td0_pr1');
  });

  it('a present but corrupt _pr token falls back to zero', async () => {
    const db = createDb();
    const env = createEnv(db);
    await putStatus(env, USER, { presence: 'online' });
    const { body } = await syncRequest(env, 's0_td0_prgarbage');
    expect(body.presence.events).toHaveLength(1);
  });
});
