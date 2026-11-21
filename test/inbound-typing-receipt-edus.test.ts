// Inbound federation m.typing / m.receipt EDUs: transaction → Room DO → sync.
// Harness mirrors the federation transaction EDU tests in federation-api-routes.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const FED_ORIGIN = 'remote.example.org';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      c.set('federationOrigin', FED_ORIGIN);
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>
    ) => {
      c.set('federationOrigin', FED_ORIGIN);
      await next();
    };
  },
}));

import federationApp from '../src/api/federation';
import { getReceiptsForRoom } from '../src/api/receipts';

const SERVER = 'example.com';
const ROOM = '!r:example.com';
const UNKNOWN_ROOM = '!unknown:example.com';
const REMOTE_USER = `@bob:${FED_ORIGIN}`;
const LOCAL_USER = `@alice:${SERVER}`;
const EVENT = '$event1:example.com';
const EVENT2 = '$event2:example.com';
const THREAD = '$thread:example.com';

type ReceiptValue = { ts: number; thread_id?: string };
type RoomFetch = { url: string; method: string; body?: any };

function createRoomDOStub(roomId: string) {
  const fetches: RoomFetch[] = [];
  const typingUsers = new Set<string>();
  const receipts: Record<string, Record<string, Record<string, ReceiptValue>>> = {};

  return {
    roomId,
    fetches,
    typingUsers,
    receipts,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      let body: any;
      try {
        body = await req.json();
      } catch {
        body = undefined;
      }
      fetches.push({ url: url.pathname, method: req.method, body });

      if (url.pathname === '/typing' && req.method === 'PUT') {
        if (body?.typing === true) typingUsers.add(body.user_id);
        else typingUsers.delete(body.user_id);
        return new Response('OK');
      }
      if (url.pathname === '/typing' && req.method === 'GET') {
        return Response.json({ user_ids: [...typingUsers] });
      }
      if (url.pathname === '/receipt' && req.method === 'PUT') {
        const { event_id, receipt_type, user_id, thread_id } = body ?? {};
        receipts[event_id] ??= {};
        receipts[event_id][receipt_type] ??= {};
        receipts[event_id][receipt_type][user_id] = {
          ts: Date.now(),
          ...(thread_id ? { thread_id } : {}),
        };
        return new Response('OK');
      }
      if (url.pathname === '/receipts' && req.method === 'GET') {
        return Response.json({ receipts });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}

type RoomDOStub = ReturnType<typeof createRoomDOStub>;

function createDb() {
  const knownRooms = new Set([ROOM]);
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM federation_transactions')) return null;
              if (sql.includes('FROM rooms WHERE room_id = ?')) {
                const roomId = args[0] as string;
                return (knownRooms.has(roomId)
                  ? { room_id: roomId, room_version: '10', is_public: 0, created_at: 1 }
                  : null) as T;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              inserts.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { db, inserts };
}

function createFederationStub() {
  const fetches: Array<{ url: string; body: unknown }> = [];
  const ids: string[] = [];
  return {
    fetches,
    ids,
    idFromName(name: string) {
      ids.push(name);
      return { name, toString: () => name };
    },
    get(id: { name: string }) {
      return {
        fetch: async (req: Request) => {
          fetches.push({ url: req.url, body: await req.json() });
          return Response.json({ ok: true });
        },
      };
    },
  };
}

function createEnv() {
  const { db, inserts } = createDb();
  const rooms = new Map<string, RoomDOStub>();
  const federation = createFederationStub();
  const env = {
    DB: db as unknown as D1Database,
    CACHE: {} as KVNamespace,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
    ROOMS: {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: (id: { name: string }) => {
        if (!rooms.has(id.name)) rooms.set(id.name, createRoomDOStub(id.name));
        return rooms.get(id.name) as RoomDOStub;
      },
    },
    FEDERATION: federation,
    _db: db,
    _rooms: rooms,
    _federation: federation,
    _inserts: inserts,
  };
  return env as unknown as Env & typeof env;
}

async function sendEdus(env: Env, txnId: string, edus: unknown[]) {
  const res = await federationApp.request(
    `http://localhost/_matrix/federation/v1/send/${txnId}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdus: [], edus }),
    },
    env
  );
  return { status: res.status, body: await res.json() };
}

function typingEdu(roomId: string, userId: string, typing: boolean) {
  return { edu_type: 'm.typing', content: { room_id: roomId, user_id: userId, typing } };
}

function receiptEdu(roomId: string, content: Record<string, unknown>) {
  return { edu_type: 'm.receipt', content: { room_id: roomId, content } };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('inbound m.typing EDUs', () => {
  it('delivers typing start and stop to the Room DO, without timeout', async () => {
    const env = createEnv();
    const start = await sendEdus(env, 'txn-typing-start', [
      typingEdu(ROOM, REMOTE_USER, true),
    ]);
    expect(start.status).toBe(200);

    const room = env._rooms.get(ROOM)!;
    expect(room.typingUsers.has(REMOTE_USER)).toBe(true);
    expect(room.fetches[0]).toMatchObject({
      url: '/typing',
      method: 'PUT',
      body: { user_id: REMOTE_USER, typing: true },
    });
    expect(room.fetches[0].body).not.toHaveProperty('timeout');

    const stop = await sendEdus(env, 'txn-typing-stop', [
      typingEdu(ROOM, REMOTE_USER, false),
    ]);
    expect(stop.status).toBe(200);
    expect(room.typingUsers.has(REMOTE_USER)).toBe(false);
  });
});

describe('inbound m.receipt EDUs', () => {
  it('stores m.read so getReceiptsForRoom sees it, including thread_id', async () => {
    const env = createEnv();
    const res = await sendEdus(env, 'txn-receipt-read', [
      receiptEdu(ROOM, {
        [EVENT]: { 'm.read': { [REMOTE_USER]: { ts: 1, thread_id: THREAD } } },
        [EVENT2]: { 'm.read': { [REMOTE_USER]: { ts: 2 } } },
      }),
    ]);
    expect(res.status).toBe(200);

    const receipts = await getReceiptsForRoom(env, ROOM, LOCAL_USER);
    expect(receipts.content[EVENT]['m.read'][REMOTE_USER].thread_id).toBe(THREAD);
    expect(receipts.content[EVENT2]['m.read'][REMOTE_USER].ts).toEqual(expect.any(Number));
    expect(receipts.content[EVENT2]['m.read'][REMOTE_USER]).not.toHaveProperty('thread_id');

    const room = env._rooms.get(ROOM)!;
    expect(room.fetches[0]).toMatchObject({
      url: '/receipt',
      method: 'PUT',
      body: {
        user_id: REMOTE_USER,
        event_id: EVENT,
        receipt_type: 'm.read',
        thread_id: THREAD,
      },
    });
  });

  it('ignores m.read.private and m.fully_read from remote servers', async () => {
    const env = createEnv();
    const res = await sendEdus(env, 'txn-receipt-private', [
      receiptEdu(ROOM, {
        [EVENT]: {
          'm.read.private': { [REMOTE_USER]: { ts: 1 } },
          'm.fully_read': { [REMOTE_USER]: { ts: 1 } },
        },
      }),
    ]);
    expect(res.status).toBe(200);
    expect(env._rooms.get(ROOM)?.fetches ?? []).toHaveLength(0);
    const receipts = await getReceiptsForRoom(env, ROOM, LOCAL_USER);
    expect(receipts.content).toEqual({});
  });
});

describe('inbound EDU robustness', () => {
  it('skips unknown rooms without aborting the rest of the transaction', async () => {
    const env = createEnv();
    const res = await sendEdus(env, 'txn-unknown-room', [
      typingEdu(UNKNOWN_ROOM, REMOTE_USER, true),
      receiptEdu(ROOM, { [EVENT]: { 'm.read': { [REMOTE_USER]: { ts: 1 } } } }),
    ]);
    expect(res.status).toBe(200);
    expect(env._rooms.get(UNKNOWN_ROOM)?.fetches ?? []).toHaveLength(0);
    expect(env._rooms.get(ROOM)!.receipts[EVENT]['m.read'][REMOTE_USER]).toBeDefined();
    // Both EDUs still recorded by the transaction loop.
    expect(env._inserts.filter((i) => i.sql.includes('processed_edus'))).toHaveLength(2);
  });

  it('a malformed EDU does not abort a following valid EDU', async () => {
    const env = createEnv();
    const res = await sendEdus(env, 'txn-malformed', [
      { edu_type: 'm.typing', content: { room_id: ROOM, user_id: REMOTE_USER } },
      typingEdu(ROOM, REMOTE_USER, true),
    ]);
    expect(res.status).toBe(200);
    expect(env._rooms.get(ROOM)!.typingUsers.has(REMOTE_USER)).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it('never queues outbound EDUs for inbound delivery', async () => {
    const env = createEnv();
    const res = await sendEdus(env, 'txn-no-echo', [
      typingEdu(ROOM, REMOTE_USER, true),
      receiptEdu(ROOM, { [EVENT]: { 'm.read': { [REMOTE_USER]: { ts: 1 } } } }),
    ]);
    expect(res.status).toBe(200);
    expect(env._federation.fetches).toHaveLength(0);
    expect(env._federation.ids).toHaveLength(0);
  });
});
