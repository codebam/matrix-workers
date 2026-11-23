// MSC4140 delayed events: durable scheduling and dispatch.
// Rows live in D1; a singleton DelayedEventsDurableObject alarm dispatches
// due events through the same performSendEvent/performStateEvent cores as
// immediate sends, so signing, federation and sync wake-ups all apply.

import type { Env } from '../types';
import { Errors, MatrixApiError } from '../utils/errors';
import { generateOpaqueId } from '../utils/ids';
import { getMembership } from './database';
import { performSendEvent, performStateEvent } from '../api/rooms';

export const MAX_DELAY_MS = 86_400_000; // 24 hours
export const MAX_SCHEDULED = 10;

export interface DelayedEventRow {
  delay_id: string;
  user_id: string;
  room_id: string;
  event_type: string;
  state_key: string | null;
  content: string;
  delay_ms: number;
  delayed_since_ts: number;
  due_ts: number;
  txn_id: string | null;
  sticky_duration_ms: number | null;
  finalised_ts: number | null;
  final_event_id: string | null;
  final_error: string | null;
}

type Result<T> = (T & { error?: never }) | { error: MatrixApiError };

async function scheduleAlarm(env: Env, dueTs: number): Promise<void> {
  const stub = env.DELAYED_EVENTS.get(env.DELAYED_EVENTS.idFromName('global'));
  await stub.fetch(new Request('http://internal/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ due_ts: dueTs }),
  }));
}

export async function createDelayedEvent(
  env: Env,
  userId: string,
  roomId: string,
  eventType: string,
  content: unknown,
  delayMs: unknown,
  stateKey?: string,
  txnId?: string,
  stickyDurationMs?: unknown
): Promise<Result<{ delayId: string }>> {
  if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs <= 0) {
    return { error: Errors.invalidParam('delay_ms', 'delay_ms must be a positive integer') };
  }
  if (delayMs > MAX_DELAY_MS) {
    return { error: Errors.delayTooLarge() };
  }
  if (typeof content !== 'object' || content === null) {
    return { error: Errors.missingParam('content') };
  }
  // Spec v1.20: a delayed event may ask for its eventual send to be sticky.
  if (
    stickyDurationMs !== undefined &&
    (typeof stickyDurationMs !== 'number' ||
      !Number.isSafeInteger(stickyDurationMs) ||
      stickyDurationMs <= 0)
  ) {
    return {
      error: Errors.invalidParam(
        'sticky_duration_ms',
        'sticky_duration_ms must be a strictly positive integer'
      ),
    };
  }

  const membership = await getMembership(env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return { error: Errors.forbidden('Not a member of this room') };
  }

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM delayed_events WHERE user_id = ? AND finalised_ts IS NULL`
  ).bind(userId).first<{ count: number }>();
  if ((pending?.count ?? 0) >= MAX_SCHEDULED) {
    return { error: Errors.limitExceeded('The maximum number of delayed events has been reached.', 1_200_000) };
  }

  const now = Date.now();
  const delayId = await generateOpaqueId(18);
  await env.DB.prepare(
    `INSERT INTO delayed_events
       (delay_id, user_id, room_id, event_type, state_key, content, delay_ms, delayed_since_ts, due_ts, txn_id, sticky_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    delayId, userId, roomId, eventType, stateKey ?? null,
    JSON.stringify(content), delayMs, now, now + delayMs, txnId ?? null,
    typeof stickyDurationMs === 'number' ? stickyDurationMs : null
  ).run();

  await scheduleAlarm(env, now + delayMs);
  return { delayId };
}

export async function getDelayedEvent(
  env: Env,
  userId: string,
  delayId: string
): Promise<DelayedEventRow | null> {
  return env.DB.prepare(
    `SELECT * FROM delayed_events WHERE delay_id = ? AND user_id = ?`
  ).bind(delayId, userId).first<DelayedEventRow>();
}

export function delayedEventJson(row: DelayedEventRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    delay_id: row.delay_id,
    room_id: row.room_id,
    type: row.event_type,
    delay_ms: row.delay_ms,
    delayed_since_ts: row.delayed_since_ts,
    content: JSON.parse(row.content),
  };
  if (row.state_key !== null) body.state_key = row.state_key;
  if (row.finalised_ts !== null) {
    const finalised: Record<string, unknown> = { finalised_ts: row.finalised_ts };
    if (row.final_event_id) finalised.event_id = row.final_event_id;
    if (row.final_error) finalised.error = JSON.parse(row.final_error);
    body.finalised = finalised;
  }
  return body;
}

