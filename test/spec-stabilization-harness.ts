/**
 * Shared in-memory D1/DO doubles for the v1.18/v1.19 stabilization
 * regression tests (MSC4287 / MSC4356 / MSC2545 / MSC4268).
 *
 * Tests which import this module keep their own `vi.mock('../src/middleware/auth')`
 * so the authenticated user can be pinned per file; everything below is
 * transport/storage only and never mocks the route modules under test.
 */
import type { Env } from '../src/types';

export const SERVER = 'example.com';
export const USER = '@alice:example.com';
export const BOB = '@bob:example.com';
export const ROOM = '!room:example.com';

export type AccountDataRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
};

export type ChangeRow = {
  user_id: string;
  room_id: string;
  event_type: string;
  stream_position: number;
};

export type ToDeviceRow = {
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  event_type: string;
  content: string;
  message_id: string;
  stream_position: number;
  delivered: number;
};

export type MembershipRow = { room_id: string; user_id: string; membership: string };

export function mockKv(data: Record<string, string> = {}) {
  const kv = {
    data,
    async get(key: string, type?: string) {
      const raw = data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      data[key] = value;
    },
    async delete(key: string) {
      delete data[key];
    },
  };
  return kv as unknown as KVNamespace & { data: Record<string, string> };
}

/**
 * A D1 double that serves the SQL used by account-data PUT/GET, /sync,
 * sliding-sync's account_data extension, to-device send + sync delivery,
 * and /keys/query signature merging. Unrecognised reads return empty
 * result sets so unrelated route bookkeeping never fails a test.
 */
