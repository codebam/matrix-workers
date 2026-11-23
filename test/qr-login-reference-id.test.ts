/**
 * 010.6 — admin QR login uses a short-lived reference ID instead of returning
 * the raw login token. Tests cover issuance, reference/legacy redemption,
 * single-use semantics, verifier preservation and the QR landing/check routes.
 *
 * Based on docs/10-6-qr-login-token-reference-id.md and the audit 010.6
 * mitigations recorded in docs/issues/README.md.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@admin:example.com');
      c.set('deviceId', 'ADMIN');
      await next();
    },
  };
});

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getUserById: vi.fn(async (_db: unknown, userId: string) => ({
      user_id: userId,
      localpart: userId.slice(1).split(':')[0],
      is_deactivated: 0,
      admin: 1,
    })),
    createDevice: vi.fn(async () => {}),
    createAccessToken: vi.fn(async () => {}),
  };
});

import admin from '../src/api/admin';
import login from '../src/api/login';
import qrLogin from '../src/api/qr-login';

const USER = '@alice:example.com';
const REFERENCE = `qr_ref_${'a'.repeat(32)}`;

type KvMock = {
  data: Record<string, string>;
  puts: Array<{ key: string; value: string; options?: { expirationTtl?: number } }>;
  deletes: string[];
};

function makeEnv(): { env: Env; kv: KvMock; audit: unknown[][] } {
  const kv: KvMock = { data: {}, puts: [], deletes: [] };
  const audit: unknown[][] = [];
  const SESSIONS = {
    get: async (key: string, type?: string) => {
      const raw = kv.data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      kv.data[key] = value;
      kv.puts.push({ key, value, options });
    },
    delete: async (key: string) => {
      kv.deletes.push(key);
      delete kv.data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;

  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        if (sql.includes('admin_audit_log')) audit.push(args);
        return {
          run: async () => ({ success: true, meta: { changes: 1 } }),
          first: async () => null,
          all: async () => ({ results: [] }),
        };
      },
    }),
  } as unknown as D1Database;

  return {
    env: { DB, SESSIONS, SERVER_NAME: 'example.com' } as unknown as Env,
    kv,
    audit,
  };
}

async function putTokenPair(
  env: Env,
  opts: { reference?: boolean; verifierHash?: string; referenceExpiry?: number; tokenExpiry?: number } = {}
) {
  const rawToken = `mlt_${'t'.repeat(32)}`;
  const hash = await hashToken(rawToken);
  const expiresAt = opts.tokenExpiry ?? Date.now() + 5 * 60_000;
  const record = {
    user_id: USER,
    expires_at: expiresAt,
    ...(opts.verifierHash ? {
      secure_oob: { rendezvous_id: 'rv', verifier_hash: opts.verifierHash },
    } : {}),
  };
  await env.SESSIONS.put(`login_token:${hash}`, JSON.stringify(record));
  if (opts.reference) {
    await env.SESSIONS.put(
      `qr_ref:${REFERENCE}`,
      JSON.stringify({
        token_hash: hash,
        user_id: USER,
        created_at: Date.now(),
        expires_at: opts.referenceExpiry ?? Date.now() + 60_000,
      })
    );
  }
  return { rawToken, hash, tokenKey: `login_token:${hash}`, referenceKey: `qr_ref:${REFERENCE}` };
}

async function loginWith(body: Record<string, unknown>, env: Env) {
  return login.request(
    'https://example.com/_matrix/client/v3/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.token', ...body }),
    },
    env
  );
}

describe('010.6 QR login reference-ID exchange', () => {
  let ctx: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    ctx = makeEnv();
  });

  it('issuance returns no raw token, only a short-lived reference in the QR URL', async () => {
    const res = await admin.request(
      `https://example.com/admin/api/users/${encodeURIComponent(USER)}/login-token`,
      { method: 'POST', body: JSON.stringify({ ttl_minutes: 10 }) },
      ctx.env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await res.json() as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('mlt_');
    expect(typeof body.reference_id).toBe('string');
    expect(String(body.reference_id)).toMatch(/^qr_ref_[A-Za-z0-9_-]{16,128}$/);
    expect(String(body.qr_url)).toContain(`/login/qr/${body.reference_id}`);

    const refKey = `qr_ref:${body.reference_id}`;
    expect(ctx.kv.data[refKey]).toBeDefined();
    expect(ctx.kv.puts.find((p) => p.key === refKey)?.options?.expirationTtl).toBe(60);
    // The token is stored hashed alongside the reference, never in the response.
    expect(Object.keys(ctx.kv.data).some((k) => k.startsWith('login_token:'))).toBe(true);
    expect(ctx.audit.some((args) => String(args[2]).includes('login-token.create'))).toBe(true);
  });

  it('redeems a reference and burns both the reference and the token', async () => {
    const { tokenKey, referenceKey } = await putTokenPair(ctx.env, { reference: true });
    const res = await loginWith({ token: REFERENCE, device_id: 'DEV' }, ctx.env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.user_id).toBe(USER);

    expect(ctx.kv.data[tokenKey]).toBeUndefined();
    expect(ctx.kv.data[referenceKey]).toBeUndefined();
    expect(ctx.audit.some((args) =>
      String(args[2]).includes('login-token.redeem') &&
      String(args[6]).includes(REFERENCE)
    )).toBe(true);

    const replay = await loginWith({ token: REFERENCE }, ctx.env);
    expect(replay.status).toBe(403);
  });

  it('accepts a reference_id body field as an alternative to token', async () => {
    await putTokenPair(ctx.env, { reference: true });
    const res = await loginWith({ reference_id: REFERENCE }, ctx.env);
    expect(res.status).toBe(200);
  });

  it('keeps legacy raw-token redemption working', async () => {
    const { rawToken, tokenKey } = await putTokenPair(ctx.env);
    const res = await loginWith({ token: rawToken, device_id: 'LEGACY' }, ctx.env);
    expect(res.status).toBe(200);
    expect(ctx.kv.data[tokenKey]).toBeUndefined();
  });

  it('rejects malformed references without falling through to raw-token lookup', async () => {
    const { tokenKey } = await putTokenPair(ctx.env, { reference: true });
    const res = await loginWith({ token: 'qr_ref_short' }, ctx.env);
    expect(res.status).toBe(403);
    expect(ctx.kv.data[tokenKey]).toBeDefined();
  });

  it('a wrong verifier does not burn the reference or its token', async () => {
    const verifierHash = await hashToken('correct-verifier');
    const { tokenKey, referenceKey } = await putTokenPair(ctx.env, {
      reference: true,
      verifierHash,
    });
    const bad = await loginWith({ token: REFERENCE, verifier: 'wrong-verifier' }, ctx.env);
    expect(bad.status).toBe(403);
    expect(ctx.kv.data[tokenKey]).toBeDefined();
    expect(ctx.kv.data[referenceKey]).toBeDefined();

    const good = await loginWith({ token: REFERENCE, verifier: 'correct-verifier' }, ctx.env);
    expect(good.status).toBe(200);
    expect(ctx.kv.data[tokenKey]).toBeUndefined();
    expect(ctx.kv.data[referenceKey]).toBeUndefined();
  });

  it('QR landing and check endpoints resolve references without consuming them', async () => {
    await putTokenPair(ctx.env, { reference: true });

    const landing = await qrLogin.request(
      `https://example.com/login/qr/${REFERENCE}`,
      { method: 'GET' },
      ctx.env
    );
    expect(landing.status).toBe(200);
    expect(landing.headers.get('Cache-Control')).toBe('no-store');
    const html = await landing.text();
    expect(html).toContain('Login Reference');
    expect(html).not.toContain('mlt_');

    const legacyCheck = await qrLogin.request(
      `https://example.com/login/qr/${REFERENCE}/check`,
      { method: 'GET' },
      ctx.env
    );
    expect(legacyCheck.status).toBe(200);
    expect((await legacyCheck.json() as { valid: boolean }).valid).toBe(true);

    const canonicalCheck = await qrLogin.request(
      `https://example.com/_matrix/client/v1/login/qr/${REFERENCE}/check`,
      { method: 'GET' },
      ctx.env
    );
    expect(canonicalCheck.status).toBe(200);
    expect((await canonicalCheck.json() as { valid: boolean }).valid).toBe(true);

    expect(ctx.kv.data[`qr_ref:${REFERENCE}`]).toBeDefined();
  });
});
