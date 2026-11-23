// MSC4140 delayed events.
//
// Spec v1.20 stabilized this module: the scheduling endpoint moved to
// `/_matrix/client/v3/rooms/{roomId}/delayed_event/...` and the management
// endpoints to `/_matrix/client/v1/delayed_events/...`. The original
// `org.matrix.msc4140` unstable prefix is still served for older clients
// (and for the non-spec body-based PUT form, which never stabilized).
//
// Create:  PUT  .../rooms/:roomId/delayed_event/:eventType/:txnId
//          body {delay_ms, content, state_key?} (plus sticky_duration_ms, v1.20)
// Inspect: GET  .../delayed_events/:id
// Manage:  POST .../delayed_events/:id/{send,cancel,restart}
// Legacy:  PUT  .../delayed_events/:id  body {action}

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

// Spec v1.20 (stable) and the original MSC namespace.
const STABLE_PREFIX = '/_matrix/client/v1';
const UNSTABLE_PREFIX = '/_matrix/client/unstable/org.matrix.msc4140';

async function handleCreate(c: any): Promise<Response> {
  const userId = c.get('userId') as string;

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
    c.req.param('txnId'),
    body?.sticky_duration_ms
  );
  if (result.error) return result.error.toResponse();

  return c.json({ delay_id: result.delayId });
}

async function handleGet(c: any): Promise<Response> {
  const row = await getDelayedEvent(c.env, c.get('userId'), c.req.param('delayId'));
  if (!row) return Errors.notFound('Unknown delayed event').toResponse();
  return c.json(delayedEventJson(row));
}

async function handleAction(c: any): Promise<Response> {
  const action = c.req.param('action');
  if (action !== 'send' && action !== 'cancel' && action !== 'restart') {
    return Errors.unrecognized(`Unknown delayed event action: ${action}`).toResponse();
  }
  const result = await manageDelayedEvent(c.env, c.get('userId'), c.req.param('delayId'), action);
  if (result.error) return result.error.toResponse();
  return c.json({});
}

// Non-spec convenience form kept from the unstable implementation.
async function handleBodyAction(c: any): Promise<Response> {
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
}

// Scheduling: spec path (v3) plus the unstable alias.
app.put('/_matrix/client/v3/rooms/:roomId/delayed_event/:eventType/:txnId', requireAuth(), handleCreate);
app.put(`${UNSTABLE_PREFIX}/rooms/:roomId/delayed_event/:eventType/:txnId`, requireAuth(), handleCreate);

// Inspection and management: spec path (v1) plus the unstable alias.
app.get(`${STABLE_PREFIX}/delayed_events/:delayId`, requireAuth(), handleGet);
app.get(`${UNSTABLE_PREFIX}/delayed_events/:delayId`, requireAuth(), handleGet);

app.post(`${STABLE_PREFIX}/delayed_events/:delayId/:action`, requireAuth(), handleAction);
app.post(`${UNSTABLE_PREFIX}/delayed_events/:delayId/:action`, requireAuth(), handleAction);

// Legacy body-based management stays unstable-only.
app.put(`${UNSTABLE_PREFIX}/delayed_events/:delayId`, requireAuth(), handleBodyAction);

export default app;