export function createSharedDb(opts: {
  accountData?: AccountDataRow[];
  memberships?: MembershipRow[];
  toDevice?: ToDeviceRow[];
  maxStreamOrdering?: number;
} = {}) {
  const accountData: AccountDataRow[] = [...(opts.accountData ?? [])];
  const memberships: MembershipRow[] = [...(opts.memberships ?? [])];
  const toDevice: ToDeviceRow[] = [...(opts.toDevice ?? [])];
  const changes: ChangeRow[] = [];
  const txns = new Map<string, string>();
  const streamPositions = new Map<string, number>([
    ['account_data', 0],
    ['to_device', 0],
    ['device_keys', 0],
    ['presence', 0],
  ]);
  const maxStreamOrdering = opts.maxStreamOrdering ?? 0;

  const upsertAccountData = (userId: string, roomId: string, eventType: string, content: string) => {
    const existing = accountData.find(
      (r) => r.user_id === userId && r.room_id === roomId && r.event_type === eventType
    );
    if (existing) existing.content = content;
    else accountData.push({ user_id: userId, room_id: roomId, event_type: eventType, content });
  };

  const db = {
    accountData,
    memberships,
    toDevice,
    changes,
    streamPositions,
    prepare(sql: string) {
      const statement = (args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
              if (sql.includes('SELECT membership FROM room_memberships')) {
                const [roomId, userId] = args as [string, string];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T | null;
              }
              if (sql.includes('SELECT position FROM stream_positions')) {
                const [name] = args as [string];
                return { position: streamPositions.get(name) ?? 0 } as T;
              }
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING position')) {
                const [name] = args as [string];
                const next = (streamPositions.get(name) ?? 0) + 1;
                streamPositions.set(name, next);
                return { position: next } as T;
              }
              if (sql.includes('INSERT INTO stream_positions') && sql.includes('RETURNING position')) {
                const [name] = args as [string];
                const next = (streamPositions.get(name) ?? 0) + 1;
                streamPositions.set(name, next);
                return { position: next } as T;
              }
              if (sql.includes('SELECT response FROM transaction_ids')) {
                const [userId, txnId] = args as [string, string];
                const response = txns.get(`${userId}|${txnId}`);
                return (response === undefined ? null : { response }) as T | null;
              }
              if (sql.includes('SELECT content FROM account_data') && sql.includes("room_id = ''")) {
                const [userId, eventType] = args as [string, string];
                const row = accountData.find(
                  (r) => r.user_id === userId && r.room_id === '' && r.event_type === eventType
                );
                return (row ? { content: row.content } : null) as T | null;
              }
              if (sql.includes('SELECT content FROM account_data')) {
                const [userId, roomId, eventType] = args as [string, string, string];
                const row = accountData.find(
                  (r) =>
                    r.user_id === userId && r.room_id === roomId && r.event_type === eventType
                );
                return (row ? { content: row.content } : null) as T | null;
              }
              if (sql.includes('MAX(stream_ordering)')) {
                if (sql.includes('max_pos')) return { max_pos: maxStreamOrdering } as T;
                return { max_ordering: maxStreamOrdering } as T;
              }
              if (sql.includes('MAX(stream_position)') && sql.includes('to_device_messages')) {
                const max = toDevice.reduce((m, r) => Math.max(m, r.stream_position), 0);
                return { max_pos: max } as T;
              }
              return null as T | null;
            },

            async all<T>(): Promise<{ results: T[] }> {
              if (
                sql.includes('FROM account_data') &&
                sql.includes('event_type LIKE ?')
              ) {
                // MSC4354 sticky query — deliberately not returned by the
                // account_data / sync extensions.
                return { results: [] as T[] };
              }
              if (
                sql.includes('SELECT event_type, content FROM account_data') &&
                sql.includes("room_id = ''")
              ) {
                const [userId] = args as string[];
                return {
                  results: accountData
                    .filter((r) => r.user_id === userId && r.room_id === '')
                    .map((r) => ({ event_type: r.event_type, content: r.content })) as unknown as T[],
                };
              }
              if (sql.includes('SELECT event_type, content FROM account_data')) {
                const [userId, roomId] = args as string[];
                return {
                  results: accountData
                    .filter((r) => r.user_id === userId && r.room_id === roomId)
                    .map((r) => ({ event_type: r.event_type, content: r.content })) as unknown as T[],
                };
              }
              if (sql.includes('FROM room_memberships')) {
                const [userId] = args as string[];
                const wanted = sql.includes('membership = ?') ? (args[1] as string) : undefined;
                return {
                  results: memberships
                    .filter(
                      (m) => m.user_id === userId && (wanted === undefined || m.membership === wanted)
                    )
                    .map((m) => ({ room_id: m.room_id })) as unknown as T[],
                };
              }
              if (sql.includes('FROM to_device_messages') && sql.includes('SELECT id,')) {
                const [userId, deviceId, since] = args as [string, string, number];
                const limit = (args[3] as number) ?? 100;
                const rows = toDevice
                  .filter(
                    (r) =>
                      r.recipient_user_id === userId &&
                      r.recipient_device_id === deviceId &&
                      r.delivered === 0 &&
                      r.stream_position > since
                  )
                  .sort((a, b) => a.stream_position - b.stream_position)
                  .slice(0, limit)
                  .map((r) => ({
                    id: r.stream_position,
                    sender_user_id: r.sender_user_id,
                    event_type: r.event_type,
                    content: r.content,
                    stream_position: r.stream_position,
                  }));
                return { results: rows as unknown as T[] };
              }
              return { results: [] as T[] };
            },

            async run() {
              if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
                const [name] = args as [string];
                streamPositions.set(name, (streamPositions.get(name) ?? 0) + 1);
              } else if (sql.includes('INSERT INTO account_data_changes')) {
                const [userId, roomId, eventType, streamPosition] = args as [string, string, string, number];
                changes.push({
                  user_id: userId,
                  room_id: roomId,
                  event_type: eventType,
                  stream_position: streamPosition,
                });
              } else if (sql.includes('INSERT INTO account_data')) {
                // Global PUT binds (user, type, content) with a literal '';
                // room PUT binds (user, room, type, content).
                if (args.length === 3) {
                  const [userId, eventType, content] = args as [string, string, string];
                  upsertAccountData(userId, '', eventType, content);
                } else {
                  const [userId, roomId, eventType, content] = args as [string, string, string, string];
                  upsertAccountData(userId, roomId, eventType, content);
                }
              } else if (sql.includes('INSERT INTO to_device_messages')) {
                const [
                  recipientUserId,
                  recipientDeviceId,
                  senderUserId,
                  eventType,
                  content,
                  messageId,
                  streamPosition,
                ] = args as [string, string, string, string, string, string, number];
                toDevice.push({
                  recipient_user_id: recipientUserId,
                  recipient_device_id: recipientDeviceId,
                  sender_user_id: senderUserId,
                  event_type: eventType,
                  content,
                  message_id: messageId,
                  stream_position: streamPosition,
                  delivered: 0,
                });
              } else if (sql.includes('UPDATE to_device_messages SET delivered = 1')) {
                const [userId, deviceId, since] = args as [string, string, number];
                for (const row of toDevice) {
                  if (
                    row.recipient_user_id === userId &&
                    row.recipient_device_id === deviceId &&
                    row.stream_position <= since
                  ) {
                    row.delivered = 1;
                  }
                }
              } else if (sql.includes('INSERT INTO transaction_ids')) {
                const [userId, txnId, response = '{}'] = args as [string, string, string?];
                txns.set(`${userId}|${txnId}`, response);
              }
              return { success: true, meta: { changes: 1, last_row_id: 0 } };
            },
        });
      return {
        ...statement([]),
        bind: (...args: unknown[]) => statement(args),
      };
    },
  };

  return db as unknown as D1Database & typeof db;
}

