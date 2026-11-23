/**
 * Spec v1.19/v1.20: client-formatted state events carry
 *   - `unsigned.replaces_state` (v1.19), the ID of the state event this one
 *     supersedes, and
 *   - `unsigned.prev_sender` (v1.20), the sender of that previous state
 *     event. Unlike `prev_content`, `prev_sender` is included regardless of
 *     history visibility.
 *
 * Locally-written state events get `replaces_state` at PUT time (see
 * `performStateEvent`); federated-origin state events never do, and nothing
 * stores `prev_sender`, so both are filled at serve time.
 *
 * This helper is applied to every full-event surface of the client API. It
 * forwards `unsigned` that is already present untouched and resolves the
 * predecessor for the served window with ONE batched SQL query — never one
 * query per event.
 */

type ServedEvent = Record<string, any>;

const hasUnsigned = (event: ServedEvent, field: string): boolean =>
  !!event.unsigned &&
  typeof event.unsigned === 'object' &&
  Object.prototype.hasOwnProperty.call(event.unsigned, field);

const isStateEvent = (event: ServedEvent): boolean =>
  !!event &&
  event.state_key !== undefined &&
  event.state_key !== null &&
  typeof event.event_id === 'string';

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

  // Only state events carry these fields. An event whose stored unsigned
  // already has both values needs no lookup; anything else (including a
  // locally-written event that stored `replaces_state` but cannot know
  // `prev_sender` at write time) still needs the batched predecessor query.
  const candidates = events.filter(
    (event) =>
      isStateEvent(event) &&
      (!hasUnsigned(event, 'replaces_state') || !hasUnsigned(event, 'prev_sender'))
  );
  if (candidates.length === 0) return;

  // One query for the whole served window. The IDs ride in a single JSON bind
  // rather than one placeholder per event, so a large /state response cannot
  // hit D1's bind-variable limit. Predecessors are ordered by depth, with the
  // stream ordering as tie-break (NULLs treated as 0 for backfilled rows).
  const servedIds = JSON.stringify([...new Set(candidates.map((e) => e.event_id as string))]);
  let rows: Array<{
    served_event_id: string;
    replaces_state: string | null;
    prev_sender: string | null;
  }>;
  try {
    const result = await db.prepare(`
      WITH served AS (
        SELECT event_id, room_id, event_type, state_key, depth, stream_ordering
        FROM events
        WHERE event_id IN (SELECT value FROM json_each(?))
      )
      SELECT served.event_id AS served_event_id,
             prev.event_id AS replaces_state,
             prev.sender AS prev_sender
      FROM served
      LEFT JOIN events prev ON prev.event_id = (
        SELECT p.event_id
        FROM events p
        WHERE p.room_id = served.room_id
          AND p.event_type = served.event_type
          AND p.state_key = served.state_key
          AND (
            p.depth < served.depth
            OR (p.depth = served.depth
                AND COALESCE(p.stream_ordering, 0) < COALESCE(served.stream_ordering, 0))
          )
        ORDER BY p.depth DESC, COALESCE(p.stream_ordering, 0) DESC
        LIMIT 1
      )
    `).bind(servedIds).all<{
      served_event_id: string;
      replaces_state: string | null;
      prev_sender: string | null;
    }>();
    rows = result.results ?? [];
  } catch (err) {
    // Enrichment is best-effort: never fail a read because an optional
    // predecessor lookup could not be answered.
    console.warn('[replaces-state] predecessor lookup failed:', err);
    return;
  }

  const predecessorById = new Map(rows.map((row) => [row.served_event_id, row]));
  if (predecessorById.size === 0) return;

  for (const event of candidates) {
    const predecessor = predecessorById.get(event.event_id as string);
    if (!predecessor) continue; // first event for this (type, state_key): omit the fields

    const patch: Record<string, string> = {};
    if (!hasUnsigned(event, 'replaces_state') && predecessor.replaces_state) {
      patch.replaces_state = predecessor.replaces_state;
    }
    // Spec v1.20: `prev_sender` is the sender of the replaced state event,
    // independent of history visibility (so it is not gated on prev_content).
    if (!hasUnsigned(event, 'prev_sender') && predecessor.prev_sender) {
      patch.prev_sender = predecessor.prev_sender;
    }
    if (Object.keys(patch).length === 0) continue;
    event.unsigned = { ...(event.unsigned ?? {}), ...patch };
  }
}
