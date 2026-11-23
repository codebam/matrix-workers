// Matrix login/registration endpoints

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Env } from '../types';
import { Errors } from '../utils/errors';
import { initiateIdpLogin, type IdPProvider } from './oidc-auth';
import { createVerificationSession, sendVerificationEmail } from '../services/email';
import { hashPassword, verifyPassword, hashToken, validatePasswordStrength, timingSafeEqual } from '../utils/crypto';
import {
  formatUserId,
  generateDeviceId,
  generateAccessToken,
  generateRefreshToken,
  generateOpaqueId,
  isValidLocalpart,
} from '../utils/ids';
import {
  createUser,
  getUserByLocalpart,
  getUserById,
  getPasswordHash,
  createDevice,
  createAccessToken,
  deleteAccessToken,
  deleteAllUserTokens,
  consumeRegistrationToken,
} from '../services/database';
import { requireAuth, extractAccessToken } from '../middleware/auth';
import { getAppServiceByToken } from '../services/appservice';
import { logLoginTokenRedemption } from '../services/admin-audit';

const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Login tokens (MSC4108 QR landing + MSC4388 secure out-of-band binding)
// ---------------------------------------------------------------------------

/** Shape stored under `login_token:<sha256(token)>` in SESSIONS. */
export interface LoginTokenRecord {
  user_id: string;
  expires_at: number;
  /**
   * Optional secure out-of-band binding. The raw verifier is derived from the
   * QR-scanned channel and is never stored; only its SHA-256 is kept here.
   * Both the QR check route and m.login.token redemption must present it.
   */
  secure_oob?: {
    rendezvous_id: string;
    verifier_hash: string;
  };
}

export function isLoginTokenExpired(record: LoginTokenRecord, now: number = Date.now()): boolean {
  return now > record.expires_at;
}

/**
 * `null` = token has no secure-OOB binding, `true` = verifier matches,
 * `false` = bound token presented without (or with the wrong) verifier.
 */
export async function matchesLoginTokenVerifier(
  record: LoginTokenRecord,
  verifier: unknown
): Promise<boolean | null> {
  if (!record.secure_oob) return null;
  if (typeof verifier !== 'string' || verifier.length === 0 || verifier.length > 512) return false;
  const presentedHash = await hashToken(verifier);
  return timingSafeEqual(presentedHash, record.secure_oob.verifier_hash);
}

