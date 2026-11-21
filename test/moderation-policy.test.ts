/**
 * Moderation policy lists (spec module): rule parsing, glob matching,
 * the subscription→rules reader with KV caching, and the enforcement
 * gates — outbound invites to banned users/servers, joins to banned
 * rooms, and inbound federation invites from banned entities.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const BAD_USER = '@spam:evil.example.org';
const BAD_ROOM = '!banned:evil.example.org';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const POLICY_ROOM = '!policies:example.com';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'D');
      c.set('auth', { userId: USER, deviceId: 'D', accessToken: 't' });
      await next();
    };
  },
}));

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'evil.example.org');
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'evil.example.org');
      await next();
    };
  },
}));

const getMembership = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const getRoom = vi.fn();
const storeEvent = vi.fn();
const storeEventIdempotent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const getInvitePermission = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...args: unknown[]) => getMembership(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    getRoom: (...args: unknown[]) => getRoom(...args),
    storeEvent: (...args: unknown[]) => storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
    getInvitePermission: (...args: unknown[]) => getInvitePermission(...args),
  };
});

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return {
    ...actual,
    federationPost: vi.fn(),
    getServerSigningKey: vi.fn(async () => null),
  };
});

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
  invalidateRoomCache: vi.fn(async () => undefined),
}));

import {
  getActivePolicyRules,
  invalidatePolicyRulesCache,
  isRoomBannedByPolicy,
  isServerBannedByPolicy,
  isUserBannedByPolicy,
  parsePolicyRule,
  rulesFromState,
  type PolicyRules,
} from '../src/services/moderation-policy';
import roomsApp from '../src/api/rooms';
import federationApp from '../src/api/federation';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeKvCounter() {
  const data = new Map<string, string>();
  const counts = { gets: 0, puts: 0, deletes: 0 };
  return {
    counts,
    async get(key: string, type?: string) {
      counts.gets += 1;
      const raw = data.get(key);
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      counts.puts += 1;
      data.set(key, value);
    },
    async delete(key: string) {
      counts.deletes += 1;
      data.delete(key);
    },
  } as unknown as KVNamespace & { counts: { gets: number; puts: number; deletes: number } };
}

function policyDb(opts: { rules?: PDU[]; subscribed?: boolean } = {}) {
  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        return stmt(sql, bindArgs);
      },
      async first<T>() {
        return null as T;
      },
      async all<T>() {
        if (sql.includes('FROM policy_list_subscriptions')) {
          return {
            results: (opts.subscribed === false ? [] : [{ room_id: POLICY_ROOM }]) as T[],
          };
        }
        if (sql.includes('rs.event_type IN') && sql.includes('m.policy.rule')) {
          // Rule state rows for the subscribed policy room.
          const rules = opts.rules ?? [];
          const rows = rules
            .filter((r) => String(args[0]) === POLICY_ROOM)
            .map((r) => ({
              event_type: r.type,
              content: JSON.stringify(r.content),
            }));
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql: string) {
      return stmt(sql);
    },
  } as unknown as D1Database;
}

const RULE_STATE: PDU[] = [
  {
    type: 'm.policy.rule.user',
    state_key: 'rule:1',
    event_id: '$r1:example.com',
    content: { entity: '@spam:evil.example.org', reason: 'spam account', recommendation: 'm.ban' },
  },
  {
    type: 'm.policy.rule.user',
    state_key: 'rule:2',
    event_id: '$r2:example.com',
    content: { entity: '@bot*:evil.example.org', reason: 'bot farm', recommendation: 'm.ban' },
  },
  {
    type: 'm.policy.rule.room',
    state_key: 'rule:3',
    event_id: '$r3:example.com',
    content: { entity: '!banned:evil.example.org', reason: 'raid room', recommendation: 'm.ban' },
  },
  {
    type: 'm.policy.rule.server',
    state_key: 'rule:4',
    event_id: '$r4:example.com',
    content: { entity: '*.spamhouse.example.org', reason: 'spam host', recommendation: 'm.ban' },
  },
  {
    // Only m.ban is specified; other recommendations are ignored.
    type: 'm.policy.rule.user',
    state_key: 'rule:5',
    event_id: '$r5:example.com',
    content: { entity: '@fine:example.org', reason: 'opinion', recommendation: 'm.opinion' },
  },
  {
    // Malformed: no entity.
    type: 'm.policy.rule.server',
    state_key: 'rule:6',
    event_id: '$r6:example.com',
    content: { reason: 'broken', recommendation: 'm.ban' },
  },
] as unknown as PDU[];

// ---------------------------------------------------------------------------
// Unit: parsing + matching
// ---------------------------------------------------------------------------

describe('parsePolicyRule', () => {
  it('accepts m.ban rules and ignores everything else', () => {
    expect(parsePolicyRule('user', { entity: '@a:b', reason: 'r', recommendation: 'm.ban' })).toEqual({
      entity: '@a:b',
      reason: 'r',
      kind: 'user',
    });
    expect(parsePolicyRule('user', { entity: '@a:b', reason: 'r', recommendation: 'm.opinion' })).toBeNull();
    expect(parsePolicyRule('user', { reason: 'r', recommendation: 'm.ban' })).toBeNull();
    expect(parsePolicyRule('user', null)).toBeNull();
    // Missing reason stays valid (reason is only for humans).
    expect(parsePolicyRule('user', { entity: '@a:b', recommendation: 'm.ban' })).toEqual({
      entity: '@a:b',
      reason: '',
      kind: 'user',
    });
  });
});

describe('policy matching', () => {
  const rules = rulesFromState(RULE_STATE);

  it('collects only m.ban rules of each kind', () => {
    expect(rules.users).toHaveLength(2);
    expect(rules.rooms).toHaveLength(1);
    expect(rules.servers).toHaveLength(1); // malformed rule dropped
  });

  it('user rules match exactly and by glob', () => {
    expect(isUserBannedByPolicy(rules, BAD_USER)?.reason).toBe('spam account');
    expect(isUserBannedByPolicy(rules, '@bot7:evil.example.org')?.reason).toBe('bot farm');
    expect(isUserBannedByPolicy(rules, '@alice:example.com')).toBeNull();
  });

  it("room rules match room IDs (aliases are the caller's job)", () => {
    expect(isRoomBannedByPolicy(rules, BAD_ROOM)?.reason).toBe('raid room');
    expect(isRoomBannedByPolicy(rules, ROOM)).toBeNull();
  });

  it('server rules match case-insensitively with ports stripped', () => {
    expect(isServerBannedByPolicy(rules, 'sub.spamhouse.example.org')?.reason).toBe('spam host');
    expect(isServerBannedByPolicy(rules, 'SUB.SPAMHOUSE.EXAMPLE.ORG:8448')?.reason).toBe('spam host');
    expect(isServerBannedByPolicy(rules, 'spamhouse.example.org')).toBeNull(); // no subdomain match
    expect(isServerBannedByPolicy(rules, SERVER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reader + cache
// ---------------------------------------------------------------------------

describe('getActivePolicyRules', () => {
  it('returns empty rules without subscriptions or an unmigrated table', async () => {
    expect((await getActivePolicyRules(policyDb({ subscribed: false }))).subscriptions).toBe(0);
  });

  it('reads rules from subscribed rooms and caches them in KV', async () => {
    const db = policyDb({ rules: RULE_STATE });
    const kv = fakeKvCounter();

    const first = await getActivePolicyRules(db, kv);
    expect(first.subscriptions).toBe(1);
    expect(first.users).toHaveLength(2);
    expect(kv.counts.puts).toBe(1);

    const cached = await getActivePolicyRules(policyDb({ rules: [] }), kv);
    expect(cached.subscriptions).toBe(1); // served from cache, not the (empty) rules read
    expect(kv.counts.gets).toBe(2);

    await invalidatePolicyRulesCache(kv);
    expect(kv.counts.deletes).toBe(1);
    const fresh = await getActivePolicyRules(policyDb({ subscribed: false }), kv);
    expect(fresh.subscriptions).toBe(0); // cache cleared, fresh (empty) read
  });
});

// ---------------------------------------------------------------------------
// Enforcement gates
// ---------------------------------------------------------------------------

function envFor(db: D1Database): Env {
  return {
    DB: db,
    SERVER_NAME: SERVER,
    CACHE: {} as KVNamespace,
    PUSH_NOTIFICATION_WORKFLOW: { create: async () => ({ id: 'wf' }) },
  } as unknown as Env;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('moderation gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMembership.mockResolvedValue({ membership: 'join', eventId: '$m' });
    getStateEvent.mockResolvedValue(null);
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    getInvitePermission.mockResolvedValue('allow');
    storeEvent.mockResolvedValue(undefined);
    storeEventIdempotent.mockResolvedValue('$stored:example.com');
    notifyUsersOfEvent.mockResolvedValue(undefined);
  });

  it('joins to banned rooms are refused (room rule)', async () => {
    const env = envFor(policyDb({ rules: RULE_STATE }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${encodeURIComponent(BAD_ROOM)}/join`,
      jsonInit('POST', {}),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('raid room');
  });

  it('joins by alias check the alias form too', async () => {
    const env = envFor(policyDb({
      rules: [
        {
          type: 'm.policy.rule.room',
          state_key: 'r',
          event_id: '$r',
          content: { entity: '#spam:evil.example.org', reason: 'alias ban', recommendation: 'm.ban' },
        } as unknown as PDU,
      ],
    }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/join/${encodeURIComponent('#spam:evil.example.org')}`,
      jsonInit('POST', {}),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('alias ban');
  });

  it('invites of banned users are refused (user rule)', async () => {
    const env = envFor(policyDb({ rules: RULE_STATE }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/invite`,
      jsonInit('POST', { user_id: BAD_USER }),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('spam account');
  });

  it('createRoom invites of banned-server users are refused (server rule)', async () => {
    const env = envFor(policyDb({ rules: RULE_STATE }));
    const res = await roomsApp.request(
      'http://localhost/_matrix/client/v3/createRoom',
      jsonInit('POST', { invite: ['@someone:x.spamhouse.example.org'] }),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('spam host');
  });

  it('federation invites from banned users are refused', async () => {
    const env = envFor(policyDb({ rules: RULE_STATE }));
    const res = await federationApp.request(
      `http://localhost/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24inv`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_version: '10',
          event: {
            type: 'm.room.member',
            state_key: USER,
            sender: BAD_USER,
            event_id: '$inv',
            room_id: ROOM,
            content: { membership: 'invite' },
          },
          invite_room_state: [],
        }),
      },
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('moderation policy list');
    expect(body.error).toContain('spam account');
  });

  it('the state-endpoint invite path also refuses banned invitees', async () => {
    const env = envFor(policyDb({ rules: RULE_STATE }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(BAD_USER)}`,
      jsonInit('PUT', { membership: 'invite' }),
      env
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('spam account');
  });
});
