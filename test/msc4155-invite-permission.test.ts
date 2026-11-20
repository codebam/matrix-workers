/**
 * MSC4155 invite filtering — getInvitePermission evaluation order, glob
 * matching, m.ignored_user_list precedence and the unstable account-data
 * type, against a mock D1.
 */
import { describe, expect, it } from 'vitest';
import { getInvitePermission } from '../src/services/database';

const RECIPIENT = '@alice:example.com';
const INVITER = '@bob:spam.example.org';

function dbWith(rows: Array<{ event_type: string; content: unknown }>) {
  const byType = new Map(rows.map((r) => [r.event_type, JSON.stringify(r.content)]));
  return {
    prepare(sql: string) {
      expect(sql).toContain('FROM account_data');
      return {
        bind(...args: unknown[]) {
          expect(args[0]).toBe(RECIPIENT);
          return {
            async all<T>() {
              return {
                results: [...byType.entries()].map(([event_type, content]) => ({
                  event_type,
                  content,
                })) as T[],
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const config = (content: unknown) =>
  dbWith([{ event_type: 'm.invite_permission_config', content }]);

describe('MSC4155 getInvitePermission', () => {
  it('allows when the recipient has no config', async () => {
    expect(await getInvitePermission(dbWith([]), RECIPIENT, INVITER)).toBe('allow');
  });

  it('blocks an exact blocked_users match', async () => {
    expect(
      await getInvitePermission(config({ blocked_users: [INVITER] }), RECIPIENT, INVITER)
    ).toBe('block');
  });

  it('matches user globs', async () => {
    expect(
      await getInvitePermission(config({ blocked_users: ['@bob:*'] }), RECIPIENT, INVITER)
    ).toBe('block');
  });

  it('blocks by server glob and strips ports', async () => {
    expect(
      await getInvitePermission(config({ blocked_servers: ['*.example.org'] }), RECIPIENT, INVITER)
    ).toBe('block');
    expect(
      await getInvitePermission(
        config({ blocked_servers: ['spam.example.org'] }),
        RECIPIENT,
        '@bob:spam.example.org:8448'
      )
    ).toBe('block');
  });

  it('block-all servers with an allowed_users exception', async () => {
    const db = config({ allowed_users: [INVITER], blocked_servers: ['*'] });
    expect(await getInvitePermission(db, RECIPIENT, INVITER)).toBe('allow');
    expect(await getInvitePermission(db, RECIPIENT, '@eve:elsewhere.net')).toBe('block');
  });

  it('evalates allowed_servers before blocked_servers', async () => {
    const db = config({ allowed_servers: ['spam.example.org'], blocked_servers: ['*'] });
    expect(await getInvitePermission(db, RECIPIENT, INVITER)).toBe('allow');
  });

  it('ignored_users yields ignore, not block', async () => {
    expect(
      await getInvitePermission(config({ ignored_users: [INVITER] }), RECIPIENT, INVITER)
    ).toBe('ignore');
  });

  it('m.ignored_user_list (object map) takes precedence over the config', async () => {
    const db = dbWith([
      { event_type: 'm.ignored_user_list', content: { ignored_users: { [INVITER]: {} } } },
      { event_type: 'm.invite_permission_config', content: { allowed_users: [INVITER] } },
    ]);
    expect(await getInvitePermission(db, RECIPIENT, INVITER)).toBe('ignore');
  });

  it('enabled:false disables filtering without purging lists', async () => {
    expect(
      await getInvitePermission(
        config({ enabled: false, blocked_servers: ['*'] }),
        RECIPIENT,
        INVITER
      )
    ).toBe('allow');
  });

  it('honours the unstable account-data type', async () => {
    const db = dbWith([
      {
        event_type: 'org.matrix.msc4155.invite_permission_config',
        content: { blocked_users: [INVITER] },
      },
    ]);
    expect(await getInvitePermission(db, RECIPIENT, INVITER)).toBe('block');
  });

  it('treats non-array list values as empty (invalid event)', async () => {
    expect(
      await getInvitePermission(
        config({ blocked_users: 'not-an-array', blocked_servers: 42 }),
        RECIPIENT,
        INVITER
      )
    ).toBe('allow');
  });

  it('ignores malformed JSON content', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all<T>() {
                return {
                  results: [{ event_type: 'm.invite_permission_config', content: '{oops' }] as T[],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    expect(await getInvitePermission(db, RECIPIENT, INVITER)).toBe('allow');
  });
});