// 010.6: admin-issued QR login tokens are no longer returned in the issuance
// response. A short-lived reference stands in for the token; redemption
// resolves it to the hashed token record entirely server-side.
export const QR_LOGIN_REFERENCE_PREFIX = 'qr_ref_';
const QR_REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** Shape stored under `qr_ref:<reference_id>` in SESSIONS. */
export interface QrLoginReferenceRecord {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface ResolvedLoginCredential {
  record: LoginTokenRecord;
  tokenKey: string;
  referenceKey?: string;
  referenceId?: string;
}

export function isQrLoginReference(credential: string): boolean {
  return (
    credential.startsWith(QR_LOGIN_REFERENCE_PREFIX) &&
    QR_REFERENCE_ID_PATTERN.test(credential.slice(QR_LOGIN_REFERENCE_PREFIX.length))
  );
}

/**
 * Resolve a legacy raw login token OR an admin-issued reference ID to the
 * underlying hashed token record. Malformed, missing, stale and already-
 * consumed credentials return null; stale references are cleaned up here.
 * Record expiry and verifier checks remain the caller's responsibility.
 */
export async function resolveLoginCredential(
  env: Env,
  credential: string
): Promise<ResolvedLoginCredential | null> {
  if (!credential || credential.length > 512) return null;

  let referenceKey: string | undefined;
  let referenceId: string | undefined;
  let tokenHash: string;

  if (isQrLoginReference(credential)) {
    referenceId = credential;
    referenceKey = `qr_ref:${credential}`;
    const reference = await env.SESSIONS.get(referenceKey, 'json') as QrLoginReferenceRecord | null;
    if (!reference || typeof reference.token_hash !== 'string' || !reference.token_hash) {
      if (reference) await env.SESSIONS.delete(referenceKey);
      return null;
    }
    if (Date.now() > reference.expires_at) {
      await env.SESSIONS.delete(referenceKey);
      return null;
    }
    tokenHash = reference.token_hash;
  } else {
    // A malformed reference must not fall through to the raw-token path.
    if (credential.startsWith(QR_LOGIN_REFERENCE_PREFIX)) return null;
    tokenHash = await hashToken(credential);
  }

  const tokenKey = `login_token:${tokenHash}`;
  const record = await env.SESSIONS.get(tokenKey, 'json') as LoginTokenRecord | null;
  if (!record) {
    // The reference outlived its token (already redeemed); clean it up.
    if (referenceKey) await env.SESSIONS.delete(referenceKey);
    return null;
  }
  return { record, tokenKey, referenceKey, referenceId };
}

/** Single-use consumption: burn the token AND its reference, if any. */
export async function consumeLoginCredential(
  env: Env,
  resolved: ResolvedLoginCredential
): Promise<void> {
  await env.SESSIONS.delete(resolved.tokenKey);
  if (resolved.referenceKey) await env.SESSIONS.delete(resolved.referenceKey);
}

// The admin portal's registration toggle lives in the Admin Durable Object.
// Enforce it here; when the binding is absent (tests) or unreadable, fall back
// to allowing registration rather than locking everyone out.
async function registrationDisabled(env: import('../types').Env): Promise<boolean> {
  if (!env.ADMIN) return false;
  try {
    const stub = env.ADMIN.get(env.ADMIN.idFromName('global'));
    const res = await stub.fetch('http://internal/config');
    if (!res.ok) return false;
    const config = (await res.json()) as { registration_enabled?: boolean };
    return config.registration_enabled === false;
  } catch {
    return false;
  }
}

// GET /_matrix/client/v3/login - Get supported login flows
app.get('/_matrix/client/v3/login', async (c) => {
  const flows: Record<string, unknown>[] = [
    {
      type: 'm.login.password',
    },
    {
      type: 'm.login.token',
    },
  ];

  // Advertise m.login.sso when identity providers are configured, so clients
  // render the SSO button and can pick an IdP via /login/sso/redirect/{idpId}.
  try {
    const idps = await c.env.DB.prepare(`
      SELECT id, name, icon_url FROM idp_providers
      WHERE enabled = 1 ORDER BY display_order ASC, name ASC
    `).all<{ id: string; name: string; icon_url: string | null }>();
    if (idps.results.length > 0) {
      flows.push({
        type: 'm.login.sso',
        identity_providers: idps.results.map(p => ({
          id: p.id,
          name: p.name,
          ...(p.icon_url ? { icon: p.icon_url } : {}),
        })),
      });
    }
  } catch {
    // idp_providers absent (minimal deployment) — password/token only.
  }

  return c.json({ flows });
});

// GET /_matrix/client/v3/login/sso/redirect[/:idpId] - Spec SSO login entry.
// Validates the client's redirectUrl, then starts the IdP OAuth flow; the
// callback returns to redirectUrl with a one-time loginToken.
async function handleSsoRedirect(c: Context<AppEnv>, idpId?: string): Promise<Response> {
  const redirectUrl = c.req.query('redirectUrl');
  if (!redirectUrl) {
    return Errors.missingParam('redirectUrl').toResponse();
  }
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return Errors.invalidParam('redirectUrl', 'redirectUrl must be an absolute URL').toResponse();
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Errors.invalidParam('redirectUrl', 'redirectUrl must use http or https').toResponse();
  }

  const db = c.env.DB;
  let provider;
  if (idpId) {
    provider = await db.prepare(`
      SELECT * FROM idp_providers WHERE id = ? AND enabled = 1
    `).bind(idpId).first<IdPProvider>();
    if (!provider) {
      return Errors.notFound('Identity provider not found').toResponse();
    }
  } else {
    // Without an explicit IdP, use the first enabled provider in display
    // order; clients that support multiple IdPs use the /{idpId} variant.
    provider = await db.prepare(`
      SELECT * FROM idp_providers WHERE enabled = 1
      ORDER BY display_order ASC, name ASC LIMIT 1
    `).first<IdPProvider>();
    if (!provider) {
      return Errors.notFound('SSO is not configured on this server').toResponse();
    }
  }

  return initiateIdpLogin(c, provider, { ssoRedirectUrl: redirectUrl });
}