async function dispatchRow(env: Env, row: DelayedEventRow): Promise<MatrixApiError | null> {
  const content = JSON.parse(row.content);
  // Spec v1.20: the resulting event SHOULD NOT carry the transaction ID used
  // to schedule it (the delayed event is identified by delay_id instead), so
  // the send core is called without a txnId. The delay_id itself is attached
  // per-viewer at serve time from this row's final_event_id.
  const sticky = row.sticky_duration_ms ?? undefined;
  const result = row.state_key !== null
    ? await performStateEvent(env, row.room_id, row.user_id, row.event_type, row.state_key, content, sticky)
    : await performSendEvent(env, row.room_id, row.user_id, row.event_type, content, undefined, sticky);
  if ('error' in result) {
    await env.DB.prepare(
      `UPDATE delayed_events SET final_error = ? WHERE delay_id = ?`
    ).bind(JSON.stringify(result.error.toJSON()), row.delay_id).run();
    return result.error;
  }
  await env.DB.prepare(
    `UPDATE delayed_events SET final_event_id = ? WHERE delay_id = ?`
  ).bind(result.eventId, row.delay_id).run();
  return null;
}

// Idempotency for actions on an already-finalised event: repeating the
// action that finalised it succeeds; anything else is a 409 conflict.
function finalisedOutcome(row: DelayedEventRow, action: string): MatrixApiError | null {
  if (action === 'send' && row.final_event_id) return null;
  if (action === 'cancel' && !row.final_event_id && !row.final_error) return null;
  return Errors.conflict('Delayed event is already finalised');
}

export async function manageDelayedEvent(
  env: Env,
  userId: string,
  delayId: string,
  action: 'send' | 'cancel' | 'restart' | 'update',
  opts: { delayMs?: unknown; content?: unknown } = {}
): Promise<Result<Record<string, never>>> {
  const row = await getDelayedEvent(env, userId, delayId);
  if (!row) return { error: Errors.notFound('Unknown delayed event') };

  if (row.finalised_ts !== null) {
    const outcome = finalisedOutcome(row, action);
    if (outcome) return { error: outcome };
    return {};
  }

  const now = Date.now();

  if (action === 'restart' || action === 'update') {
    let delayMs = row.delay_ms;
    let content = row.content;
    if (action === 'update') {
      if (opts.delayMs !== undefined) {
        if (typeof opts.delayMs !== 'number' || !Number.isInteger(opts.delayMs) || opts.delayMs <= 0) {
          return { error: Errors.invalidParam('delay_ms', 'delay_ms must be a positive integer') };
        }
        if (opts.delayMs > MAX_DELAY_MS) return { error: Errors.delayTooLarge() };
        delayMs = opts.delayMs;
      }
      if (opts.content !== undefined) {
        if (typeof opts.content !== 'object' || opts.content === null) {
          return { error: Errors.invalidParam('content', 'content must be an object') };
        }
        content = JSON.stringify(opts.content);
      }
    }
    const updated = await env.DB.prepare(
      `UPDATE delayed_events SET delay_ms = ?, content = ?, delayed_since_ts = ?, due_ts = ?
       WHERE delay_id = ? AND finalised_ts IS NULL`
    ).bind(delayMs, content, now, now + delayMs, delayId).run();
    if (!updated.meta.changes) return { error: Errors.conflict('Delayed event is already finalised') };
    await scheduleAlarm(env, now + delayMs);
    return {};
  }

  // send / cancel: claim the row by finalising it, then act.
  const claimed = await env.DB.prepare(
    `UPDATE delayed_events SET finalised_ts = ? WHERE delay_id = ? AND finalised_ts IS NULL`
  ).bind(now, delayId).run();
  if (!claimed.meta.changes) return { error: Errors.conflict('Delayed event is already finalised') };

  if (action === 'cancel') return {};

  const dispatchError = await dispatchRow(env, row);
  if (dispatchError) return { error: dispatchError };
  return {};
}

// Called by the DelayedEventsDurableObject alarm. Returns the next due
// timestamp (or null when nothing is pending) so the alarm can re-arm.
export async function dispatchDueDelayedEvents(env: Env): Promise<number | null> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT * FROM delayed_events WHERE finalised_ts IS NULL AND due_ts <= ? ORDER BY due_ts LIMIT 25`
  ).bind(now).all<DelayedEventRow>();

  for (const row of due.results) {
    const claimed = await env.DB.prepare(
      `UPDATE delayed_events SET finalised_ts = ? WHERE delay_id = ? AND finalised_ts IS NULL`
    ).bind(now, row.delay_id).run();
    if (!claimed.meta.changes) continue;
    await dispatchRow(env, row);
  }

  const next = await env.DB.prepare(
    `SELECT MIN(due_ts) as next FROM delayed_events WHERE finalised_ts IS NULL`
  ).first<{ next: number | null }>();
  return next?.next ?? null;
}