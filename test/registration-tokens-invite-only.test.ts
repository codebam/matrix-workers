/**
 * Invite-only registration (registration tokens) + dummy-login removal.
 *
 * Covers the REGISTRATION_REQUIRE_TOKEN gate on POST /register (user and
 * guest), token consumption semantics (single/multi-use, expiry, revocation,
 * no burn on failed registration), the admin token-management API, and the
 * rejection of m.login.dummy as a login type (it is only a UIA stage).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import type { Env, AppEnv } from '../src/types';
import { hashToken } from '../src/utils/crypto';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', '@alice:example.com');
        c.set('deviceId', 'DEVICE');
        await next();
      };
    },
  };
});

vi.mock('../src/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/crypto')>();
  return {
    ...actual,
    // Avoid 100k-iter PBKDF2 in register loops; hashToken stays real.
    verifyPassword: vi.fn(async (password: string, storedHash: string) => {
      return storedHash === `mockok:${password}`;
    }),
    hashPassword: vi.fn(async (password: string) => `mockok:${password}`),
  };
});

import login from '../src/api/login';
import admin from '../src/api/admin';

const SERVER = 'example.com';
const ALICE = `@alice:${SERVER}`;
const ADMIN = '@admin:example.com';
const STRONG_PW = 'Password1';

type UserRow = {
  user_id: string;
  localpart: string;
  display_name: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  is_guest: number;
  is_deactivated: number;
  admin: number;
  created_at: number;
};

type Tok = {
  id: string;
  token_hash: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  uses_remaining: number;
  revoked: number;
};

function userRow(partial: Partial<UserRow> & Pick<UserRow, 'user_id' | 'localpart'>): UserRow {
  return {
    display_name: partial.display_name ?? partial.localpart,
    avatar_url: partial.avatar_url ?? null,
    password_hash: partial.password_hash ?? 'mockok:Password1',
    is_guest: partial.is_guest ?? 0,
    is_deactivated: partial.is_deactivated ?? 0,
    admin: partial.admin ?? 0,
    created_at: partial.created_at ?? 1_700_000_000_000,
    user_id: partial.user_id,
    localpart: partial.localpart,
  };
}

type SqlCall = { sql: string; args: unknown[] };

function mockKv(data: Record<string, string> = {}) {
  const puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }> = [];
  const kv = {
    data,
    puts,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      if (type === 'json') return JSON.parse(raw);
      return raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      data[key] = value;
      puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
  return kv as unknown as KVNamespace & { puts: typeof puts };
}

function mockDb(seed: { users?: UserRow[]; tokens?: Tok[] } = {}) {
  const users = new Map<string, UserRow>((seed.users ?? []).map((u) => [u.user_id, u]));
  const tokens: Tok[] = seed.tokens ?? [];
  const audit: SqlCall[] = [];
  const inserts: SqlCall[] = [];
  const updates: SqlCall[] = [];

  function exec(sql: string, args: unknown[]): { rows: unknown[]; changes: number } {
    if (sql.includes('FROM users WHERE user_id')) {
      const user = users.get(args[0] as string);
      return { rows: user ? [user] : [], changes: 0 };
    }
    if (sql.includes('password_hash FROM users WHERE user_id')) {
      const user = users.get(args[0] as string);
      return { rows: user ? [user] : [], changes: 0 };
    }
    if (sql.includes('INSERT INTO users')) {
      const [user_id, localpart, password_hash, is_guest] = args as [
        string,
        string,
        string | null,
        number,
      ];
      users.set(user_id, userRow({ user_id, localpart, password_hash, is_guest }));
      inserts.push({ sql, args });
      return { rows: [], changes: 1 };
    }
    if (sql.includes('INSERT INTO devices') || sql.includes('INSERT INTO access_tokens')) {
      inserts.push({ sql, args });
      return { rows: [], changes: 1 };
    }
    if (sql.includes('FROM registration_tokens') && sql.includes('ORDER BY')) {
      // listRegistrationTokens selects every column except the hash.
      return {
        rows: tokens.map(({ token_hash: _omit, ...rest }) => rest),
        changes: 0,
      };
    }
    if (sql.includes('INSERT INTO registration_tokens')) {
      const [id, token_hash, note, created_by, created_at, expires_at, uses_remaining] = args as [
        string,
        string,
        string | null,
        string | null,
        number,
        number | null,
        number,
      ];
      tokens.push({
        id,
        token_hash,
        note,
        created_by,
        created_at,
        expires_at,
        uses_remaining,
        revoked: 0,
      });
      inserts.push({ sql, args });
      return { rows: [], changes: 1 };
    }
    if (sql.includes('UPDATE registration_tokens SET revoked = 1')) {
      const tok = tokens.find((t) => t.id === args[0]);
      updates.push({ sql, args });
      if (!tok) return { rows: [], changes: 0 };
      tok.revoked = 1;
      return { rows: [], changes: 1 };
    }
    if (sql.includes('SET uses_remaining = uses_remaining - 1')) {
      const [hash, now] = args as [string, number];
      updates.push({ sql, args });
      const tok = tokens.find((t) => t.token_hash === hash);
      if (!tok || tok.revoked !== 0 || tok.uses_remaining <= 0) {
        return { rows: [], changes: 0 };
      }
      if (tok.expires_at !== null && tok.expires_at <= now) {
        return { rows: [], changes: 0 };
      }
      tok.uses_remaining -= 1;
      return { rows: [], changes: 1 };
    }
    if (sql.includes('INSERT INTO admin_audit_log')) {
      audit.push({ sql, args });
      return { rows: [], changes: 1 };
    }
    return { rows: [], changes: 0 };
  }

  const db = {
    users,
    tokens,
    audit,
    inserts,
    updates,
    prepare(sql: string) {
      const terminal = (args: unknown[]) => {
        const result = exec(sql, args);
        return {
          first: async () => result.rows[0] ?? null,
          all: async () => ({ results: result.rows }),
          run: async () => ({ meta: { changes: result.changes } }),
        };
      };
      return {
        bind: (...args: unknown[]) => terminal(args),
        first: async () => {
          const result = exec(sql, []);
          return result.rows[0] ?? null;
        },
        all: async () => ({ results: exec(sql, []).rows }),
        run: async () => ({ meta: { changes: exec(sql, []).changes } }),
      };
    },
  };
  return db;
}

function baseEnv(db: ReturnType<typeof mockDb>, extra: Record<string, unknown> = {}) {
  return {
    DB: db,
    SESSIONS: mockKv(),
    SERVER_NAME: SERVER,
    ...extra,
  } as unknown as Env;
}

const inviteEnv = (db: ReturnType<typeof mockDb>) =>
  baseEnv(db, { REGISTRATION_REQUIRE_TOKEN: 'true' });

async function post(app: Hono<AppEnv>, env: Env, path: string, body: unknown) {
  const res = await app.request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

function seedToken(hash: string, partial: Partial<Tok> = {}): Tok {
  return {
    id: partial.id ?? 'tok-1',
    token_hash: hash,
    note: partial.note ?? null,
    created_by: partial.created_by ?? ADMIN,
    created_at: partial.created_at ?? 1_700_000_000_000,
    expires_at: partial.expires_at ?? null,
    uses_remaining: partial.uses_remaining ?? 1,
    revoked: partial.revoked ?? 0,
  };
}

let rawToken: string;
let tokenHash: string;

beforeEach(async () => {
  rawToken = 'mrt_testtoken0001';
  tokenHash = await hashToken(rawToken);
});

// ---------------------------------------------------------------------------
// Register gate
// ---------------------------------------------------------------------------

describe('invite-only registration gate (REGISTRATION_REQUIRE_TOKEN=true)', () => {
  it('advertises the registration_token UIA stage', async () => {
    const res = await post(login, inviteEnv(mockDb()), '/_matrix/client/v3/register', {});
    expect(res.status).toBe(401);
    expect(res.body.flows).toEqual([{ stages: ['m.login.registration_token'] }]);
  });

  it('rejects a registration without any token', async () => {
    const db = mockDb();
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.dummy' },
    });
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
    expect(res.body.error).toBe('Registration token required');
    expect(db.users.size).toBe(0);
  });

  it('rejects an unknown token', async () => {
    const db = mockDb();
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: 'mrt_bogus' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Invalid or expired registration token');
    expect(db.users.size).toBe(0);
  });

  it('rejects an expired token', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash, { expires_at: Date.now() - 1000 })] });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(res.status).toBe(403);
    expect(db.users.size).toBe(0);
    expect(db.tokens[0].uses_remaining).toBe(1);
  });

  it('rejects a revoked token', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash, { revoked: 1 })] });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(res.status).toBe(403);
    expect(db.users.size).toBe(0);
  });

  it('rejects an exhausted token', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash, { uses_remaining: 0 })] });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(res.status).toBe(403);
    expect(db.users.size).toBe(0);
  });

  it('registers with a valid token supplied via the registration_token stage', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash)] });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(`@codebam:${SERVER}`);
    expect(String(res.body.access_token)).toMatch(/^syt_/);
    expect(db.users.has(`@codebam:${SERVER}`)).toBe(true);
    expect(db.tokens[0].uses_remaining).toBe(0);
  });

  it('consumes single-use tokens: the second registration fails', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash)] });
    const body = {
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    };
    const first = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      ...body,
      username: 'first',
    });
    expect(first.status).toBe(200);

    const second = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      ...body,
      username: 'second',
    });
    expect(second.status).toBe(403);
    expect(db.users.has(`@second:${SERVER}`)).toBe(false);
  });

  it('accepts the token via the body with dummy auth (script-friendly)', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash)] });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      token: rawToken,
      auth: { type: 'm.login.dummy' },
    });
    expect(res.status).toBe(200);
    expect(db.users.has(`@codebam:${SERVER}`)).toBe(true);
  });

  it('accepts the token via the query string', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash)] });
    const res = await post(
      login,
      inviteEnv(db),
      `/_matrix/client/v3/register?token=${rawToken}`,
      {
        username: 'codebam',
        password: STRONG_PW,
        auth: { type: 'm.login.dummy' },
      }
    );
    expect(res.status).toBe(200);
  });

  it('does not burn the token when the username is already taken', async () => {
    const db = mockDb({
      users: [userRow({ user_id: ALICE, localpart: 'alice' })],
      tokens: [seedToken(tokenHash)],
    });
    const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'alice',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_USER_IN_USE');
    expect(db.tokens[0].uses_remaining).toBe(1);
  });

  it('allows a multi-use token to fund several registrations', async () => {
    const db = mockDb({ tokens: [seedToken(tokenHash, { uses_remaining: 2 })] });
    for (const username of ['one', 'two']) {
      const res = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
        username,
        password: STRONG_PW,
        auth: { type: 'm.login.registration_token', token: rawToken },
      });
      expect(res.status).toBe(200);
    }
    const third = await post(login, inviteEnv(db), '/_matrix/client/v3/register', {
      username: 'three',
      password: STRONG_PW,
      auth: { type: 'm.login.registration_token', token: rawToken },
    });
    expect(third.status).toBe(403);
  });

  it('gates guest registration too', async () => {
    const db = mockDb();
    const denied = await post(login, inviteEnv(db), '/_matrix/client/v3/register?kind=guest', {});
    expect(denied.status).toBe(403);
    expect(db.users.size).toBe(0);

    const db2 = mockDb({ tokens: [seedToken(tokenHash)] });
    const allowed = await post(
      login,
      inviteEnv(db2),
      `/_matrix/client/v3/register?kind=guest&token=${rawToken}`,
      {}
    );
    expect(allowed.status).toBe(200);
    const created = [...db2.users.values()][0];
    expect(created.is_guest).toBe(1);
  });
});

describe('registration without the invite-only var is unchanged', () => {
  it('keeps the dummy UIA stage and accepts tokenless registrations', async () => {
    const db = mockDb();
    const challenge = await post(login, baseEnv(db), '/_matrix/client/v3/register', {});
    expect(challenge.status).toBe(401);
    expect(challenge.body.flows).toEqual([{ stages: ['m.login.dummy'] }]);

    const res = await post(login, baseEnv(db), '/_matrix/client/v3/register', {
      username: 'codebam',
      password: STRONG_PW,
      auth: { type: 'm.login.dummy' },
    });
    expect(res.status).toBe(200);
    expect(db.users.has(`@codebam:${SERVER}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dummy login removal
// ---------------------------------------------------------------------------

describe('m.login.dummy is not a login type', () => {
  it('rejects a dummy login attempt as unknown', async () => {
    const db = mockDb({ users: [userRow({ user_id: ALICE, localpart: 'alice' })] });
    const res = await post(login, baseEnv(db), '/_matrix/client/v3/login', {
      type: 'm.login.dummy',
      identifier: { type: 'm.id.user', user: 'alice' },
    });
    expect(res.status).toBe(400);
    expect(res.body.errcode).toBe('M_UNRECOGNIZED');
  });

  it('lists only password and token login flows', async () => {
    const res = await login.request('/_matrix/client/v3/login', { method: 'GET' }, baseEnv(mockDb()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flows: Array<{ type: string }> };
    expect(body.flows.map((f) => f.type)).toEqual(['m.login.password', 'm.login.token']);
  });
});

// ---------------------------------------------------------------------------
// Admin token management
// ---------------------------------------------------------------------------

describe('admin registration token endpoints', () => {
  const adminDb = () =>
    mockDb({ users: [userRow({ user_id: ALICE, localpart: 'alice', admin: 1 })] });

  it('mints a token: raw shown once, hash stored, audited, no-store', async () => {
    const db = adminDb();
    const res = await post(admin, baseEnv(db), '/admin/api/registration-tokens', {
      note: 'for sean',
      uses: 2,
      expires_in_hours: 48,
    });
    expect(res.status).toBe(200);
    const token = res.body.token as string;
    expect(token).toMatch(/^mrt_/);
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(db.tokens).toHaveLength(1);
    expect(db.tokens[0].token_hash).toBe(await hashToken(token));
    expect(db.tokens[0].token_hash).not.toBe(token);
    expect(db.tokens[0].uses_remaining).toBe(2);
    expect(db.tokens[0].note).toBe('for sean');
    expect(db.tokens[0].created_by).toBe(ALICE);
    expect(db.tokens[0].expires_at).toBeGreaterThan(Date.now());

    expect(db.audit.some((a) => a.args.includes('registration_token.create'))).toBe(true);
  });

  it('applies sane defaults (1 use, 7 day expiry)', async () => {
    const db = adminDb();
    const res = await post(admin, baseEnv(db), '/admin/api/registration-tokens', {});
    expect(res.status).toBe(200);
    expect(db.tokens[0].uses_remaining).toBe(1);
    const sevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs((db.tokens[0].expires_at ?? 0) - sevenDays)).toBeLessThan(60_000);
  });

  it('lists tokens without the hash', async () => {
    const db = adminDb();
    db.tokens.push(seedToken(tokenHash, { id: 'tok-1' }), seedToken('otherhash', { id: 'tok-2' }));
    const res = await admin.request('/admin/api/registration-tokens', { method: 'GET' }, baseEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Array<Record<string, unknown>> };
    expect(body.tokens).toHaveLength(2);
    for (const t of body.tokens) {
      expect(t.token_hash).toBeUndefined();
    }
  });

  it('revokes a token and 404s for unknown ids', async () => {
    const db = adminDb();
    db.tokens.push(seedToken(tokenHash, { id: 'tok-1' }));
    const res = await admin.request(
      '/admin/api/registration-tokens/tok-1',
      { method: 'DELETE' },
      baseEnv(db)
    );
    expect(res.status).toBe(200);
    expect(db.tokens[0].revoked).toBe(1);
    expect(db.audit.some((a) => a.args.includes('registration_token.revoke'))).toBe(true);

    const missing = await admin.request(
      '/admin/api/registration-tokens/nope',
      { method: 'DELETE' },
      baseEnv(db)
    );
    expect(missing.status).toBe(404);
  });

  it('rejects non-admin callers', async () => {
    const db = mockDb({ users: [userRow({ user_id: ALICE, localpart: 'alice', admin: 0 })] });
    const res = await admin.request('/admin/api/registration-tokens', { method: 'GET' }, baseEnv(db));
    expect(res.status).toBe(403);
  });
});