app.get('/_matrix/client/v3/login/sso/redirect', (c) => handleSsoRedirect(c));
app.get('/_matrix/client/v3/login/sso/redirect/:idpId', (c) => handleSsoRedirect(c, c.req.param('idpId')));

// POST /_matrix/client/v3/login - Login
app.post('/_matrix/client/v3/login', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const {
    type, identifier, password, token, reference_id, verifier, device_id, initial_device_display_name
  } = body;

  let userId: string;

  if (type === 'm.login.token') {
    // 010.6: accept the legacy raw token OR an admin-issued reference ID.
    // The reference never leaves the server as a live credential.
    const credential = typeof reference_id === 'string' && reference_id ? reference_id : token;
    if (!credential || typeof credential !== 'string') {
      return Errors.missingParam('token').toResponse();
    }
    if (typeof reference_id === 'string' && reference_id && !isQrLoginReference(reference_id)) {
      return Errors.invalidParam('reference_id', 'Invalid reference ID format').toResponse();
    }

    const resolved = await resolveLoginCredential(c.env, credential);
    if (!resolved) {
      return Errors.forbidden('Invalid or expired login token').toResponse();
    }
    const tokenData = resolved.record;

    // Check expiration
    if (isLoginTokenExpired(tokenData)) {
      await consumeLoginCredential(c.env, resolved);
      return Errors.forbidden('Login token has expired').toResponse();
    }

    // MSC4388 secure out-of-band: a bound token is redeemable only by the
    // device that can present the verifier exchanged over the QR channel.
    // Verify BEFORE burning the token so a wrong verifier stays retryable.
    if (await matchesLoginTokenVerifier(tokenData, verifier) === false) {
      return Errors.forbidden('Invalid QR verifier').toResponse();
    }

    userId = tokenData.user_id;

    // Delete the token and its reference (single-use)
    await consumeLoginCredential(c.env, resolved);
    if (resolved.referenceId) {
      await logLoginTokenRedemption(c, {
        userId,
        referenceId: resolved.referenceId,
        ...(typeof device_id === 'string' ? { deviceId: device_id } : {}),
      });
    }

  } else if (type === 'm.login.password') {
    // Password-based login
    if (!identifier || !password) {
      return Errors.missingParam('identifier or password').toResponse();
    }

    // Parse identifier
    if (identifier.type === 'm.id.user') {
      // Can be full user ID or just localpart
      if (identifier.user.startsWith('@')) {
        userId = identifier.user;
      } else {
        userId = formatUserId(identifier.user, c.env.SERVER_NAME);
      }
    } else {
      return Errors.unrecognized('Unknown identifier type').toResponse();
    }

    // Check for account lockout (brute force protection)
    const lockoutKey = `lockout:${userId}`;
    const lockoutData = await c.env.SESSIONS.get(lockoutKey, 'json') as {
      attempts: number;
      lockedUntil?: number;
    } | null;

    if (lockoutData?.lockedUntil && Date.now() < lockoutData.lockedUntil) {
      const retryAfterMs = lockoutData.lockedUntil - Date.now();
      return c.json({
        errcode: 'M_LIMIT_EXCEEDED',
        error: 'Too many failed login attempts. Try again later.',
        retry_after_ms: retryAfterMs,
      }, 429);
    }

    // Get stored password hash
    const storedHash = await getPasswordHash(c.env.DB, userId);
    if (!storedHash) {
      return Errors.forbidden('Invalid username or password').toResponse();
    }

    // Verify password
    const valid = await verifyPassword(password, storedHash);
    if (!valid) {
      // Track failed attempt
      const attempts = (lockoutData?.attempts || 0) + 1;
      const lockout: { attempts: number; lockedUntil?: number } = { attempts };
      // Lock account after 5 failed attempts for 15 minutes
      if (attempts >= 5) {
        lockout.lockedUntil = Date.now() + 15 * 60 * 1000;
        console.warn(`[login] Account ${userId} locked after ${attempts} failed attempts`);
      }
      // Store with 1-hour TTL so counters auto-expire
      await c.env.SESSIONS.put(lockoutKey, JSON.stringify(lockout), { expirationTtl: 3600 });
      return Errors.forbidden('Invalid username or password').toResponse();
    }

    // Clear failed attempts on successful login
    if (lockoutData) {
      await c.env.SESSIONS.delete(lockoutKey);
    }
  } else {
    // m.login.dummy is deliberately not a login type: it is only a UIA stage
    // for registration. Treating it as a login would hand out access tokens
    // for any user without credentials (account takeover).
    return Errors.unrecognized('Unknown login type').toResponse();
  }

  // Check if user is deactivated
  const user = await getUserById(c.env.DB, userId);
  if (!user) {
    return Errors.forbidden('Invalid username or password').toResponse();
  }
  if (user.is_deactivated) {
    return Errors.userDeactivated().toResponse();
  }

  // Generate or use provided device ID
  const deviceId = device_id || await generateDeviceId();

  // Create device
  await createDevice(c.env.DB, userId, deviceId, initial_device_display_name);

  // Generate access token
  const accessToken = await generateAccessToken();
  const tokenHash = await hashToken(accessToken);
  const tokenId = await generateOpaqueId(16);

  await createAccessToken(c.env.DB, tokenId, tokenHash, userId, deviceId);

  // Generate refresh token and store in KV with auto-expiration
  const refreshToken = await generateRefreshToken();
  const refreshTokenHash = await hashToken(refreshToken);

  // Store refresh token in KV with 7-day TTL
  await c.env.SESSIONS.put(
    `refresh:${refreshTokenHash}`,
    JSON.stringify({
      userId,
      deviceId,
      accessTokenId: tokenId,
      createdAt: Date.now(),
    }),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  // Access token expires in 1 hour (client should use refresh before this)
  const expiresInMs = 60 * 60 * 1000; // 1 hour

  return c.json({
    user_id: userId,
    access_token: accessToken,
    device_id: deviceId,
    home_server: c.env.SERVER_NAME,
    refresh_token: refreshToken,
    expires_in_ms: expiresInMs,
  });
});

