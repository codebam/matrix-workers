// Authentication middleware

import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { hashToken } from '../utils/crypto';
import { getUserByTokenHash } from '../services/database';
import { getAppServiceByToken } from '../services/appservice';

export type AuthContext = {
  userId: string;
  deviceId: string | null;
  accessToken: string;
  // MSC4323 account moderation state, set only when moderated.
  locked?: boolean;
  suspended?: boolean;
};

// Extract access token from request
export function extractAccessToken(request: Request): string | null {
  // Check Authorization header first
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  // Fall back to query parameter
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('access_token');
  if (queryToken) {
    return queryToken;
  }

  return null;
}

// Validate access token and return user info
export async function validateAccessToken(
  db: D1Database,
  token: string
): Promise<AuthContext | null> {
  const tokenHash = await hashToken(token);
  const result = await getUserByTokenHash(db, tokenHash);

  if (!result) {
    return null;
  }

  return {
    userId: result.userId,
    deviceId: result.deviceId,
    accessToken: token,
    ...(result.locked ? { locked: true } : {}),
    ...(result.suspended ? { suspended: true } : {}),
  };
}

// Middleware that requires authentication
export function requireAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractAccessToken(c.req.raw);
    const path = new URL(c.req.url).pathname;
    const method = (c.req.raw.method || 'GET').toUpperCase();

    if (!token) {
      // Log full headers for debugging missing token
      const authHeader = c.req.raw.headers.get('Authorization');
      console.log(`[AUTH] Missing token for ${path}. Authorization header: ${authHeader || 'NONE'}`);
      return Errors.missingToken().toResponse();
    }

    // Log token prefix for debugging (first 8 chars only for security)
    const tokenPrefix = token.substring(0, 8);
    console.log(`[AUTH] Validating token ${tokenPrefix}... for ${path}`);

    let auth = await validateAccessToken(c.env.DB, token);

    // If normal token validation fails, try app service token
    if (!auth) {
      try {
        const appservice = await getAppServiceByToken(c.env.DB, token);
        if (appservice) {
          const url = new URL(c.req.url);
          const asUserId = url.searchParams.get('user_id');
          const asDeviceId = url.searchParams.get('device_id');
          const serverName = c.env.SERVER_NAME;

          if (asUserId) {
            // Validate the user_id format: must be @localpart:servername
            const userIdMatch = asUserId.match(/^@[a-z0-9._=/+-]+:[a-zA-Z0-9.-]+$/);
            if (!userIdMatch) {
              console.warn(`[AUTH] AppService tried to use invalid user_id format: ${asUserId}`);
              return Errors.forbidden('Invalid user_id format').toResponse();
            }

            // Validate that the user belongs to the local server
            const userServer = asUserId.split(':').slice(1).join(':');
            if (userServer !== serverName) {
              console.warn(`[AUTH] AppService tried to impersonate user on foreign server: ${asUserId}`);
              return Errors.forbidden('Cannot impersonate users on other servers').toResponse();
            }

            // Validate against the AppService's registered user namespace
            if (appservice.namespaces?.users?.length > 0) {
              const allowed = appservice.namespaces.users.some((ns) => {
                try { return new RegExp(ns.regex).test(asUserId); } catch { return false; }
              });
              if (!allowed) {
                console.warn(`[AUTH] AppService tried to act as user outside its namespace: ${asUserId}`);
                return Errors.forbidden('User not in application service namespace').toResponse();
              }
            }
          }

          const senderUserId = asUserId || `@${appservice.sender_localpart}:${serverName}`;

          // MSC4326: an appservice may also masquerade as a specific device of
          // the impersonated user (or of its own sender_localpart user). Validate
          // ownership before exposing it downstream — /sync scopes to-device
          // delivery and OTK counts by deviceId.
          let deviceId: string | null = null;
          if (asDeviceId) {
            const device = await c.env.DB.prepare(
              'SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?'
            )
              .bind(senderUserId, asDeviceId)
              .first<{ device_id: string }>();
            if (!device) {
              console.warn(
                `[AUTH] AppService tried to masquerade as device ${asDeviceId} not owned by ${senderUserId}`
              );
              return Errors.forbidden('Device does not belong to masqueraded user').toResponse();
            }
            deviceId = asDeviceId;
          }

          auth = {
            userId: senderUserId,
            deviceId,
            accessToken: token,
          };
        }
      } catch (asErr) {
        console.warn('[AUTH] AppService token lookup error:', asErr);
      }
    }

    if (!auth) {
      console.log(`[AUTH] Token ${tokenPrefix}... is INVALID for ${path}. Token length: ${token.length}`);
      return Errors.unknownToken().toResponse();
    }

    console.log(`[AUTH] Token ${tokenPrefix}... valid for user ${auth.userId}`);

    // MSC4323 account moderation (spec v1.18) enforcement. Locked accounts
    // get 401 M_USER_LOCKED (soft_logout) on everything but logout so the
    // client keeps its session and can poll for the unlock. Suspended
    // accounts keep read access and the spec's permitted action set.
    if (auth.locked) {
      const isLogout =
        path === '/_matrix/client/v3/logout' || path === '/_matrix/client/v3/logout/all';
      if (!isLogout) {
        return Errors.userLocked().toResponse();
      }
    } else if (auth.suspended && isForbiddenWhileSuspended(method, path, auth.userId)) {
      return Errors.userSuspended().toResponse();
    }

    // Store auth context
    c.set('auth', auth);
    c.set('userId', auth.userId);
    c.set('deviceId', auth.deviceId);
    c.set('accessToken', auth.accessToken);

    return next();
  });
}

