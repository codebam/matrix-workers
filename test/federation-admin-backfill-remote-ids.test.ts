// Admin /state re-sync must store resident-authored remote events under the
// IDs the residents use, including pre-2023 `origin` events whose real ID
// follows the legacy redaction keep-list.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const SERVER = 'example.com';
const ROOM = '!iDwfRnmIeZCSTKVEim:halogen.city';
const ADMIN = `@admin:${SERVER}`;
const RESIDENT = 'halogen.city';
const USER = '@mazunki:halogen.city';

const storeEventIdempotentMock = vi.hoisted(() =>
  vi.fn(async () => ({ inserted: true, streamOrdering: 1 }))
);
const updateMembershipMock = vi.hoisted(() => vi.fn(async () => true));
const federationGetMock = vi.hoisted(() => vi.fn());

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', ADMIN);
    await next();
  },
}));

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: vi.fn(async () => ({ user_id: ADMIN, admin: true })),
    storeEventIdempotent: storeEventIdempotentMock,
    updateMembership: updateMembershipMock,
  };
});

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return { ...actual, federationGet: federationGetMock };
});

import admin from '../src/api/admin';
import { computeWireEventId } from '../src/utils/event-signing';

const createEvent = {
  auth_events: [],
  content: { creator: USER, room_version: '9' },
  depth: 1,
  hashes: { sha256: 'fWw9Z86qj9PugtVK3a+9cpPn6ihyvBIci2UzYWGxTcg' },
  origin: RESIDENT,
  origin_server_ts: 1654943205025,
  prev_events: [],
  prev_state: [],
  room_id: ROOM,
  sender: USER,
  signatures: { [RESIDENT]: { 'ed25519:a_FRIi': 'sig' } },
  state_key: '',
  type: 'm.room.create',
};

const memberEvent = {
  ...createEvent,
  content: { membership: 'join' },
  depth: 2,
  origin_server_ts: 1654943205026,
  prev_events: ['$prev'],
  state_key: USER,
  type: 'm.room.member',
};

function createEnv(heldIds: Set<string> = new Set()) {
  const membershipWrites: Array<unknown[]> = [];
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT room_version FROM rooms')) return { room_version: '9' } as T;
              if (sql.includes('SELECT 1 FROM events WHERE event_id = ?')) {
                return heldIds.has(args[0] as string) ? ({} as T) : null;
              }
              if (sql.includes('ORDER BY stream_ordering DESC')) return { event_id: '$latest' } as T;
              return null as T;
            },
            async all<T>() { return { results: [] as T[] }; },
            async run() {
              if (sql.includes('room_memberships')) membershipWrites.push(args);
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(stmts: unknown[]) {
      for (const stmt of stmts) await (stmt as { run: () => Promise<unknown> }).run();
      return stmts;
    },
  };
  const env = {
    DB: db as unknown as D1Database,
    CACHE: {} as KVNamespace,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
  };
  return { env: env as unknown as Env, membershipWrites, queries };
}

beforeEach(() => {
  storeEventIdempotentMock.mockClear();
  updateMembershipMock.mockClear();
  federationGetMock.mockReset();
  federationGetMock.mockResolvedValue(
    Response.json({ pdus: [createEvent, memberEvent], auth_chain: [] })
  );
});

describe('admin /state backfill preserves resident event IDs', () => {
  it('stores origin-bearing remote state under the legacy-derived resident ID', async () => {
    const { env, membershipWrites } = createEnv();
    const createId = await computeWireEventId(createEvent, '2');
    const memberId = await computeWireEventId(memberEvent, '2');
    expect(await computeWireEventId(createEvent, '9')).not.toBe(createId);

    const res = await admin.request(
      `http://localhost/admin/api/rooms/${encodeURIComponent(ROOM)}/backfill?server=${RESIDENT}`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(200);
    // Non-member state is stored as events; members are batched into
    // room_memberships only (see the admin backfill route).
    expect(storeEventIdempotentMock).toHaveBeenCalledTimes(1);
    expect((storeEventIdempotentMock.mock.calls[0][1] as any).event_id).toBe(createId);
    expect(membershipWrites[0][3]).toBe(memberId);
  });

  it('reuses an already-stored resident ID instead of deriving a phantom twin', async () => {
    const legacyCreateId = await computeWireEventId(createEvent, '2');
    const legacyMemberId = await computeWireEventId(memberEvent, '2');
    const { env, membershipWrites } = createEnv(new Set([legacyCreateId, legacyMemberId]));

    const res = await admin.request(
      `http://localhost/admin/api/rooms/${encodeURIComponent(ROOM)}/backfill?server=${RESIDENT}`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(200);
    expect((storeEventIdempotentMock.mock.calls[0][1] as any).event_id).toBe(legacyCreateId);
    expect(membershipWrites[0][3]).toBe(legacyMemberId);
  });

  it('anchors /state at the newest room event, not the newest event from one server', async () => {
    const { env, queries } = createEnv();
    const res = await admin.request(
      `http://localhost/admin/api/rooms/${encodeURIComponent(ROOM)}/backfill?server=${RESIDENT}`,
      { method: 'POST' },
      env
    );

    expect(res.status).toBe(200);
    const anchorQuery = queries.find((sql) => sql.includes('ORDER BY stream_ordering DESC'));
    expect(anchorQuery).toBeDefined();
    expect(anchorQuery).toContain('stream_ordering > 0');
    expect(anchorQuery).not.toContain('sender LIKE');
  });
});