// POST /_matrix/client/v3/logout - Logout current session
app.post('/_matrix/client/v3/logout', requireAuth(), async (c) => {
  const token = extractAccessToken(c.req.raw);
  if (token) {
    const tokenHash = await hashToken(token);
    await deleteAccessToken(c.env.DB, tokenHash);
  }
  return c.json({});
});

// POST /_matrix/client/v3/logout/all - Logout all sessions
app.post('/_matrix/client/v3/logout/all', requireAuth(), async (c) => {
  const userId = c.get('userId');
  await deleteAllUserTokens(c.env.DB, userId);
  return c.json({});
});

// POST /_matrix/client/v3/refresh - Refresh access token
// Uses the refresh token to get a new access token + refresh token pair
// Implements token rotation (single-use refresh tokens)
app.post('/_matrix/client/v3/refresh', async (c) => {
  let body: { refresh_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { refresh_token: refreshToken } = body;

  if (!refreshToken) {
    return Errors.missingParam('refresh_token').toResponse();
  }

  // Hash the incoming refresh token
  const refreshTokenHash = await hashToken(refreshToken);

  // Look up in KV
  const tokenData = await c.env.SESSIONS.get(`refresh:${refreshTokenHash}`, 'json') as {
    userId: string;
    deviceId: string | null;
    accessTokenId: string;
    createdAt: number;
  } | null;

  if (!tokenData) {
    return Errors.unknownToken('Invalid or expired refresh token').toResponse();
  }

  const { userId, deviceId, accessTokenId } = tokenData;

  // Delete old refresh token from KV (token rotation - single use)
  await c.env.SESSIONS.delete(`refresh:${refreshTokenHash}`);

  // Delete old access token from D1
  await c.env.DB.prepare(
    `DELETE FROM access_tokens WHERE token_id = ?`
  ).bind(accessTokenId).run();

  // Generate new access token
  const newAccessToken = await generateAccessToken();
  const newTokenHash = await hashToken(newAccessToken);
  const newTokenId = await generateOpaqueId(16);

  await createAccessToken(c.env.DB, newTokenId, newTokenHash, userId, deviceId);

  // Generate new refresh token
  const newRefreshToken = await generateRefreshToken();
  const newRefreshTokenHash = await hashToken(newRefreshToken);

  // Store new refresh token in KV with 7-day TTL
  await c.env.SESSIONS.put(
    `refresh:${newRefreshTokenHash}`,
    JSON.stringify({
      userId,
      deviceId,
      accessTokenId: newTokenId,
      createdAt: Date.now(),
    }),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  // Access token expires in 1 hour
  const expiresInMs = 60 * 60 * 1000;

  return c.json({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    expires_in_ms: expiresInMs,
  });
});

// GET /_matrix/client/v3/register/available - Check if username is available
app.get('/_matrix/client/v3/register/available', async (c) => {
  const username = c.req.query('username');

  if (!username) {
    return Errors.missingParam('username').toResponse();
  }

  if (!isValidLocalpart(username)) {
    return Errors.invalidUsername('Username contains invalid characters').toResponse();
  }

  const existing = await getUserByLocalpart(c.env.DB, username);
  if (existing) {
    return Errors.userInUse().toResponse();
  }

  return c.json({ available: true });
});

// POST /_matrix/client/v3/register - Register new user
app.post('/_matrix/client/v3/register', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const {
    username,
    password,
    device_id,
    initial_device_display_name,
    inhibit_login,
    token,
    auth,
  } = body;

  // MSC4190: an application service may register users in its own namespace
  // using its as_token, without UIA or a password. Mirror requireAuth's
  // user_id validation (format, local server, registered namespace); a valid
  // as_token is required, and requests without one keep the existing flow.
  let asRegistrationUserId: string | null = null;
  // Extract the token locally: the as_token arrives either as a Bearer header
  // or the access_token query param (same sources auth.ts accepts).
  const bearer = c.req.raw.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i);
  const requestToken = bearer?.[1] ?? c.req.query('access_token');
  if (requestToken) {
    try {
      const appservice = await getAppServiceByToken(c.env.DB, requestToken);
      if (appservice) {
        const suppliedUserId = c.req.query('user_id') ?? body.user_id;
        if (typeof suppliedUserId !== 'string' || !suppliedUserId) {
          return Errors.missingParam('user_id').toResponse();
        }
        if (!/^@[a-z0-9._=/+-]+:[a-zA-Z0-9.-]+$/.test(suppliedUserId)) {
          return Errors.forbidden('Invalid user_id format').toResponse();
        }
        const userServer = suppliedUserId.split(':').slice(1).join(':');
        if (userServer !== c.env.SERVER_NAME) {
          return Errors.forbidden('Cannot register users on other servers').toResponse();
        }
        const inNamespace = (appservice.namespaces?.users ?? []).some((ns) => {
          try { return new RegExp(ns.regex).test(suppliedUserId); } catch { return false; }
        });
        if (!inNamespace) {
          return Errors.forbidden('User not in application service namespace').toResponse();
        }
        asRegistrationUserId = suppliedUserId;
      }
    } catch (asErr) {
      console.warn('[register] AppService token lookup error:', asErr);
    }
  }
  const isAppserviceRegistration = asRegistrationUserId !== null;

  // Check registration kind
  const kind = c.req.query('kind') || 'user';
  if (kind !== 'user' && kind !== 'guest') {
    return Errors.invalidParam('kind', 'Invalid registration kind').toResponse();
  }

  if (!isAppserviceRegistration && await registrationDisabled(c.env)) {
    return Errors.forbidden('Registration is disabled').toResponse();
  }

  const isGuest = !isAppserviceRegistration && kind === 'guest';

  // Invite-only mode (REGISTRATION_REQUIRE_TOKEN): every registration, user
  // or guest, must present a valid, unspent registration token.
  const tokenRequired =
    c.env.REGISTRATION_REQUIRE_TOKEN === 'true' || c.env.REGISTRATION_REQUIRE_TOKEN === '1';

  // For non-guests, require username and password (appservices are exempt:
  // they supply a validated user_id instead and have no password to give).
  if (!isGuest && !isAppserviceRegistration) {
    // Simple auth - in production, implement UIA (User-Interactive Authentication)
    const authAccepted =
      auth?.type === 'm.login.dummy' ||
      (tokenRequired && auth?.type === 'm.login.registration_token');
    if (!authAccepted) {
      // Return UIA requirements
      const sessionId = await generateOpaqueId(16);
      return c.json({
        flows: [{ stages: tokenRequired ? ['m.login.registration_token'] : ['m.login.dummy'] }],
        params: {},
        session: sessionId,
      }, 401);
    }

    if (!username) {
      return Errors.missingParam('username').toResponse();
    }

    if (!isValidLocalpart(username)) {
      return Errors.invalidUsername('Username contains invalid characters').toResponse();
    }

    if (!password) {
      return Errors.missingParam('password').toResponse();
    }

    // Validate password strength
    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return c.json({ errcode: 'M_WEAK_PASSWORD', error: passwordError }, 400);
    }
  }

  // Generate localpart for guests; appservices supply the full user_id.
  let localpart: string;
  let userId: string;
  if (asRegistrationUserId) {
    userId = asRegistrationUserId;
    localpart = userId.slice(1, userId.indexOf(':'));
  } else {
    localpart = isGuest ? await generateOpaqueId(12) : username;
    userId = formatUserId(localpart, c.env.SERVER_NAME);
  }

  // Check if user already exists
  const existing = await getUserById(c.env.DB, userId);
  if (existing) {
    return Errors.userInUse().toResponse();
  }

  // Invite-only: consume the registration token only after every other check
  // has passed, so failed or duplicate registrations never burn a token. The
  // UPDATE is atomic, making single-use tokens safe under concurrent attempts.
  if (tokenRequired && !isAppserviceRegistration) {
    const candidateToken =
      (typeof auth?.token === 'string' && auth.token) ||
      (typeof token === 'string' && token) ||
      (typeof body.invite_token === 'string' && body.invite_token) ||
      c.req.query('token') ||
      '';
    if (!candidateToken) {
      return Errors.forbidden('Registration token required').toResponse();
    }
    const consumed = await consumeRegistrationToken(c.env.DB, await hashToken(candidateToken));
    if (!consumed) {
      return Errors.forbidden('Invalid or expired registration token').toResponse();
    }
  }

  // Hash password (null for guests and appservice-provisioned users)
  const passwordHash = isAppserviceRegistration ? null : (password ? await hashPassword(password) : null);

  // Create user
  await createUser(c.env.DB, userId, localpart, passwordHash, isGuest);

  // Response depends on inhibit_login
  if (inhibit_login) {
    return c.json({
      user_id: userId,
      home_server: c.env.SERVER_NAME,
    });
  }

  // Generate device and access token
  const deviceId = device_id || await generateDeviceId();
  await createDevice(c.env.DB, userId, deviceId, initial_device_display_name);

  const accessToken = await generateAccessToken();
  const tokenHash = await hashToken(accessToken);
  const tokenId = await generateOpaqueId(16);

  await createAccessToken(c.env.DB, tokenId, tokenHash, userId, deviceId);

  // Generate refresh token and store in KV with auto-expiration
  const refreshToken = await generateRefreshToken();
  const refreshTokenHash = await hashToken(refreshToken);

  // Store refresh token in KV with 7-day TTL
  await c.env.SESSIONS.put(
    `refresh:${refreshTokenHash}`,
    JSON.stringify({
      userId,
      deviceId,
      accessTokenId: tokenId,
      createdAt: Date.now(),
    }),
    { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
  );

  // Access token expires in 1 hour
  const expiresInMs = 60 * 60 * 1000;

  return c.json({
    user_id: userId,
    access_token: accessToken,
    device_id: deviceId,
    home_server: c.env.SERVER_NAME,
    refresh_token: refreshToken,
    expires_in_ms: expiresInMs,
  });
});

