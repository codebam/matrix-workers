// Pins the stub-D1-backed source behaviour of getFederationDestinationsForRoom:
// which joined members become federation EDU destinations, and how the room's
// m.room.server_acl event narrows (or fails to narrow) that set.
import { describe, it, expect, vi } from 'vitest';
import { getFederationDestinationsForRoom } from '../src/services/federation-edus';

interface AclContent {
  allow?: unknown;
  deny?: unknown;
  allow_ip_literals?: unknown;
}

function makeDb(options: {
  users: Array<string | undefined>;
  acl?: AclContent | null;
  aclError?: Error;
}): { db: D1Database; prepareCalls: string[] } {
  const { users, acl = null, aclError } = options;
  const prepareCalls: string[] = [];

  // Minimal D1 stub: the membership query resolves via all(), the ACL state
  // lookup performed by getStateEvent resolves via first().
  const db = {
    prepare(sql: string) {
      prepareCalls.push(sql);
      return {
        bind(..._binds: unknown[]) {
          return {
            async all() {
              return { results: users.map((user_id) => ({ user_id })) };
            },
            async first() {
              if (aclError) throw aclError;
              if (acl == null) return null;
              return {
                event_id: '$acl',
                room_id: '!room:local.test',
                sender: '@mod:local.test',
                event_type: 'm.room.server_acl',
                state_key: '',
                content: JSON.stringify(acl),
                origin_server_ts: 0,
                unsigned: null,
                depth: 0,
                auth_events: '[]',
                prev_events: '[]',
              };
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, prepareCalls };
}

const LOCAL = 'local.test';
const ROOM = '!room:local.test';

describe('getFederationDestinationsForRoom', () => {
  it('returns no destinations for an empty membership list', async () => {
    const { db } = makeDb({ users: [] });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([]);
  });

  it('returns no destinations when every joined member is local', async () => {
    const { db, prepareCalls } = makeDb({
      users: ['@a:local.test', '@b:local.test:8448'],
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([]);
    // No remote servers means no ACL lookup is needed at all.
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toContain("membership = 'join'");
  });

  it('takes the segment after the first colon, excludes ours and deduplicates', async () => {
    const { db } = makeDb({
      users: [
        '@a:local.test',
        '@b:remote.one',
        '@c:remote.two',
        '@d:remote.one',
        '@e:remote.one:8448',
      ],
    });
    // The server is split(':')[1], so an explicit port is dropped and folds
    // into the bare-host destination collected from earlier rows.
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
      'remote.one',
      'remote.two',
    ]);
  });

  it('ignores rows with no parseable server half', async () => {
    const { db } = makeDb({
      users: [undefined, '@localonly', '@ok:remote.one'],
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
      'remote.one',
    ]);
  });

  it('filters destinations through the room server ACL allow list', async () => {
    const { db } = makeDb({
      users: ['@a:allowed.test', '@b:blocked.test', '@c:local.test'],
      acl: { allow: ['allowed.test'], deny: [] },
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
      'allowed.test',
    ]);
  });

  it('applies ACL deny rules before allow rules', async () => {
    const { db } = makeDb({
      users: ['@a:good.test', '@b:evil.test'],
      acl: { allow: ['*.test'], deny: ['evil.test'] },
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
      'good.test',
    ]);
  });

  it('treats an empty ACL allow list as denying every remote server', async () => {
    const { db } = makeDb({
      users: ['@a:remote.one'],
      acl: { allow: [] },
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([]);
  });

  it('sends to all joined servers when there is no ACL state event', async () => {
    const { db } = makeDb({
      users: ['@a:remote.one', '@b:remote.two'],
      acl: null,
    });
    await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
      'remote.one',
      'remote.two',
    ]);
  });

  it('fails open to all joined servers when the ACL lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { db } = makeDb({
        users: ['@a:remote.one', '@b:remote.two'],
        aclError: new Error('ACL table unavailable'),
      });
      await expect(getFederationDestinationsForRoom(db, ROOM, LOCAL)).resolves.toEqual([
        'remote.one',
        'remote.two',
      ]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
