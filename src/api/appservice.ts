// Application Service API
// Implements: https://spec.matrix.org/v1.12/application-service-api/

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { getAppServiceByToken, getAppServiceByHsToken } from '../services/appservice';
import { getUserById } from '../services/database';

const app = new Hono<AppEnv>();

// Middleware to authenticate requests from application services
async function requireAppServiceAuth(c: any, next: () => Promise<void>): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Errors.missingToken('Missing AS token').toResponse();
  }

  const token = authHeader.slice(7);
  const appservice = await getAppServiceByToken(c.env.DB, token);
  if (!appservice) {
    return Errors.unknownToken('Invalid AS token').toResponse();
  }

  c.set('appservice', appservice);
  return next();
}

// GET /_matrix/app/v1/users/:userId - Query if a user exists (AS → HS direction)
app.get('/_matrix/app/v1/users/:userId', requireAppServiceAuth, async (c) => {
  const userId = c.req.param('userId');
  const user = await getUserById(c.env.DB, userId);

  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  return c.json({});
});

// GET /_matrix/app/v1/rooms/:roomAlias - Query if a room alias exists
app.get('/_matrix/app/v1/rooms/:roomAlias', requireAppServiceAuth, async (c) => {
  const roomAlias = c.req.param('roomAlias');

  const result = await c.env.DB.prepare(
    `SELECT room_id FROM room_aliases WHERE alias = ?`
  ).bind(roomAlias).first<{ room_id: string }>();

  if (!result) {
    return Errors.notFound('Room alias not found').toResponse();
  }

  return c.json({});
});

// GET /_matrix/app/v1/thirdparty/protocol/:protocol - Get third party protocol info
app.get('/_matrix/app/v1/thirdparty/protocol/:protocol', requireAppServiceAuth, async (c) => {
  // Stub - return empty protocol info
  return c.json({
    user_fields: [],
    location_fields: [],
    field_types: {},
    instances: [],
  });
});

// GET /_matrix/app/v1/thirdparty/user/:protocol - Lookup third party users
app.get('/_matrix/app/v1/thirdparty/user/:protocol', requireAppServiceAuth, async (c) => {
  return c.json([]);
});

// GET /_matrix/app/v1/thirdparty/location/:protocol - Lookup third party locations
app.get('/_matrix/app/v1/thirdparty/location/:protocol', requireAppServiceAuth, async (c) => {
  return c.json([]);
});

// POST /_matrix/app/v1/ping - HS → AS liveness probe (Matrix v1.7+).
// Authenticated with the registration's hs_token; answers 200 {} so the
// homeserver can measure the round trip.
app.post('/_matrix/app/v1/ping', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : c.req.query('access_token');
  if (!token) {
    return Errors.missingToken('Missing hs_token').toResponse();
  }
  const as = await getAppServiceByHsToken(c.env.DB, token);
  if (!as) {
    return Errors.forbidden('Invalid hs_token').toResponse();
  }
  return c.json({});
});

// POST /_matrix/client/v1/appservice/:appserviceId/ping - AS → HS request to
// ping its own registration (Matrix v1.7+). The HS probes the AS's
// /_matrix/app/v1/ping with the hs_token and reports the round-trip duration.
app.post('/_matrix/client/v1/appservice/:appserviceId/ping', async (c) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : c.req.query('access_token');
  const as = token ? await getAppServiceByToken(c.env.DB, token) : null;
  if (!as || as.id !== c.req.param('appserviceId')) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: "Provided access token is not the appservice's as_token",
    }, 403);
  }
  if (!as.url) {
    return c.json({
      errcode: 'M_URL_NOT_SET',
      error: "Application service doesn't have a URL configured",
    }, 400);
  }

  let body: { transaction_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const started = Date.now();
  try {
    const res = await fetch(`${as.url}/_matrix/app/v1/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${as.hs_token}`,
      },
      body: JSON.stringify({ transaction_id: body.transaction_id ?? `ping_${started}` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return c.json({
        errcode: 'M_BAD_STATUS',
        error: `Ping returned status ${res.status}`,
        status: res.status,
        body: text,
      }, 502);
    }
    return c.json({ duration_ms: Date.now() - started });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return c.json({
        errcode: 'M_CONNECTION_TIMEOUT',
        error: 'Connection to application service timed out',
      }, 504);
    }
    return c.json({
      errcode: 'M_CONNECTION_FAILED',
      error: 'Connection to application service failed',
    }, 502);
  }
});

export default app;