// POST /_matrix/client/v3/register/email/requestToken - Email verification
// during registration (spec v1.17). Mirrors account/3pid/email/requestToken:
// the sid is later presented in the m.login.email.identity UIA stage.
app.post('/_matrix/client/v3/register/email/requestToken', async (c) => {
  const db = c.env.DB;

  let body: {
    client_secret: string;
    email: string;
    send_attempt: number;
    next_link?: string;
    id_server?: string;
    id_access_token?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { client_secret, email, send_attempt } = body;
  if (!client_secret) {
    return Errors.missingParam('client_secret').toResponse();
  }
  if (!email) {
    return Errors.missingParam('email').toResponse();
  }
  if (send_attempt === undefined) {
    return Errors.missingParam('send_attempt').toResponse();
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return c.json({ errcode: 'M_INVALID_EMAIL', error: 'Invalid email address format' }, 400);
  }

  const existingBinding = await db.prepare(`
    SELECT user_id FROM user_threepids
    WHERE medium = 'email' AND address = ?
  `).bind(email).first<{ user_id: string }>();
  if (existingBinding) {
    return c.json({
      errcode: 'M_THREEPID_IN_USE',
      error: 'This email is already associated with an account',
    }, 400);
  }

  const result = await createVerificationSession(db, email, client_secret, send_attempt);
  if ('error' in result) {
    return c.json({ errcode: 'M_THREEPID_DENIED', error: result.error }, 400);
  }

  if (result.token) {
    const emailResult = await sendVerificationEmail(c.env, email, result.token, c.env.SERVER_NAME);
    if (!emailResult.success) {
      await db.prepare(`
        DELETE FROM email_verification_sessions WHERE session_id = ?
      `).bind(result.sessionId).run();
      return c.json({
        errcode: 'M_THREEPID_DENIED',
        error: emailResult.error || 'Failed to send verification email',
      }, 500);
    }
  }

  return c.json({ sid: result.sessionId });
});

// POST /_matrix/client/v3/register/msisdn/requestToken - Phone verification
// is not supported (no SMS gateway), same as the account 3PID variant.
app.post('/_matrix/client/v3/register/msisdn/requestToken', async (c) => {
  return c.json({
    errcode: 'M_THREEPID_DENIED',
    error: 'Phone verification is not supported',
  }, 403);
});

// POST /_matrix/client/v1/login/get_token - Generate a login token for authenticated user
// Per Matrix spec: generates a short-lived login token for QR code login and similar flows
app.post('/_matrix/client/v1/login/get_token', requireAuth(), async (c) => {
  const userId = c.get('userId');

  // Optional MSC4388 secure out-of-band binding. A logged-in device creates
  // the rendezvous channel and derives a high-entropy verifier from the QR
  // exchange; the server stores only its hash. Requests without these fields
  // keep the original token shape/response (plain MSC4108-style token).
  let secureOob: LoginTokenRecord['secure_oob'];
  const rawBody = await c.req.text();
  if (rawBody) {
    let parsed: { rendezvous_id?: unknown; verifier?: unknown } | null;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return Errors.badJson().toResponse();
    }
    const rendezvousId = parsed?.rendezvous_id;
    const verifier = parsed?.verifier;
    if (rendezvousId !== undefined || verifier !== undefined) {
      if (rendezvousId === undefined) {
        return Errors.missingParam('rendezvous_id').toResponse();
      }
      if (verifier === undefined) {
        return Errors.missingParam('verifier').toResponse();
      }
      if (
        typeof rendezvousId !== 'string' ||
        rendezvousId.length === 0 ||
        rendezvousId.length > 255
      ) {
        return Errors.invalidParam(
          'rendezvous_id',
          'rendezvous_id must be a non-empty string of at most 255 characters'
        ).toResponse();
      }
      if (typeof verifier !== 'string' || verifier.length < 8 || verifier.length > 512) {
        return Errors.invalidParam(
          'verifier',
          'verifier must be a string of 8 to 512 characters'
        ).toResponse();
      }
      secureOob = { rendezvous_id: rendezvousId, verifier_hash: await hashToken(verifier) };
    }
  }

  // Generate a login token
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const loginToken = btoa(String.fromCharCode(...tokenBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Token is valid for 2 minutes (per Matrix spec recommendation)
  const expiresInMs = 2 * 60 * 1000;
  const expiresAt = Date.now() + expiresInMs;

  // Store the token in KV with TTL
  const tokenHash = await hashToken(loginToken);
  const record: LoginTokenRecord = {
    user_id: userId,
    expires_at: expiresAt,
    ...(secureOob ? { secure_oob: secureOob } : {}),
  };
  await c.env.SESSIONS.put(
    `login_token:${tokenHash}`,
    JSON.stringify(record),
    {
      expirationTtl: 120, // 2 minutes in seconds
    }
  );

  return c.json({
    login_token: loginToken,
    expires_in_ms: expiresInMs,
    ...(secureOob ? { secure_oob: true } : {}),
  });
});

// GET /_matrix/client/v3/account/whoami - Get current user info
app.get('/_matrix/client/v3/account/whoami', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const deviceId = c.get('deviceId');

  const user = await getUserById(c.env.DB, userId);
  if (!user) {
    return Errors.unknownToken().toResponse();
  }

  return c.json({
    user_id: userId,
    device_id: deviceId,
    is_guest: user.is_guest,
  });
});

export default app;
