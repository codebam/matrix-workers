/**
 * Spec v1.19: client-formatted state events carry `unsigned.replaces_state`,
 * the ID of the state event this one supersedes. Locally-written state events
 * get the value at PUT time (see `performStateEvent`); federated-origin state
 * events never do, so they need it filled at serve time.
 *
 * This helper is applied to every full-event surface of the client API. It
 * forwards `unsigned` that is already present untouched (including a
 * `replaces_state` computed at write time) and, for the remaining state
 * events in the served window, resolves their predecessor with ONE batched
 * SQL query — never one query per event.
 */

type ServedEvent = Record<string, any>;

const hasReplacesState = (event: ServedEvent): boolean =>
  !!event.unsigned &&
  typeof event.unsigned === 'object' &&
  Object.prototype.hasOwnProperty.call(event.unsigned, 'replaces_state');

/**
 * Mutates the supplied client-formatted events in place so callers can pass
 * the same objects that go into a response (and so shared object references
 * between two sections of one response are updated once).
 */
export async function attachReplacesState(
  db: D1Database,
  events: readonly ServedEvent[]
): Promise<void> {
  if (!events || events.length === 0) return;

  // A state event is identified by a non-null state_key. Ones that already
  // carry replaces_state are left alone: their stored `unsigned` is already
  // the authoritative value (and needs no lookup).
  const candidates = events.filter(
    (event) =>
      !!event &&
      event.state_key !== undefined &&
      event.state_key !== null &&
      typeof event.event_id === 'string' &&
      !hasReplacesState(event)
  );
  if (candidates.length === 0) return;

  // One query for the whole served window. The IDs ride in a single JSON bind
  // rather than one placeholder per event, so a large /state response cannot
  // hit D1's bind-variable limit. Predecessors are ordered by depth, with the
  // stream ordering as tie-break (NULLs treated as 0 for backfilled rows).
  const servedIds = JSON.stringify([...new Set(candidates.map((e) => e.event_id as string))]);
  let rows: Array<{ served_event_id: string; replaces_state: string | null }>;
  try {
    const result = await db.prepare(`
      WITH served AS (
        SELECT event_id, room_id, event_type, state_key, depth, stream_ordering
        FROM events
        WHERE event_id IN (SELECT value FROM json_each(?))
      )
      SELECT served.event_id AS served_event_id,
             (
               SELECT prev.event_id
               FROM events prev
               WHERE prev.room_id = served.room_id
                 AND prev.event_type = served.event_type
                 AND prev.state_key = served.state_key
                 AND (
                   prev.depth < served.depth
                   OR (prev.depth = served.depth
                       AND COALESCE(prev.stream_ordering, 0) < COALESCE(served.stream_ordering, 0))
                 )
               ORDER BY prev.depth DESC, COALESCE(prev.stream_ordering, 0) DESC
               LIMIT 1
             ) AS replaces_state
      FROM served
    `).bind(servedIds).all<{ served_event_id: string; replaces_state: string | null }>();
    rows = result.results ?? [];
  } catch (err) {
    // Enrichment is best-effort: never fail a read because an optional
    // predecessor lookup could not be answered.
    console.warn('[replaces-state] predecessor lookup failed:', err);
    return;
  }

  const predecessors = new Map<string, string>();
  for (const row of rows) {
    if (row.replaces_state) predecessors.set(row.served_event_id, row.replaces_state);
  }
  if (predecessors.size === 0) return;

  for (const event of candidates) {
    const predecessor = predecessors.get(event.event_id as string);
    if (!predecessor) continue; // first event for this (type, state_key): omit the field
    event.unsigned = { ...(event.unsigned ?? {}), replaces_state: predecessor };
  }
}
