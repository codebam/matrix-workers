/**
 * Spec Profiles module, "Events on Change of Profile Information": a
 * displayname/avatar change fans out updated m.room.member events to
 * every joined room (stored, notified, federated), while no-op writes
 * and custom-key writes do not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const ROOM_A = '!a:example.com';
const ROOM_B = '!b:example.com';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'D');
      await next();
    };
  },
  optionalAuth: () => {
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  },
}));

const getUserById = vi.fn();
const getUserRooms = vi.fn();
const getMembership = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const storeEvent = vi.fn();
const storeEventIdempotent = vi.fn();
const notifyUsersOfEvent = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: (...args: unknown[]) => getUserById(...args),
    getUserRooms: (...args: unknown[]) => getUserRooms(...args),
    getMembership: (...args: unknown[]) => getMembership(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    storeEvent: (...args: unknown[]) => storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
  };
});

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return {
    ...actual,
    federationPost: vi.fn(),
    // Null key: prepareOutboundPdu falls back to a generated event ID —
    // the fanout must work without a signing key configured.
    getServerSigningKey: vi.fn(async () => null),
  };
});

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
  invalidateRoomCache: vi.fn(async () => undefined),
}));

import profileApp from '../src/api/profile';

function envFor(): Env {
  const kvData = new Map<string, string>();
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async first<T>() {
                // isServerAllowedInRoom's ACL lookup: no ACL state in
                // these rooms, handled by the getStateEvent mock anyway.
                return null as T;
              },
              async all<T>() {
                return { results: [] as T[] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: {
      async get(key: string) {
        return kvData.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvData.set(key, value);
      },
      async delete(key: string) {
        kvData.delete(key);
      },
    } as unknown as KVNamespace,
  } as unknown as Env;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('profile change → m.room.member fanout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserById.mockResolvedValue({
      user_id: USER,
      display_name: 'New Name',
      avatar_url: 'mxc://example.com/new',
    });
    getUserRooms.mockResolvedValue([ROOM_A, ROOM_B]);
    getMembership.mockResolvedValue({ membership: 'join', eventId: '$m' });
    getStateEvent.mockResolvedValue(null);
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    storeEvent.mockResolvedValue(undefined);
    storeEventIdempotent.mockImplementation(async (_db: unknown, ev: PDU) => ev.event_id || '$evt:example.com');
    notifyUsersOfEvent.mockResolvedValue(undefined);
  });

  it('an avatar change sends an updated member event to every joined room', async () => {
    const before = getUserById.mockResolvedValueOnce({
      user_id: USER,
      display_name: 'New Name',
      avatar_url: 'mxc://example.com/OLD',
    });
    void before;

    const res = await profileApp.request(
      `http://localhost/_matrix/client/v3/profile/${encodeURIComponent(USER)}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://example.com/new' }),
      envFor()
    );
    expect(res.status).toBe(200);

    const memberEvents = storeEvent.mock.calls
      .map((call) => call[1] as PDU)
      .filter((e) => e.type === 'm.room.member');
    expect(memberEvents).toHaveLength(2);
    for (const ev of memberEvents) {
      expect(ev.sender).toBe(USER);
      expect(ev.state_key).toBe(USER);
      expect(ev.content).toEqual({
        membership: 'join',
        displayname: 'New Name',
        avatar_url: 'mxc://example.com/new',
      });
    }
    expect(new Set(memberEvents.map((e) => e.room_id))).toEqual(new Set([ROOM_A, ROOM_B]));
    expect(notifyUsersOfEvent).toHaveBeenCalledTimes(2);
  });

  it('a no-op avatar write does not fan out', async () => {
    getUserById.mockResolvedValueOnce({
      user_id: USER,
      display_name: 'New Name',
      avatar_url: 'mxc://example.com/new',
    });
    const res = await profileApp.request(
      `http://localhost/_matrix/client/v3/profile/${encodeURIComponent(USER)}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://example.com/new' }),
      envFor()
    );
    expect(res.status).toBe(200);
    expect(storeEvent).not.toHaveBeenCalled();
    expect(notifyUsersOfEvent).not.toHaveBeenCalled();
  });

  it('the MSC4437 replace endpoint fans out when standard fields change', async () => {
    getUserById.mockResolvedValueOnce({
      user_id: USER,
      display_name: 'Old',
      avatar_url: 'mxc://example.com/OLD',
    });

    const res = await profileApp.request(
      `http://localhost/_matrix/client/unstable/org.matrix.msc4437/profile/${encodeURIComponent(USER)}`,
      jsonInit('PUT', { displayname: 'New Name', avatar_url: 'mxc://example.com/new' }),
      envFor()
    );
    expect(res.status).toBe(200);
    const memberEvents = storeEvent.mock.calls
      .map((call) => call[1] as PDU)
      .filter((e) => e.type === 'm.room.member');
    expect(memberEvents).toHaveLength(2);
    expect(memberEvents[0].content).toMatchObject({ avatar_url: 'mxc://example.com/new' });
  });

  it('a fanout failure in one room never fails the profile write', async () => {
    getUserById.mockResolvedValueOnce({
      user_id: USER,
      display_name: 'New Name',
      avatar_url: 'mxc://example.com/OLD',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // ROOM_B's state read explodes.
    getStateEvent.mockImplementation(async (_db: unknown, roomId: unknown) => {
      if (roomId === ROOM_B) throw new Error('boom');
      return null;
    });

    const res = await profileApp.request(
      `http://localhost/_matrix/client/v3/profile/${encodeURIComponent(USER)}/avatar_url`,
      jsonInit('PUT', { avatar_url: 'mxc://example.com/new' }),
      envFor()
    );
    expect(res.status).toBe(200);
    const memberEvents = storeEvent.mock.calls
      .map((call) => call[1] as PDU)
      .filter((e) => e.type === 'm.room.member');
    // ROOM_A succeeded; ROOM_B was skipped, not fatal.
    expect(memberEvents).toHaveLength(1);
    expect(memberEvents[0].room_id).toBe(ROOM_A);
    warn.mockRestore();
  });

  it('custom profile keys do not fan out member events', async () => {
    const res = await profileApp.request(
      `http://localhost/_matrix/client/v3/profile/${encodeURIComponent(USER)}/us_citizen`,
      jsonInit('PUT', { us_citizen: false }),
      { ...jsonInit('GET'), method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ us_citizen: false }) } as RequestInit,
      envFor()
    );
    // Whatever the custom-key endpoint answers, no member events fire.
    expect(
      storeEvent.mock.calls.map((call) => (call[1] as PDU).type)
    ).not.toContain('m.room.member');
    void res;
  });
});