// MSC4323 (spec v1.18): actions the spec recommends forbidding while an
// account is suspended — join/knock, accepting or sending invites, sending
// messages, changing profile data. The permitted set (sync, key backup,
// cross-signing, leave/reject, own redactions, logout, contacts, login) is
// unaffected and flows through untouched.
function isForbiddenWhileSuspended(method: string, path: string, userId: string): boolean {
  // Reads are always allowed; the spec's forbidden set is all write-shaped.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;

  if (method === 'POST') {
    // Joining, knocking, inviting (plus join-by-alias-or-id). Self-leave is
    // a separate POST /rooms/:id/leave route and stays available.
    if (/^\/_matrix\/client\/v\d+\/rooms\/[^/]+\/(join|knock|invite)$/.test(path)) return true;
    if (/^\/_matrix\/client\/v\d+\/join\//.test(path)) return true;
    // Moderation actions by a suspended user are nonsensical; the spec's
    // "implementation detail" latitude covers extending the set this way.
    if (/^\/_matrix\/client\/v\d+\/rooms\/[^/]+\/(kick|ban|unban)$/.test(path)) return true;
    return false;
  }

  if (method === 'PUT') {
    // Sending: redactions of their own events remain permitted (the spec
    // explicitly carves this out); performRedaction refines the case where
    // a suspended user tries to redact someone else's event.
    const sendMatch = path.match(
      /^\/_matrix\/client\/v\d+\/rooms\/[^/]+\/send\/([^/]+)\/[^/]+$/
    );
    if (sendMatch) {
      return decodeURIComponent(sendMatch[1]) !== 'm.room.redaction';
    }

    // State writes: forbidden except self-targeted membership writes, which
    // is how a suspended user leaves rooms and rejects invites.
    const stateMatch = path.match(
      /^\/_matrix\/client\/v\d+\/rooms\/[^/]+\/state\/([^/]+)(?:\/(.*))?$/
    );
    if (stateMatch) {
      const [, eventType, stateKey] = stateMatch;
      if (
        decodeURIComponent(eventType) === 'm.room.member' &&
        stateKey !== undefined &&
        decodeURIComponent(stateKey) === userId
      ) {
        return false;
      }
      return true;
    }

    // Profile changes (display name, avatar, extended fields).
    if (/^\/_matrix\/client\/v\d+\/profile\//.test(path)) return true;
  }

  return false;
}

// Middleware that allows optional authentication
export function optionalAuth() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const token = extractAccessToken(c.req.raw);

    if (token) {
      const auth = await validateAccessToken(c.env.DB, token);
      if (auth) {
        c.set('auth', auth);
        c.set('userId', auth.userId);
        c.set('deviceId', auth.deviceId);
        c.set('accessToken', auth.accessToken);
      }
    }

    return next();
  });
}
