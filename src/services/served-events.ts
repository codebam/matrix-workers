// Client-facing enrichment of served events, applied to every full-event
// surface (sync, messages, context, event, state).
//
// Kept in one place so viewer-dependent fields are added consistently:
//   - `unsigned.replaces_state` (spec v1.19) and, later, `prev_sender`
//   - `unsigned.delay_id` (spec v1.20, MSC4140): the event produced by a
//     delayed send names the delayed event that scheduled it, but *only* to
//     the client authenticated as the event's sender.
//
// The delay-id lookup is one batched query against `delayed_events` and only
// runs when the viewer has candidate events in the served window.

import { attachReplacesState } from './replaces-state';

type ServedEvent = Record<string, any>;

/** Spec v1.20 (MSC4354): stickiness is capped at one hour. */
const MAX_STICKY_DURATION_MS = 3_600_000;

export interface ServedEventOptions {
  /** Authenticated user for viewer-dependent unsigned fields. */
  viewer?: string | null;
}

/**
 * Spec v1.20 (MSC4140): attach `unsigned.delay_id` to events produced by a
 * delayed send, for the sender only. The linkage is the
 * `delayed_events.final_event_id` column written when the delayed event
 * fired, so nothing about the schedule is stored on the event itself.
 */
export async function attachDelayIds(
  db: D1Database,
  events: readonly ServedEvent[],
  viewerUserId?: string | null
): Promise<void> {
  if (!viewerUserId || events.length === 0) return;

  const candidates = events.filter(
    (event) =>
      !!event &&
      event.sender === viewerUserId &&
      typeof event.event_id === 'string' &&
      event.event_id.startsWith('$')
  );
  if (candidates.length === 0) return;

  const eventIds = JSON.stringify([...new Set(candidates.map((event) => event.event_id))]);
  try {
    const result = await db.prepare(
      `SELECT final_event_id, delay_id FROM delayed_events
       WHERE user_id = ?
         AND final_event_id IN (SELECT value FROM json_each(?))`
    ).bind(viewerUserId, eventIds).all<{ final_event_id: string; delay_id: string }>();

    const delayIdByEvent = new Map(
      (result.results ?? []).map((row) => [row.final_event_id, row.delay_id])
    );
    for (const event of candidates) {
      const delayId = delayIdByEvent.get(event.event_id);
      if (!delayId) continue;
      event.unsigned = { ...(event.unsigned ?? {}), delay_id: delayId };
    }
  } catch (error) {
    // Serving must never fail because the optional enrichment lookup did.
    console.warn('[served-events] delay id lookup failed:', error);
  }
}


/**
 * Spec v1.20 (MSC4354): expose sticky events to clients.
 *
 * The authoritative `sticky` object is stored with the event (it is part of
 * the federation wire form and content hash, so it cannot be derived from the
 * client view). For every served event carrying one:
 *   - the top-level `sticky` object is copied to the client event, and
 *   - while unexpired, `unsigned.sticky_duration_remaining_ms` is set using
 *     `start = min(received_ts, origin_server_ts)` and a one-hour cap.
 *
 * Redaction does not protect `sticky`, so redacted events are served without
 * it (the stored column stays for federation hash verification).
 */
export async function attachStickyMetadata(
  db: D1Database,
  events: readonly ServedEvent[],
  now: number = Date.now()
): Promise<void> {
  const candidates = events.filter(
    (event) => !!event && typeof event.event_id === 'string' && event.event_id.startsWith('$')
  );
  if (candidates.length === 0) return;

  const eventIds = JSON.stringify([...new Set(candidates.map((event) => event.event_id))]);
  let rows: Array<{
    event_id: string;
    sticky: string | null;
    received_ts: number | null;
    origin_server_ts: number;
  }>;
  try {
    const result = await db.prepare(
      `SELECT event_id, sticky, received_ts, origin_server_ts FROM events
       WHERE event_id IN (SELECT value FROM json_each(?))`
    ).bind(eventIds).all<{
      event_id: string;
      sticky: string | null;
      received_ts: number | null;
      origin_server_ts: number;
    }>();
    rows = result.results ?? [];
  } catch (error) {
    console.warn('[served-events] sticky lookup failed:', error);
    return;
  }

  const byEventId = new Map(rows.map((row) => [row.event_id, row]));
  for (const event of candidates) {
    const row = byEventId.get(event.event_id);
    if (!row?.sticky) continue;

    let sticky: { duration_ms?: unknown };
    try {
      sticky = JSON.parse(row.sticky) as { duration_ms?: unknown };
    } catch {
      continue;
    }
    if (!sticky || typeof sticky.duration_ms !== 'number' || !Number.isFinite(sticky.duration_ms)) {
      continue;
    }
    // Redaction strips stickiness from the client view.
    if (event.unsigned && event.unsigned.redacted_because) continue;

    const durationMs = Math.min(Math.max(sticky.duration_ms, 0), MAX_STICKY_DURATION_MS);
    event.sticky = { duration_ms: sticky.duration_ms };
    if (durationMs <= 0) continue;

    const originServerTs = row.origin_server_ts ?? event.origin_server_ts;
    const start = Math.min(row.received_ts ?? originServerTs, originServerTs);
    const remaining = start + durationMs - now;
    if (remaining > 0) {
      event.unsigned = { ...(event.unsigned ?? {}), sticky_duration_remaining_ms: remaining };
    }
  }
}

/**
 * Apply all served-event enrichment to `events` (mutated in place, matching
 * `attachReplacesState`'s contract so shared object references between two
 * sections of one response are updated once).
 */
export async function attachServedEventMetadata(
  db: D1Database,
  events: readonly ServedEvent[],
  options: ServedEventOptions = {}
): Promise<void> {
  if (!events || events.length === 0) return;
  await attachReplacesState(db, events);
  await attachDelayIds(db, events, options.viewer ?? null);
  await attachStickyMetadata(db, events);
}
