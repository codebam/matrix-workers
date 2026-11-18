/**
 * Spec SSO login (Matrix v1.17): GET /login flow advertising,
 * /login/sso/redirect[/{idpId}], the OIDC callback completing with a
 * one-time loginToken, and the m.login.token exchange at POST /login.
 * Also covers register/email|msisdn/requestToken and the invite-only
 * registration-token validity endpoint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
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

const oidcMocks = vi.hoisted(() => ({
  discovery: vi.fn(),
  jwks: vi.fn(),
  exchange: vi.fn(),
  validate: vi.fn(),
}));

vi.mock('../src/services/oidc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/oidc')>();
  return {
    ...actual,
    fetchOIDCDiscovery: oidcMocks.discovery,
    fetchJWKS: oidcMocks.jwks,
    exchangeCodeForTokens: oidcMocks.exchange,
    validateIDToken: oidcMocks.validate,
  };
});

const emailMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('../src/services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/email')>();
  return {
    ...actual,
    createVerificationSession: emailMocks.createSession,
    sendVerificationEmail: emailMocks.sendEmail,
  };
});

import login from '../src/api/login';
import oidcAuth from '../src/api/oidc-auth';
import account from '../src/api/account';

const SERVER = 'example.com';
const ALICE = `@alice:${SERVER}`;
const CLIENT_REDIRECT = 'https://client.example/done';

const DISCOVERY = {
  issuer: 'https://idp.example',
  authorization_endpoint: 'https://idp.example/authorize',
  token_endpoint: 'https://idp.example/token',
  jwks_uri: 'https://idp.example/jwks',
};

// AES-GCM secret encryption matching oidc-auth's version-0x02 format.
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
const OIDC_ENCRYPTION_KEY = btoa(String.fromCharCode(...keyBytes));

async function encryptSecret(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
  const combined = new Uint8Array(1 + iv.length + enc.byteLength);
  combined[0] = 0x02;
  combined.set(iv, 1);
  combined.set(new Uint8Array(enc), 1 + iv.length);
  return btoa(String.fromCharCode(...combined));
}

interface ProviderRow {
  id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
}

interface TokenRow {
  token_hash: string;
  uses_remaining: number;
  expires_at: number | null;
  revoked: number;
}

function mockKv() {
  const data: Record<string, string> = {};
  return {
    data,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

function createDb(seed: { providers?: ProviderRow[]; tokens?: TokenRow[]; threepids?: { medium: string; address: string; user_id: string }[] } = {}) {
  const providers = seed.providers ?? [];
  const tokens = seed.tokens ?? [];
  const threepids = seed.threepids ?? [];
  const users = new Map<string, Record<string, unknown>>();
  const links: Array<Record<string, unknown>> = [];
  const calls: string[] = [];

  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        calls.push(sql);
        if (sql.includes('FROM idp_providers WHERE id = ?')) {
          const p = providers.find(p => p.id === args[0] && p.enabled === 1);
          return (p ?? null) as T | null;
        }
        if (sql.includes('FROM idp_providers')) {
          const enabled = providers.filter(p => p.enabled === 1)
            .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
          return (enabled[0] ?? null) as T | null;
        }
        if (sql.includes('FROM idp_user_links')) {
          const l = links.find(l => l.provider_id === args[0] && l.external_id === args[1]);
          return (l ?? null) as T | null;
        }
        if (sql.includes('FROM users WHERE user_id')) {
          return (users.get(args[0] as string) ?? null) as T | null;
        }
        if (sql.includes('FROM user_threepids')) {
          const t = threepids.find(t => t.medium === 'email' && t.address === args[0]);
          return (t ? { user_id: t.user_id } : null) as T | null;
        }
        if (sql.includes('FROM registration_tokens WHERE token_hash')) {
          const t = tokens.find(t => t.token_hash === args[0]);
          return (t ?? null) as T | null;
        }
        if (sql.includes('password_hash FROM users')) {
          return null as T;
        }
        return null as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        calls.push(sql);
        if (sql.includes('FROM idp_providers')) {
          const enabled = providers.filter(p => p.enabled === 1)
            .sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
          return { results: enabled as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        calls.push(sql);
        if (sql.includes('INSERT INTO users')) {
          const [user_id, localpart] = args as [string, string];
          users.set(user_id, {
            user_id,
            localpart,
            display_name: null,
            avatar_url: null,
            password_hash: null,
            is_guest: 0,
            is_deactivated: 0,
            admin: 0,
            created_at: Date.now(),
          });
        }
        if (sql.includes('INSERT INTO idp_user_links')) {
          const [provider_id, external_id, user_id] = args as [string, string, string];
          links.push({ id: links.length + 1, provider_id, external_id, user_id });
        }
        return { success: true, meta: { changes: 1 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };

  return { users, links, calls, prepare: (sql: string) => stmt(sql) };
}

type Db = ReturnType<typeof createDb>;

function envFor(db: Db, kv: ReturnType<typeof mockKv>, extras: Record<string, unknown> = {}): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db as unknown as D1Database,
    SESSIONS: kv as unknown as KVNamespace,
    CACHE: mockKv() as unknown as KVNamespace,
    OIDC_ENCRYPTION_KEY,
    ...extras,
  } as unknown as Env;
}

async function providerRow(id: string, enabled = 1): Promise<ProviderRow> {
  return {
    id,
    name: id === 'google' ? 'Google' : 'Okta',
    issuer_url: 'https://idp.example',
    client_id: 'client-id',
    client_secret_encrypted: await encryptSecret('client-secret'),
    scopes: 'openid profile email',
    enabled,
    auto_create_users: 1,
    username_claim: 'email',
    display_order: id === 'google' ? 0 : 1,
    icon_url: id === 'google' ? 'mxc://example.com/google-icon' : null,
  };
}

async function get(module: { request: (input: string, init: RequestInit | undefined, env: Env) => Promise<Response> }, path: string, env: Env) {
  const res = await module.request(`http://localhost${path}`, { method: 'GET' }, env);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML responses stay as text
  }
  return { status: res.status, body: body as Record<string, any>, headers: res.headers };
}

async function post(module: { request: (input: string, init: RequestInit | undefined, env: Env) => Promise<Response> }, path: string, body: unknown, env: Env) {
  const res = await module.request(
    `http://localhost${path}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  oidcMocks.discovery.mockReset().mockResolvedValue(DISCOVERY);
  oidcMocks.jwks.mockReset().mockResolvedValue({ keys: [] });
  oidcMocks.exchange.mockReset().mockResolvedValue({ id_token: 'fake-id-token' });
  oidcMocks.validate.mockReset().mockResolvedValue({ sub: 'ext-1', email: 'alice@example.com', name: 'Alice' });
  emailMocks.createSession.mockReset().mockResolvedValue({ sessionId: 'sid-1', token: '123456' });
  emailMocks.sendEmail.mockReset().mockResolvedValue({ success: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('GET /login flow advertising', () => {
  it('advertises only password/token without IdPs', async () => {
    const env = envFor(createDb(), mockKv());
    const { status, body } = await get(login, '/_matrix/client/v3/login', env);
    expect(status).toBe(200);
    expect(body.flows).toEqual([{ type: 'm.login.password' }, { type: 'm.login.token' }]);
  });

  it('advertises m.login.sso with identity_providers when IdPs are configured', async () => {
    const db = createDb({ providers: [await providerRow('google'), await providerRow('okta')] });
    const env = envFor(db, mockKv());
    const { body } = await get(login, '/_matrix/client/v3/login', env);
    const sso = body.flows.find((f: any) => f.type === 'm.login.sso');
    expect(sso).toBeDefined();
    expect(sso.identity_providers).toEqual([
      { id: 'google', name: 'Google', icon: 'mxc://example.com/google-icon' },
      { id: 'okta', name: 'Okta' },
    ]);
  });
});

describe('GET /login/sso/redirect', () => {
  it('requires redirectUrl', async () => {
    const env = envFor(createDb({ providers: [await providerRow('google')] }), mockKv());
    const { status, body } = await get(login, '/_matrix/client/v3/login/sso/redirect', env);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('rejects malformed and non-http redirectUrl values', async () => {
    const env = envFor(createDb({ providers: [await providerRow('google')] }), mockKv());
    for (const url of ['not a url', 'javascript:alert(1)', 'ftp://client.example']) {
      const { status, body } = await get(login, `/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(url)}`, env);
      expect(status).toBe(400);
      expect(body.errcode).toBe('M_INVALID_PARAM');
    }
  });

  it('answers 404 when SSO is not configured', async () => {
    const env = envFor(createDb(), mockKv());
    const { status, body } = await get(login, `/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('redirects to the IdP authorize endpoint and stores SSO state', async () => {
    const kv = mockKv();
    const env = envFor(createDb({ providers: [await providerRow('google')] }), kv);
    const { status, headers } = await get(login, `/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    expect(status).toBe(302);
    const location = headers.get('location')!;
    expect(location.startsWith('https://idp.example/authorize')).toBe(true);
    const state = new URL(location).searchParams.get('state')!;
    const stored = JSON.parse(kv.data[`oidc_state:${state}`]);
    expect(stored.providerId).toBe('google');
    expect(stored.ssoRedirectUrl).toBe(CLIENT_REDIRECT);
    expect(stored.redirectUri).toContain('/auth/oidc/google/callback');
  });

  it('idpId variant selects the provider and 404s on unknown/disabled IdPs', async () => {
    const env = envFor(createDb({ providers: [await providerRow('google'), await providerRow('okta', 0)] }), mockKv());
    const ok = await get(login, `/_matrix/client/v3/login/sso/redirect/okta?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    expect(ok.status).toBe(404);
    const unknown = await get(login, `/_matrix/client/v3/login/sso/redirect/nope?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    expect(unknown.status).toBe(404);
    const google = await get(login, `/_matrix/client/v3/login/sso/redirect/google?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    expect(google.status).toBe(302);
  });
});

describe('SSO callback → loginToken → POST /login integration', () => {
  async function startSso() {
    const kv = mockKv();
    const db = createDb({ providers: [await providerRow('google')] });
    const env = envFor(db, kv);
    const redirect = await get(login, `/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(CLIENT_REDIRECT)}`, env);
    const state = new URL(redirect.headers.get('location')!).searchParams.get('state')!;
    return { kv, db, env, state };
  }

  it('completes with a redirect carrying a one-time loginToken', async () => {
    const { kv, db, env, state } = await startSso();
    const res = await oidcAuth.request(`http://localhost/auth/oidc/google/callback?code=authcode&state=${state}`, { method: 'GET' }, env);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CLIENT_REDIRECT);
    const loginToken = location.searchParams.get('loginToken')!;
    expect(loginToken).toBeTruthy();

    // The token is stored hashed, bound to the auto-provisioned user.
    const stored = JSON.parse(kv.data[`login_token:${await hashToken(loginToken)}`]);
    expect(stored.user_id).toBe(ALICE);
    expect(stored.expires_at).toBeGreaterThan(Date.now());
    expect(db.users.has(ALICE)).toBe(true);
    // No access token was minted by the callback itself.
    expect(Object.keys(kv.data).some(k => k.startsWith('refresh:'))).toBe(false);
  });

  it('the client exchanges the loginToken at POST /login exactly once', async () => {
    const { kv, env, state } = await startSso();
    const res = await oidcAuth.request(`http://localhost/auth/oidc/google/callback?code=authcode&state=${state}`, { method: 'GET' }, env);
    const loginToken = new URL(res.headers.get('location')!).searchParams.get('loginToken')!;

    const first = await post(login, '/_matrix/client/v3/login', {
      type: 'm.login.token',
      token: loginToken,
      device_id: 'CLIENTDEVICE',
      initial_device_display_name: 'Element',
    }, env);
    expect(first.status).toBe(200);
    expect(first.body.user_id).toBe(ALICE);
    expect(first.body.device_id).toBe('CLIENTDEVICE');
    expect(typeof first.body.access_token).toBe('string');
    expect(typeof first.body.refresh_token).toBe('string');

    const second = await post(login, '/_matrix/client/v3/login', { type: 'm.login.token', token: loginToken }, env);
    expect(second.status).toBe(403);
  });

  it('callback without SSO state keeps the legacy success page', async () => {
    const kv = mockKv();
    const db = createDb({ providers: [await providerRow('google')] });
    const env = envFor(db, kv);
    const legacy = await get(oidcAuth, '/auth/oidc/google/login?return_to=/', env);
    expect(legacy.status).toBe(302);
    const state = new URL(legacy.headers.get('location')!).searchParams.get('state')!;
    const res = await oidcAuth.request(`http://localhost/auth/oidc/google/callback?code=authcode&state=${state}`, { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Login Successful');
  });
});

describe('POST /register/email/requestToken', () => {
  const path = '/_matrix/client/v3/register/email/requestToken';
  const validBody = { client_secret: 'secret123', email: 'new@example.com', send_attempt: 1 };

  it('creates a verification session and sends the email', async () => {
    const env = envFor(createDb(), mockKv());
    const { status, body } = await post(login, path, validBody, env);
    expect(status).toBe(200);
    expect(body).toEqual({ sid: 'sid-1' });
    expect(emailMocks.createSession).toHaveBeenCalledWith(expect.anything(), 'new@example.com', 'secret123', 1);
    expect(emailMocks.sendEmail).toHaveBeenCalledWith(expect.anything(), 'new@example.com', '123456', SERVER);
  });

  it('validates required params and email format', async () => {
    const env = envFor(createDb(), mockKv());
    expect((await post(login, path, { email: 'a@b.co', send_attempt: 1 }, env)).body.errcode).toBe('M_MISSING_PARAM');
    expect((await post(login, path, { client_secret: 's', send_attempt: 1 }, env)).body.errcode).toBe('M_MISSING_PARAM');
    expect((await post(login, path, { client_secret: 's', email: 'a@b.co' }, env)).body.errcode).toBe('M_MISSING_PARAM');
    const bad = await post(login, path, { ...validBody, email: 'not-an-email' }, env);
    expect(bad.status).toBe(400);
    expect(bad.body.errcode).toBe('M_INVALID_EMAIL');
  });

  it('rejects an email already bound to an account', async () => {
    const db = createDb({ threepids: [{ medium: 'email', address: 'new@example.com', user_id: ALICE }] });
    const env = envFor(db, mockKv());
    const { status, body } = await post(login, path, validBody, env);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_THREEPID_IN_USE');
    expect(emailMocks.createSession).not.toHaveBeenCalled();
  });

  it('cleans up the session when email delivery fails', async () => {
    emailMocks.sendEmail.mockResolvedValue({ success: false, error: 'EMAIL binding missing' });
    const db = createDb();
    const env = envFor(db, mockKv());
    const { status, body } = await post(login, path, validBody, env);
    expect(status).toBe(500);
    expect(body.errcode).toBe('M_THREEPID_DENIED');
    expect(db.calls.some(s => s.includes('DELETE FROM email_verification_sessions'))).toBe(true);
  });

  it('retry with same send_attempt returns the existing sid without re-sending', async () => {
    emailMocks.createSession.mockResolvedValue({ sessionId: 'sid-existing', token: '' });
    const env = envFor(createDb(), mockKv());
    const { status, body } = await post(login, path, validBody, env);
    expect(status).toBe(200);
    expect(body).toEqual({ sid: 'sid-existing' });
    expect(emailMocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /register/msisdn/requestToken', () => {
  it('answers 403 M_THREEPID_DENIED (no SMS gateway)', async () => {
    const env = envFor(createDb(), mockKv());
    const { status, body } = await post(login, '/_matrix/client/v3/register/msisdn/requestToken', {
      client_secret: 's', phone_number: '15551234567', send_attempt: 1,
    }, env);
    expect(status).toBe(403);
    expect(body.errcode).toBe('M_THREEPID_DENIED');
  });
});

describe('registration token validity (invite-only mode)', () => {
  const path = '/_matrix/client/v1/register/m.login.registration_token/validity';
  const raw = 'mrt_validtoken01';

  async function envWithToken(row: Partial<TokenRow> | null) {
    const tokens = row ? [{ token_hash: await hashToken(raw), uses_remaining: 1, expires_at: null, revoked: 0, ...row }] : [];
    return envFor(createDb({ tokens }), mockKv(), { REGISTRATION_REQUIRE_TOKEN: 'true' });
  }

  it('valid token is valid without consuming a use', async () => {
    const env = await envWithToken({});
    const { status, body } = await get(account, `${path}?token=${raw}`, env);
    expect(status).toBe(200);
    expect(body).toEqual({ valid: true });
  });

  it('unknown, expired, revoked and exhausted tokens are invalid', async () => {
    expect((await get(account, `${path}?token=${raw}`, await envWithToken(null))).body).toEqual({ valid: false });
    expect((await get(account, `${path}?token=${raw}`, await envWithToken({ expires_at: Date.now() - 1000 }))).body).toEqual({ valid: false });
    expect((await get(account, `${path}?token=${raw}`, await envWithToken({ revoked: 1 }))).body).toEqual({ valid: false });
    expect((await get(account, `${path}?token=${raw}`, await envWithToken({ uses_remaining: 0 }))).body).toEqual({ valid: false });
  });

  it('still requires the token query param', async () => {
    const env = await envWithToken({});
    const { status, body } = await get(account, path, env);
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });
});