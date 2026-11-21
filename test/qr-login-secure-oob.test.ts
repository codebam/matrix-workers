/**
 * MSC4108 landing routes + MSC4388 secure out-of-band QR verification.
 * Exercises the exported qr-login Hono app (no src/index.ts registration needed)
 * and the login-token binding added to src/api/login.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set('userId', '@alice:example.com');
        c.set('deviceId', 'EXISTING');
        await next();
      };
    },
  };
});

import login from '../src/api/login';
import qrLogin from '../src/api/qr-login';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const NOW = 1_730_000_000_000;
const CANONICAL = '/_matrix/client/v1/login/qr';
const UNSTABLE = '/_matrix/client/unstable/org.matrix.msc4108/login/qr';
const VERIFIER = 'secure-oob-verifier-0123456789-abcdef';

function mockKv(data: Record<string, string> = {}) {
  const deletes: string[] = [];
  return {
    data,
    deletes,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string, _options?: { expirationTtl?: number }) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      deletes.push(key);
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace & {
    data: Record<string, string>;
    deletes: string[];
  };
}

function mockDb() {
  const user = {
    user_id: USER,
    localpart: 'alice',
    display_name: 'Alice',
    avatar_url: null,
    is_guest: 0,
    is_deactivated: 0,
    admin: 0,
    created_at: NOW,
  };
  const devices: unknown[] = [];
  const tokens: unknown[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM users WHERE user_id = ?')) return user as T;
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO devices')) {
                devices.push(args);
                return { success: true };
              }
              if (sql.includes('INSERT INTO access_tokens')) {
                tokens.push(args);
                return { success: true };
              }
              throw new Error(`Unhandled SQL in QR test stub: ${sql.slice(0, 100)}`);
            },
          };
        },
      };
    },
  };
  return { db, devices, tokens };
}

function envFor(sessions: ReturnType<typeof mockKv>, db = mockDb().db): Env {
  return { SESSIONS: sessions, DB: db, SERVER_NAME: SERVER } as unknown as Env;
}

async function seedToken(
  sessions: ReturnType<typeof mockKv>,
  token: string,
  extra: Record<string, unknown> = {},
  expiresAt = NOW + 120_000
): Promise<string> {
  const key = `login_token:${await hashToken(token)}`;
  sessions.data[key] = JSON.stringify({ user_id: USER, expires_at: expiresAt, ...extra });
  return key;
}

async function qrRequest(path: string, init: RequestInit = {}, env = envFor(mockKv())) {
  const res = await qrLogin.request(`https://${SERVER}${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, text, headers: res.headers };
}

async function loginRequest(path: string, body: unknown, env: Env) {
  const res = await login.request(
    `https://${SERVER}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer existing' },
      body: JSON.stringify(body),
    },
    env
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MSC4108 canonical landing routes', () => {
  for (const prefix of [CANONICAL, UNSTABLE]) {
    it(`${prefix}/:token serves the landing HTML with no-store`, async () => {
      const sessions = mockKv();
      const token = 'mlt_landing_ok';
      await seedToken(sessions, token);
      const res = await qrRequest(`${prefix}/${token}`, {}, envFor(sessions));
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.text).toContain('Welcome!');
      expect(res.text).toContain(USER);
    });

    it(`${prefix}/:token/check reports a valid plain token`, async () => {
      const sessions = mockKv();
      const token = 'mlt_check_ok';
      await seedToken(sessions, token, {}, NOW + 90_000);
      const res = await qrRequest(`${prefix}/${token}/check`, {}, envFor(sessions));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        valid: true,
        user_id: USER,
        homeserver: SERVER,
        expires_at: NOW + 90_000,
        expires_in_ms: 90_000,
        secure_oob: false,
      });
      // Non-consuming by design.
      expect(sessions.data[`login_token:${await hashToken(token)}`]).toBeDefined();
    });

    it(`${prefix}/:token/check rejects an invalid/expired token`, async () => {
      const bad = await qrRequest(`${prefix}/not-mlt/check`);
      expect(bad.status).toBe(400);
      expect(bad.body.errcode).toBe('M_INVALID_PARAM');

      const sessions = mockKv();
      const missing = await qrRequest(`${prefix}/mlt_missing/check`, {}, envFor(sessions));
      expect(missing.status).toBe(404);
      expect(missing.body.errcode).toBe('M_NOT_FOUND');

      const token = 'mlt_expired';
      await seedToken(sessions, token, {}, NOW - 1);
      const expired = await qrRequest(`${prefix}/${token}/check`, {}, envFor(sessions));
      expect(expired.status).toBe(403);
      expect(expired.body.errcode).toBe('M_FORBIDDEN');
    });

    it(`${prefix}/:token/check accepts POST with a body`, async () => {
      const sessions = mockKv();
      const token = 'mlt_post_check';
      await seedToken(sessions, token);
      const res = await qrRequest(`${prefix}/${token}/check`, jsonInit({}), envFor(sessions));
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });
  }

  it('legacy /login/qr/:token/check stays GET-only', async () => {
    const res = await qrRequest('/login/qr/mlt_legacy/check', jsonInit({}));
    expect(res.status).toBe(404);
  });
});

describe('MSC4388 secure out-of-band verifier binding', () => {
  async function issueBoundToken(sessions: ReturnType<typeof mockKv>) {
    const res = await loginRequest(
      '/_matrix/client/v1/login/get_token',
      { rendezvous_id: 'rendezvous-abc', verifier: VERIFIER },
      envFor(sessions)
    );
    expect(res.status).toBe(200);
    expect(res.body.secure_oob).toBe(true);
    const token = res.body.login_token as string;
    const record = JSON.parse(sessions.data[`login_token:${await hashToken(token)}`]);
    expect(record.secure_oob.rendezvous_id).toBe('rendezvous-abc');
    expect(record.secure_oob.verifier_hash).toBe(await hashToken(VERIFIER));
    expect(JSON.stringify(record)).not.toContain(VERIFIER);
    return token;
  }

  it('token issuance without binding keeps the original response/KV shape', async () => {
    const sessions = mockKv();
    const res = await loginRequest('/_matrix/client/v1/login/get_token', {}, envFor(sessions));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      login_token: expect.any(String),
      expires_in_ms: 120_000,
    });
    const record = JSON.parse(sessions.data[`login_token:${await hashToken(res.body.login_token)}`]);
    expect(record).toEqual({ user_id: USER, expires_at: NOW + 120_000 });
  });

  it('partial binding input is rejected', async () => {
    const sessions = mockKv();
    const onlyRendezvous = await loginRequest(
      '/_matrix/client/v1/login/get_token',
      { rendezvous_id: 'rendezvous-abc' },
      envFor(sessions)
    );
    expect(onlyRendezvous.status).toBe(400);
    expect(onlyRendezvous.body.errcode).toBe('M_MISSING_PARAM');
    const shortVerifier = await loginRequest(
      '/_matrix/client/v1/login/get_token',
      { rendezvous_id: 'rendezvous-abc', verifier: 'short' },
      envFor(sessions)
    );
    expect(shortVerifier.status).toBe(400);
    expect(shortVerifier.body.errcode).toBe('M_INVALID_PARAM');
  });

  it('bound token: correct verifier passes POST check, wrong/missing verifier does not', async () => {
    const sessions = mockKv();
    const token = await issueBoundToken(sessions);

    const wrong = await qrRequest(
      `${CANONICAL}/${token}/check`,
      jsonInit({ verifier: 'not-the-verifier' }),
      envFor(sessions)
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body.errcode).toBe('M_FORBIDDEN');
    expect(wrong.body.error).toBe('Invalid QR verifier');

    const missing = await qrRequest(`${CANONICAL}/${token}/check`, {}, envFor(sessions));
    expect(missing.status).toBe(403);

    const getMissing = await qrRequest(`${CANONICAL}/${token}/check`, {}, envFor(sessions));
    expect(getMissing.status).toBe(403);

    const good = await qrRequest(
      `${CANONICAL}/${token}/check`,
      jsonInit({ verifier: VERIFIER }),
      envFor(sessions)
    );
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ valid: true, secure_oob: true, user_id: USER });
    // Check remains non-consuming.
    expect(sessions.data[`login_token:${await hashToken(token)}`]).toBeDefined();
  });

  it('m.login.token rejects a wrong verifier without burning the token', async () => {
    const sessions = mockKv();
    const token = await issueBoundToken(sessions);
    const key = `login_token:${await hashToken(token)}`;

    const wrong = await loginRequest(
      '/_matrix/client/v3/login',
      { type: 'm.login.token', token, verifier: 'wrong', device_id: 'NEW' },
      envFor(sessions)
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('Invalid QR verifier');
    expect(sessions.data[key]).toBeDefined();

    const good = await loginRequest(
      '/_matrix/client/v3/login',
      { type: 'm.login.token', token, verifier: VERIFIER, device_id: 'NEW' },
      envFor(sessions)
    );
    expect(good.status).toBe(200);
    expect(good.body.user_id).toBe(USER);
    expect(sessions.data[key]).toBeUndefined();
  });

  it('POST /-/login is single-use and enforces the verifier', async () => {
    const sessions = mockKv();
    const token = await issueBoundToken(sessions);
    const key = `login_token:${await hashToken(token)}`;
    const path = `${CANONICAL}/${token}/-/login`;

    const wrong = await qrRequest(path, jsonInit({ verifier: 'wrong' }), envFor(sessions));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('Invalid QR verifier');
    expect(sessions.data[key]).toBeDefined();

    const good = await qrRequest(
      path,
      jsonInit({ verifier: VERIFIER, device_id: 'SCANNED' }),
      envFor(sessions)
    );
    expect(good.status).toBe(200);
    expect(good.body.user_id).toBe(USER);
    expect(good.body.device_id).toBe('SCANNED');
    expect(typeof good.body.access_token).toBe('string');
    expect(sessions.data[key]).toBeUndefined();

    const replay = await qrRequest(path, jsonInit({ verifier: VERIFIER }), envFor(sessions));
    expect(replay.status).toBe(403);
    expect(replay.body.error).toBe('Invalid or expired login token');
  });

  it('POST /-/login mints a session for a plain (unbound) token too', async () => {
    const sessions = mockKv();
    const token = 'mlt_plain_final';
    await seedToken(sessions, token);
    const res = await qrRequest(`${CANONICAL}/${token}/-/login`, jsonInit({}), envFor(sessions));
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(USER);
    expect(sessions.deletes).toContain(`login_token:${await hashToken(token)}`);
  });

  it('expired tokens are rejected by check and by /-/login', async () => {
    const sessions = mockKv();
    const token = 'mlt_expired_final';
    await seedToken(sessions, token, {}, NOW - 1);
    expect((await qrRequest(`${CANONICAL}/${token}/check`, {}, envFor(sessions))).status).toBe(403);
    expect((await qrRequest(`${CANONICAL}/${token}/-/login`, jsonInit({}), envFor(sessions))).status).toBe(403);
  });

  it('bad JSON on the new POST routes is M_BAD_JSON', async () => {
    const sessions = mockKv();
    const token = 'mlt_bad_json';
    await seedToken(sessions, token);
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    };
    const check = await qrRequest(`${CANONICAL}/${token}/check`, init, envFor(sessions));
    expect(check.status).toBe(400);
    expect(check.body.errcode).toBe('M_BAD_JSON');
    const final = await qrRequest(`${CANONICAL}/${token}/-/login`, init, envFor(sessions));
    expect(final.status).toBe(400);
    expect(final.body.errcode).toBe('M_BAD_JSON');
  });
});