export type SharedDb = ReturnType<typeof createSharedDb>;

/** SYNC DO stub: long-poll waits, account-data wakes and sliding-sync state. */
export function createSyncDoStub() {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  const states = new Map<string, unknown>();
  return {
    fetches,
    states,
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init);
      let body: unknown;
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      if (req.url.includes('/wait-for-events')) return Response.json({ hasEvents: false });
      if (req.url.includes('/sliding-sync/state') && req.method === 'GET') {
        const connId = new URL(req.url).searchParams.get('conn_id') ?? 'default';
        return Response.json(states.get(connId) ?? null);
      }
      if (req.url.includes('/sliding-sync/state') && req.method === 'PUT') {
        const connId = new URL(req.url).searchParams.get('conn_id') ?? 'default';
        states.set(connId, body);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  };
}

export function createUserKeysStub(opts: {
  deviceKeys?: Record<string, unknown>;
  crossSigning?: Record<string, unknown>;
} = {}) {
  const deviceKeys = opts.deviceKeys ?? {};
  const crossSigning = opts.crossSigning ?? {};
  return {
    deviceKeys,
    crossSigning,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === '/account-data/get') {
        const eventType = url.searchParams.get('event_type');
        return Response.json(eventType ? null : {});
      }
      if (url.pathname === '/device-keys/get') {
        const deviceId = url.searchParams.get('device_id');
        return Response.json(deviceId ? (deviceKeys[deviceId] ?? null) : deviceKeys);
      }
      if (url.pathname === '/cross-signing/get') return Response.json(crossSigning);
      return Response.json({});
    },
  };
}

export function createFederationStub() {
  const fetches: Array<{ url: string; method: string; body?: unknown }> = [];
  return {
    fetches,
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init);
      let body: unknown;
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: req.url, method: req.method, body });
      return Response.json({ ok: true });
    },
  };
}

export function createEnv(opts: {
  db?: SharedDb;
  syncDo?: ReturnType<typeof createSyncDoStub>;
  userKeys?: ReturnType<typeof createUserKeysStub>;
  federationDo?: ReturnType<typeof createFederationStub>;
} = {}) {
  const db = opts.db ?? createSharedDb();
  const syncDo = opts.syncDo ?? createSyncDoStub();
  const userKeys = opts.userKeys ?? createUserKeysStub();
  const federationDo = opts.federationDo ?? createFederationStub();
  const env = {
    DB: db,
    CACHE: mockKv(),
    ACCOUNT_DATA: mockKv(),
    SERVER_NAME: SERVER,
    SYNC: {
      idFromName: (name: string) => name,
      get: () => syncDo,
    },
    USER_KEYS: {
      idFromName: (name: string) => name,
      get: () => userKeys,
    },
    FEDERATION: {
      idFromName: (name: string) => name,
      get: () => federationDo,
    },
    _db: db,
    _syncDo: syncDo,
    _userKeys: userKeys,
    _federationDo: federationDo,
  };
  return env as unknown as Env & typeof env;
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export async function parseResponse(res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}
