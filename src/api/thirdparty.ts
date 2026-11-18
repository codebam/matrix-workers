// Third-party protocol lookup (Matrix v1.17 client-server API).
// https://spec.matrix.org/v1.17/client-server-api/#third-party-networks
//
// This homeserver has no application-service bridges configured, so there
// are no third-party protocols, users, or locations to look up. Per spec,
// every lookup except /thirdparty/protocols answers 404 M_NOT_FOUND when
// the protocol (or the queried user/location) is unknown.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// GET /_matrix/client/v3/thirdparty/protocol/:protocol
app.get('/_matrix/client/v3/thirdparty/protocol/:protocol', requireAuth(), async (c) => {
  return Errors.notFound(`Unknown protocol: ${c.req.param('protocol')}`).toResponse();
});

// GET /_matrix/client/v3/thirdparty/user/:protocol
app.get('/_matrix/client/v3/thirdparty/user/:protocol', requireAuth(), async (c) => {
  return Errors.notFound(`Unknown protocol: ${c.req.param('protocol')}`).toResponse();
});

// GET /_matrix/client/v3/thirdparty/location/:protocol
app.get('/_matrix/client/v3/thirdparty/location/:protocol', requireAuth(), async (c) => {
  return Errors.notFound(`Unknown protocol: ${c.req.param('protocol')}`).toResponse();
});

// GET /_matrix/client/v3/thirdparty/user?userid=@user:server
app.get('/_matrix/client/v3/thirdparty/user', requireAuth(), async (c) => {
  const userId = c.req.query('userid');
  if (!userId) {
    return Errors.missingParam('userid').toResponse();
  }
  return Errors.notFound('No third-party users found for this user ID').toResponse();
});

// GET /_matrix/client/v3/thirdparty/location?alias=#room:server
app.get('/_matrix/client/v3/thirdparty/location', requireAuth(), async (c) => {
  const alias = c.req.query('alias');
  if (!alias) {
    return Errors.missingParam('alias').toResponse();
  }
  return Errors.notFound('No third-party locations found for this alias').toResponse();
});

export default app;