// MSC4583: Minimum power level to send state
// https://github.com/matrix-org/matrix-spec-proposals/pull/4583
//
// This MSC is a room-version change, not a client-server endpoint. It adds a
// `state_minimum` key to m.room.power_levels, tightens the "required power
// level" auth rule for state events, and preserves that key through
// redaction. The unstable room version is dev.zirco.msc4583.v1, based on v12.
//
// This module owns the MSC-specific rules. Registration into the room-version
// registry, the auth-rule call sites, and /capabilities is deliberately left
// to the integrating agent (see the handoff notes in the final report).

import type { RoomVersionBehavior } from '../services/room-versions';

/** Unstable room version assigned by MSC4583 itself. */
export const MSC4583_ROOM_VERSION = 'dev.zirco.msc4583.v1';

/** Value used when state_minimum is absent or the room has no power-levels event. */
export const MSC4583_STATE_MINIMUM_DEFAULT = 50;

/** v12 behaviour with the MSC4583 room version's identity and unstable status. */
export const MSC4583_ROOM_VERSION_BEHAVIOR: RoomVersionBehavior = {
  version: MSC4583_ROOM_VERSION,
  stateResolution: 'v2',
  eventIdFormat: 'v4',
  redactionAlgorithm: 'v11',
  knockingSupported: true,
  restrictedJoinsSupported: true,
  integerPowerLevels: true,
  updatedRedactionRules: true,
  authRuleVariant: 'v10',
  knockRestrictedSupported: true,
  stable: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPowerLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

/** Read state_minimum from power-levels content, falling back to 50. */
export function msc4583StateMinimum(powerLevels: unknown): number {
  if (!isRecord(powerLevels)) return MSC4583_STATE_MINIMUM_DEFAULT;
  const value = powerLevels.state_minimum;
  return isPowerLevel(value) ? value : MSC4583_STATE_MINIMUM_DEFAULT;
}

/**
 * MSC4583's required power level. State events use
 * max(events[type] ?? state_default, state_minimum); non-state events keep
 * the existing events[type] / events_default rules and ignore state_minimum.
 *
 * Membership events and redactions are explicitly out of scope: their
 * required power levels are unchanged by this MSC, so callers must keep using
 * the existing invite/kick/ban/redact rules for those event types.
 */
export function msc4583RequiredPowerLevel(
  powerLevels: unknown,
  eventType: string,
  isStateEvent: boolean
): number {
  const minimum = msc4583StateMinimum(powerLevels);
  const events = isRecord(powerLevels) && isRecord(powerLevels.events) ? powerLevels.events : null;
  const override = events && eventType in events ? events[eventType] : undefined;

  if (isStateEvent) {
    const stateDefault = isRecord(powerLevels) && isPowerLevel(powerLevels.state_default)
      ? powerLevels.state_default
      : 50;
    const base = isPowerLevel(override) ? override : stateDefault;
    return Math.max(base, minimum);
  }

  if (isPowerLevel(override)) return override;
  return isRecord(powerLevels) && isPowerLevel(powerLevels.events_default)
    ? powerLevels.events_default
    : 0;
}

// Kept local (rather than delegating to services/room-versions) so the room
// registry can import this module without forming a runtime import cycle.

const TOP_LEVEL_REDACTION_KEYS = [
  'event_id', 'type', 'room_id', 'sender', 'state_key',
  'hashes', 'signatures', 'depth', 'prev_events', 'auth_events',
  'origin_server_ts',
];

/** Content keys preserved by v12 redaction, with MSC4583's addition. */
export function msc4583RedactionContentKeys(eventType: string): string[] {
  switch (eventType) {
    case 'm.room.power_levels':
      return [
        'ban', 'events', 'events_default', 'invite', 'kick',
        'redact', 'state_default', 'users', 'users_default', 'notifications',
        'state_minimum',
      ];
    case 'm.room.member':
      return ['membership', 'join_authorised_via_users_server', 'third_party_invite'];
    case 'm.room.create':
      return ['creator', 'room_version'];
    case 'm.room.join_rules':
      return ['join_rule', 'allow'];
    case 'm.room.history_visibility':
      return ['history_visibility'];
    case 'm.room.redaction':
      return ['redacts'];
    default:
      return [];
  }
}

/** Redaction keep-list for the MSC4583 room version (v12 plus state_minimum). */
export function msc4583RedactionAllowedKeys(eventType: string): string[] {
  return [...TOP_LEVEL_REDACTION_KEYS, ...msc4583RedactionContentKeys(eventType)];
}

/** Redacted content for the MSC4583 room version. */
export function msc4583ComputeRedactedContent(
  eventType: string,
  content: unknown
): Record<string, unknown> {
  if (!isRecord(content)) return {};
  const redacted: Record<string, unknown> = {};
  for (const key of msc4583RedactionContentKeys(eventType)) {
    if (key in content) redacted[key] = content[key];
  }
  return redacted;
}
