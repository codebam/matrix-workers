/**
 * Join fallback candidates: a room-ID domain can be dead or serve a broken
 * federation endpoint while other residents are fine (live case: the GNU/Linux
 * room's resident domain 302-redirects to an unrelated host, while the inviter
 * matrix.org serves make_join). The join must fall back to the inviter's
 * server and other participating servers, never the local server, deduped.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('userId', '@alice:example.com');
    c.set('deviceId', 'DEV1');
    await next();
  },
}));
vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('federationOrigin', 'peer.test');
    await next();
  },
  optionalFederationAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('federationOrigin', 'peer.test');
    await next();
  },
}));

import { joinFallbackServers } from '../src/api/rooms';

const ROOM = '!room:dead.example';

function makeDb(opts: {
  invite?: { sender: string } | null;
  members: Array<{ user_id: string }>;
} = { members: [] }) {
  return {
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (sql.includes('SELECT sender FROM events')) return (opts.invite ?? null) as T;
          return null as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes('SELECT DISTINCT user_id FROM room_memberships')) {
            return { results: opts.members as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      });
      return { ...stmt([]), bind: (...a: unknown[]) => stmt(a) };
    },
  } as unknown as D1Database;
}

describe('joinFallbackServers', () => {
  it('includes the inviter and joined remote members, excluding self and dupes', async () => {
    const db = makeDb({
      invite: { sender: '@stkw0:matrix.org' },
      members: [
        { user_id: '@bob:matrix.org' },
        { user_id: '@carol:other.org' },
        { user_id: '@alice:example.com' },
      ],
    });
    const servers = await joinFallbackServers(db, ROOM, 'example.com', '$invite:1');
    expect(servers).toEqual(['matrix.org', 'other.org']);
  });

  it('works without an invite event id (falls back to members only)', async () => {
    const db = makeDb({ members: [{ user_id: '@bob:alive.org' }] });
    const servers = await joinFallbackServers(db, ROOM, 'example.com');
    expect(servers).toEqual(['alive.org']);
  });

  it('survives a missing invite event row and an empty member list', async () => {
    const db = makeDb({ invite: null, members: [] });
    const servers = await joinFallbackServers(db, ROOM, 'example.com', '$gone:1');
    expect(servers).toEqual([]);
  });
});
