/**
 * Matrix spec v1.19: make_join and make_knock accept a repeated `ver` query
 * parameter listing the room versions the requester supports. If none matches
 * the room's version the server must answer 400 M_INCOMPATIBLE_ROOM_VERSION
 * and advertise its own supported room_versions. The invite path's error must
 * carry the same map.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const FED_ORIGIN = 'remote.example.com';

// The federation auth middleware normally verifies the X-Matrix signature and
// puts the authenticated origin on the context. Mock it the same way the other
// federation route tests do so app.request() exercises the handlers directly.
vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', FED_ORIGIN);
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', FED_ORIGIN);
      await next();
    };
  },
}));

// make_join reads the full room state for join-rule / ACL gating. An empty
// state keeps those gates inert and lets us test version negotiation alone.
const getRoomState = vi.fn(async () => [] as unknown[]);
vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getRoomState: (...args: unknown[]) => getRoomState(...args),
  };
});

import federation from '../src/api/federation';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const REMOTE_USER = '@bob:remote.example.com';

type DbOptions = {
  roomVersion?: string;
  /** Make make_knock pass its join-rule gate. */
  knockable?: boolean;
};

function makeDb(opts: DbOptions = {}) {
  const roomVersion = opts.roomVersion ?? '10';
  const knockRules = opts.knockable
    ? { content: JSON.stringify({ join_rule: 'knock' }) }
    : null;

  function statement(sql: string) {
    const firstWithArgs = async <T>(args: unknown[]): Promise<T | null> => {
      if (sql.includes('FROM rooms WHERE room_id')) {
        return (args[0] === ROOM ? { room_id: ROOM, room_version: roomVersion } : null) as T;
      }
      if (sql.includes('e.content') && sql.includes("'m.room.join_rules'")) {
        return knockRules as T | null;
      }
      // All other lookups (auth events, latest event, membership, wire
      // derivation) are absent in this minimal room.
      return null;
    };
    return {
      first: <T>() => firstWithArgs<T>([]),
      all: async <T>(): Promise<T[]> => [],
      run: async () => ({ success: true, meta: { changes: 0 } }),
      bind(...args: unknown[]) {
        return {
          first: <T>() => firstWithArgs<T>(args),
          all: async <T>(): Promise<T[]> => [],
          run: async () => ({ success: true }),
        };
      },
    };
  }

  return {
    prepare: (sql: string) => statement(sql),
  };
}

function makeEnv(opts: DbOptions = {}): Env {
  const kv = {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  };
  return {
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test-0.1.0',
    DB: makeDb(opts) as unknown as D1Database,
    SESSIONS: kv as unknown as KVNamespace,
    CACHE: kv as unknown as KVNamespace,
    ONE_TIME_KEYS: kv as unknown as KVNamespace,
  } as Env;
}

async function req(method: string, path: string, env: Env, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await federation.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function joinPath(query = '') {
  return `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}${query}`;
}

function knockPath(query = '') {
  return `/_matrix/federation/v1/make_knock/${encodeURIComponent(ROOM)}/${encodeURIComponent(REMOTE_USER)}${query}`;
}

const EXPECTED_VERSIONS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

function expectRoomVersions(body: { errcode?: string; room_versions?: Record<string, string> } | null) {
  expect(body.errcode).toBe('M_INCOMPATIBLE_ROOM_VERSION');
  expect(body.room_versions).toBeTypeOf('object');
  for (const version of EXPECTED_VERSIONS) {
    expect(body.room_versions[version]).toBe('stable');
  }
  expect(body.room_versions['10']).toBe('stable');
}

describe('make_join ver negotiation', () => {
  it('rejects a ver list that omits the room version, advertising room_versions', async () => {
    const res = await req('GET', joinPath('?ver=v9'), makeEnv());
    expect(res.status).toBe(400);
    expectRoomVersions(res.body);

    // Canonical (bare) room version IDs from our own outbound joiner.
    const canonical = await req('GET', joinPath('?ver=9'), makeEnv());
    expect(canonical.status).toBe(400);
    expectRoomVersions(canonical.body);
  });

  it('serves the template when ver matches the room version', async () => {
    const res = await req('GET', joinPath('?ver=v10'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.body.room_version).toBe('10');
    expect(res.body.event.content.membership).toBe('join');

    const canonical = await req('GET', joinPath('?ver=10'), makeEnv());
    expect(canonical.status).toBe(200);
    expect(canonical.body.room_version).toBe('10');
  });

  it('accepts repeated ver params when one matches', async () => {
    const res = await req('GET', joinPath('?ver=v9&ver=v10'), makeEnv());
    expect(res.status).toBe(200);
    expect(res.body.room_version).toBe('10');

    const canonical = await req('GET', joinPath('?ver=9&ver=10'), makeEnv());
    expect(canonical.status).toBe(200);
    expect(canonical.body.room_version).toBe('10');
  });

  it('preserves the unconditional template when ver is absent or empty', async () => {
    const noVer = await req('GET', joinPath(), makeEnv());
    expect(noVer.status).toBe(200);
    expect(noVer.body.room_version).toBe('10');

    const emptyVer = await req('GET', joinPath('?ver='), makeEnv());
    expect(emptyVer.status).toBe(200);
    expect(emptyVer.body.room_version).toBe('10');
  });
});

describe('make_knock ver negotiation', () => {
  it('rejects a ver list that omits the room version', async () => {
    const res = await req('GET', knockPath('?ver=v9'), makeEnv({ knockable: true }));
    expect(res.status).toBe(400);
    expectRoomVersions(res.body);

    const canonical = await req('GET', knockPath('?ver=9'), makeEnv({ knockable: true }));
    expect(canonical.status).toBe(400);
    expectRoomVersions(canonical.body);
  });

  it('serves the template when ver matches, including repeated params', async () => {
    const matching = await req('GET', knockPath('?ver=v10'), makeEnv({ knockable: true }));
    expect(matching.status).toBe(200);
    expect(matching.body.room_version).toBe('10');
    expect(matching.body.event.content.membership).toBe('knock');

    const canonical = await req('GET', knockPath('?ver=10'), makeEnv({ knockable: true }));
    expect(canonical.status).toBe(200);
    expect(canonical.body.room_version).toBe('10');

    const repeated = await req('GET', knockPath('?ver=v9&ver=v10'), makeEnv({ knockable: true }));
    expect(repeated.status).toBe(200);
    expect(repeated.body.room_version).toBe('10');
  });

  it('preserves the unconditional template when ver is absent', async () => {
    const res = await req('GET', knockPath(), makeEnv({ knockable: true }));
    expect(res.status).toBe(200);
    expect(res.body.room_version).toBe('10');
  });
});

describe('invite path incompatible room version error', () => {
  it('includes the supported room_versions map', async () => {
    const res = await req(
      'PUT',
      `/_matrix/federation/v2/invite/${encodeURIComponent(ROOM)}/%24invite`,
      makeEnv(),
      {
        room_version: '99',
        event: {
          event_id: '$invite',
          type: 'm.room.member',
          content: { membership: 'invite' },
          sender: REMOTE_USER,
          state_key: '@alice:example.com',
        },
      }
    );
    expect(res.status).toBe(400);
    expectRoomVersions(res.body);
  });
});
