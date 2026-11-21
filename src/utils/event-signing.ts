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

// Top-level keys retained by the redaction algorithm (v11+ rules; the
// keep list drops `origin`/`prev_state` from this version on). Everything
// else is stripped. `event_id` is retained here for completeness of the
// redaction algorithm, though v4+ wire events do not carry it.
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

// Room versions 1-10 additionally retain `origin` and `prev_state` (spec:
// "the server must strip off any keys not in the following list: ... depth,
// prev_events, prev_state, auth_events, origin, origin_server_ts").
// Pre-2023 Synapse events carry both, and the reference hash covers the
// redacted event — dropping them derives PHANTOM IDs no resident resolves.
// Live case: the GNU/Linux room's create (v9, 2022 halogen.city) hashes to
// its real ID only with `origin`+`prev_state` kept.
const REDACTION_KEEP_TOP_LEVEL_LEGACY = [
  ...REDACTION_KEEP_TOP_LEVEL,
  'origin',
  'prev_state',
];

// Per-event-type content keys retained by the redaction algorithm (v11+
// rules). Types not listed here have their content stripped entirely.
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

// Room versions 1-10 redact differently from 11+: m.room.create keeps only
// `creator` (11+ adds `room_version`), and m.room.power_levels does not keep
// `invite`. Signing a v10 event with v11 rules produces a reference hash and
// signature the receiving server rejects.
const REDACTION_KEEP_CONTENT_V10: Record<string, string[]> = {
  ...REDACTION_KEEP_CONTENT,
  'm.room.create': ['creator'],
  'm.room.power_levels': REDACTION_KEEP_CONTENT['m.room.power_levels'].filter((k) => k !== 'invite'),
};

// m.room.create keeps its full content at v11+ (creator + room_version).
const CONTENT_KEEP_ALL_V11 = new Set(['m.room.create']);

function isLegacyRedaction(roomVersion: string | undefined): boolean {
  const num = parseInt(roomVersion ?? '', 10);
  // Only room versions 1 and 2 use the legacy redaction keep-list (with
  // `origin` and `prev_state`). From v3 onwards those fields are stripped;
  // keeping them breaks signatures from modern Synapse on v3-v10 rooms.
  // Pre-2023 events that still use the old shape are handled by the
  // legacy-form fallback in federation-verify.ts.
  return Number.isFinite(num) && num <= 2;
}

/**
 * Apply the Matrix redaction algorithm to an event object, using the rules
 * of the given room version (defaults to v11+ rules).
 *
 * Returns a new object; the input is not modified.
 */
export function redactEventForSigning(
  event: Record<string, unknown>,
  roomVersion?: string
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  const keepTopLevel = isLegacyRedaction(roomVersion)
    ? REDACTION_KEEP_TOP_LEVEL_LEGACY
    : REDACTION_KEEP_TOP_LEVEL;
  for (const key of keepTopLevel) {
    if (key in event) {
      redacted[key] = event[key];
    }
  }

  const type = typeof event.type === 'string' ? event.type : '';
  const legacy = isLegacyRedaction(roomVersion);

  if (!legacy && CONTENT_KEEP_ALL_V11.has(type)) {
    // Full content retained.
    return redacted;
  }

  const content =
    event.content && typeof event.content === 'object'
      ? (event.content as Record<string, unknown>)
      : {};
  const kept: Record<string, unknown> = {};

  const keepList = legacy ? REDACTION_KEEP_CONTENT_V10 : REDACTION_KEEP_CONTENT;
  for (const key of keepList[type] ?? []) {
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
export function eventSigningCanonicalJson(
  event: Record<string, unknown>,
  roomVersion?: string
): string {
  const redacted = redactEventForSigning(event, roomVersion);
  delete redacted['signatures'];
  delete redacted['unsigned'];
  return canonicalJson(redacted);
}

/**
 * Reference hash of an event: SHA-256 (URL-safe unpadded base64) of the
 * signing canonical JSON.
 */
export async function computeEventReferenceHash(
  event: Record<string, unknown>,
  roomVersion?: string
): Promise<string> {
  return sha256(eventSigningCanonicalJson(event, roomVersion));
}

/**
 * Derive the event ID for an event in a v4+ room version: `$` followed by
 * the reference hash.
 */
export async function computeWireEventId(
  event: Record<string, unknown>,
  roomVersion?: string
): Promise<string> {
  return `$${await computeEventReferenceHash(event, roomVersion)}`;
}

/**
 * Candidate wire IDs for an event RECEIVED from a resident server.
 *
 * Outbound IDs always use the room version's rules (computeWireEventId).
 * Inbound, a pre-2023 Synapse event in a v3-v10 room may carry `origin` /
 * `prev_state`; its real ID was derived with the legacy keep-list, which
 * retained those fields. Re-deriving it with modern rules produces a phantom
 * ID no resident resolves. Return the legacy form first when those fields are
 * present, with the modern form as a fallback for already-stored rows.
 */
export async function inboundWireEventIdCandidates(
  event: Record<string, unknown>,
  roomVersion?: string
): Promise<string[]> {
  const modern = await computeWireEventId(event, roomVersion);
  const num = parseInt(roomVersion ?? '', 10);
  const legacyForm = Number.isFinite(num) && num >= 3 && num <= 10 &&
    ('origin' in event || 'prev_state' in event);
  if (!legacyForm) return [modern];
  const legacy = await computeWireEventId(event, '2');
  return legacy === modern ? [modern] : [legacy, modern];
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
