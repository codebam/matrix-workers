// MSC4140 delayed events (unstable org.matrix.msc4140 endpoints).
// Create via PUT .../rooms/:roomId/delayed_event/:eventType/:txnId with
// {delay_ms, content, state_key?}; inspect via GET .../delayed_events/:id;
// manage via POST .../delayed_events/:id/{send,cancel,restart} or the
// body-based PUT .../delayed_events/:id {action} form (which also supports
// update).

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import {
  createDelayedEvent,
  getDelayedEvent,
  manageDelayedEvent,
  delayedEventJson,
} from '../services/delayed-events';

const app = new Hono<AppEnv>();

const P = '/_matrix/client/unstable/org.matrix.msc4140';

app.put(`${P}/rooms/:roomId/delayed_event/:eventType/:txnId`, requireAuth(), async (c) => {
  const userId = c.get('userId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const result = await createDelayedEvent(
    c.env,
    userId,
    c.req.param('roomId'),
    c.req.param('eventType'),
    body?.content,
    body?.delay_ms,
    typeof body?.state_key === 'string' ? body.state_key : undefined,
    c.req.param('txnId')
  );
  if (result.error) return result.error.toResponse();

  return c.json({ delay_id: result.delayId });
});

app.get(`${P}/delayed_events/:delayId`, requireAuth(), async (c) => {
  const row = await getDelayedEvent(c.env, c.get('userId'), c.req.param('delayId'));
  if (!row) return Errors.notFound('Unknown delayed event').toResponse();
  return c.json(delayedEventJson(row));
});

app.post(`${P}/delayed_events/:delayId/:action`, requireAuth(), async (c) => {
  const action = c.req.param('action');
  if (action !== 'send' && action !== 'cancel' && action !== 'restart') {
    return Errors.unrecognized(`Unknown delayed event action: ${action}`).toResponse();
  }
  const result = await manageDelayedEvent(c.env, c.get('userId'), c.req.param('delayId'), action);
  if (result.error) return result.error.toResponse();
  return c.json({});
});

app.put(`${P}/delayed_events/:delayId`, requireAuth(), async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const action = body?.action;
  if (action !== 'send' && action !== 'cancel' && action !== 'restart' && action !== 'update') {
    return Errors.invalidParam('action', 'action must be send, cancel, restart or update').toResponse();
  }

  const result = await manageDelayedEvent(c.env, c.get('userId'), c.req.param('delayId'), action, {
    delayMs: body?.delay_ms,
    content: body?.content,
  });
  if (result.error) return result.error.toResponse();
  return c.json({});
});

export default app;