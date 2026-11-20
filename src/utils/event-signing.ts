// Event signing and wire-format helpers for modern (v4+ event format) room
// versions, which current versions 11 and 12 use.
//
// Key semantics of the v4+ event format:
//   * Events on the wire do NOT carry an `event_id`: the receiving server
//     derives it as the *reference hash* of the event (URL-safe unpadded
//     base64, prefixed with `$`).
//   * Signatures cover the *redacted* form of the event (plus `hashes`),
//     not the full event. This lets a redacted copy be signature-verified.
//
// The reference hash and the signature input are the same canonical JSON:
// the redacted event with `signatures` and `unsigned` removed (the `hashes`
// field is kept — it is covered by both).

import { canonicalJson, sha256 } from './crypto';

// Top-level keys retained by the redaction algorithm (v11 rules, unchanged
// through v12). Everything else is stripped. `event_id` is retained here for
// completeness of the redaction algorithm, though v4+ wire events do not
// carry it.
const REDACTION_KEEP_TOP_LEVEL = [
  'event_id',
  'type',
  'room_id',
  'sender',
  'state_key',
  'content',
  'hashes',
  'signatures',
  'depth',
  'prev_events',
  'auth_events',
  'origin_server_ts',
];

// Per-event-type content keys retained by the redaction algorithm. Types not
// listed here have their content stripped entirely.
const REDACTION_KEEP_CONTENT: Record<string, string[]> = {
  'm.room.member': ['membership', 'join_authorised_via_users_server'],
  'm.room.join_rules': ['join_rule', 'allow'],
  'm.room.power_levels': [
    'ban',
    'events',
    'events_default',
    'invite',
    'kick',
    'redact',
    'state_default',
    'users',
    'users_default',
  ],
  'm.room.history_visibility': ['history_visibility'],
  'm.room.redaction': ['redacts'],
};

// m.room.create keeps its full content.
const CONTENT_KEEP_ALL = new Set(['m.room.create']);

/**
 * Apply the Matrix redaction algorithm (v11 rules) to an event object.
 *
 * Returns a new object; the input is not modified.
 */
export function redactEventForSigning(event: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const key of REDACTION_KEEP_TOP_LEVEL) {
    if (key in event) {
      redacted[key] = event[key];
    }
  }

  const type = typeof event.type === 'string' ? event.type : '';

  if (CONTENT_KEEP_ALL.has(type)) {
    // Full content retained.
    return redacted;
  }

  const content =
    event.content && typeof event.content === 'object'
      ? (event.content as Record<string, unknown>)
      : {};
  const kept: Record<string, unknown> = {};

  for (const key of REDACTION_KEEP_CONTENT[type] ?? []) {
    if (key in content) {
      kept[key] = content[key];
    }
  }

  // m.room.member additionally retains the `signed` key of any
  // `third_party_invite`.
  if (type === 'm.room.member' && content.third_party_invite) {
    const invite = content.third_party_invite as Record<string, unknown>;
    if ('signed' in invite) {
      kept.third_party_invite = { signed: invite.signed };
    }
  }

  redacted.content = kept;
  return redacted;
}

/**
 * Canonical JSON of the event as used for both the reference hash and event
 * signatures: the redacted event with `signatures` and `unsigned` removed.
 */
export function eventSigningCanonicalJson(event: Record<string, unknown>): string {
  const redacted = redactEventForSigning(event);
  delete redacted['signatures'];
  delete redacted['unsigned'];
  return canonicalJson(redacted);
}

/**
 * Reference hash of an event: SHA-256 (URL-safe unpadded base64) of the
 * signing canonical JSON.
 */
export async function computeEventReferenceHash(event: Record<string, unknown>): Promise<string> {
  return sha256(eventSigningCanonicalJson(event));
}

/**
 * Derive the event ID for an event in a v4+ room version: `$` followed by
 * the reference hash.
 */
export async function computeWireEventId(event: Record<string, unknown>): Promise<string> {
  return `$${await computeEventReferenceHash(event)}`;
}

/**
 * Strip local-only fields from an event before it goes on the wire. v4+
 * events must not include `event_id` — the resident server rejects PDUs
 * that carry one ("Invalid event JSON").
 */
export function toWireEventObject(event: Record<string, unknown>): Record<string, unknown> {
  const wire = { ...event };
  delete wire['event_id'];
  return wire;
}

/**
 * Room versions 1-2 carry an explicit `event_id` on the wire; from room
 * version 3 onwards the receiver derives the ID from the reference hash and
 * rejects PDUs that carry one (Synapse: "v2/v3 events must not have an
 * explicit event_id"). Stored events keep their ID locally, so every
 * federation serialization must drop it for modern room versions.
 */
export function omitWireEventId<T extends object>(
  pdu: T,
  roomVersion: string | undefined
): T {
  const num = parseInt(roomVersion ?? '', 10);
  if (roomVersion === '1' || roomVersion === '2' || (Number.isFinite(num) && num <= 2)) {
    return pdu;
  }
  const wire = { ...pdu } as Record<string, unknown>;
  delete wire['event_id'];
  return wire as T;
}

/**
 * True when the room version uses MSC4291 "room IDs as hashes" plus the
 * event_id-less wire format: the create event's ID is derived from its
 * reference hash ("$" + refhash), the room ID is "!" + refhash + ":" + server,
 * the create event carries no room_id, and auth_events never list the create.
 * This is room version 12 (and the unstable org.matrix.hydra.11). Plain
 * version 11 uses the ordinary v4 format (explicit event IDs) — only its
 * create's `creator` field became implicit.
 */
export function isMsc4291RoomVersion(roomVersion: string): boolean {
  if (roomVersion === 'org.matrix.hydra.11') return true;
  const num = parseInt(roomVersion, 10);
  return Number.isFinite(num) && num >= 12;
}

/** MSC4291: the create event's ID is "$" + its reference hash. */
export function msc4291CreateEventId(refHash: string): string {
  return `$${refHash}`;
}

/**
 * MSC4291: the room ID is "!" + the create event's reference hash.
 * The room ID carries NO server suffix: Synapse derives the implicit create
 * reference as "$" + room_id[1:], which must equal the create's event ID
 * ("$" + refhash) for its auth checks to resolve it. A domain suffix breaks
 * that identity and every join into the room 500s on the receiver.
 */
export function msc4291RoomId(refHash: string): string {
  return `!${refHash}`;
}
