/**
 * Room-version-aware wire-ID derivation contract.
 *
 * Reference hashes — and therefore the event IDs every federation peer uses —
 * are computed over the room version's redaction rules. Versions 1-10 redact
 * m.room.create (keep only `creator`) and m.room.power_levels (drop `invite`)
 * differently from v11+. Deriving an ID without the room version silently
 * applies v11+ rules, so v1-10 create/power_levels land under phantom IDs that
 * no sender, resident, or later event ever references: joins store corrupted
 * state and residents reject later messages with
 * "missing auth event type m.room.power_levels".
 */
import { describe, expect, it } from 'vitest';
import { computeWireEventId, inboundWireEventIdCandidates, redactEventForSigning } from '../src/utils/event-signing';

// Verbatim fixture: the GNU/Linux room's m.room.create (v9, halogen.city,
// 2022 — fetched from matrix.org by ID $vg_GNDVSf2hYj1hJUJSmYoA760umYC5dJPl14SUhR4o).
// Pre-2023 Synapse events carry `origin` (and `prev_state`), which the v1-10
// redaction keep-list retains — dropping them derives a phantom ID.
const GNU_LINUX_CREATE = {
  auth_events: [],
  content: { creator: '@mazunki:halogen.city', room_version: '9' },
  depth: 1,
  hashes: { sha256: 'fWw9Z86qj9PugtVK3a+9cpPn6ihyvBIci2UzYWGxTcg' },
  origin: 'halogen.city',
  origin_server_ts: 1654943205025,
  prev_events: [],
  prev_state: [],
  room_id: '!iDwfRnmIeZCSTKVEim:halogen.city',
  sender: '@mazunki:halogen.city',
  signatures: {
    'halogen.city': {
      'ed25519:a_FRIi': 'rk5IHkGA1MCyjoEC3Vv8YqVa/WZccFRfvpPGAiAN33bxcAxx/ROv7Gnvk0dqjtZx3ghRZBuS3RRPp/n6uNy6CQ',
    },
  },
  state_key: '',
  type: 'm.room.create',
};

const ROOM = '!room:peer.test';
const CREATOR = '@bob:peer.test';

const createEvent = {
  room_id: ROOM,
  sender: CREATOR,
  type: 'm.room.create',
  content: { creator: CREATOR, room_version: '10' },
  origin_server_ts: 1_700_000_000_000,
  depth: 1,
  auth_events: [],
  prev_events: [],
};

const powerLevelsEvent = {
  room_id: ROOM,
  sender: CREATOR,
  type: 'm.room.power_levels',
  state_key: '',
  content: { users: { [CREATOR]: 100 }, users_default: 0, invite: 0, state_default: 50 },
  origin_server_ts: 1_700_000_000_001,
  depth: 2,
  auth_events: ['$create'],
  prev_events: ['$create'],
};

const memberEvent = {
  room_id: ROOM,
  sender: CREATOR,
  type: 'm.room.member',
  state_key: CREATOR,
  content: { membership: 'join' },
  origin_server_ts: 1_700_000_000_002,
  depth: 3,
  auth_events: ['$create'],
  prev_events: ['$pl'],
};

describe('room-version-aware wire IDs (v1-10 redaction differs from v11+)', () => {
  it('create: v10 and version-blind derivation agree; v11+ keeps full content and differs', async () => {
    const withVersion = await computeWireEventId(createEvent, '10');
    const withoutVersion = await computeWireEventId(createEvent);
    expect(withoutVersion).toBe(withVersion);
    // Modern redaction keeps creator and room_version in m.room.create.
    const redacted = redactEventForSigning(createEvent, '10') as { content: Record<string, unknown> };
    expect(redacted.content).toEqual({ creator: CREATOR, room_version: '10' });
  });

  it('power_levels: v10 drops `invite` from the redacted content', async () => {
    const withVersion = await computeWireEventId(powerLevelsEvent, '10');
    expect(await computeWireEventId(powerLevelsEvent)).toBe(withVersion);
    const redacted = redactEventForSigning(powerLevelsEvent, '10') as { content: Record<string, unknown> };
    expect(redacted.content.invite).toBe(0);
    expect(redacted.content.users).toEqual({ [CREATOR]: 100 });
  });

  it('member events hash identically either way (why joins appeared to work)', async () => {
    // m.room.member redaction is the same for v10 and v11+, so the phantom-ID
    // bug stayed invisible while joins/leaves were exercised.
    expect(await computeWireEventId(memberEvent, '10')).toBe(await computeWireEventId(memberEvent));
  });
});

describe('redaction keep-list is version-correct (v1/v2 legacy, v3+ modern)', () => {
  it('the 2022 GNU/Linux create ID is reproducible with legacy v2 rules', async () => {
    // Pre-2023 events in modern rooms were signed/hashed with the legacy
    // keep-list; the signature verifier's legacy fallback accepts them.
    expect(await computeWireEventId(GNU_LINUX_CREATE, '2')).toBe(
      '$vg_GNDVSf2hYj1hJUJSmYoA760umYC5dJPl14SUhR4o'
    );
    // A modern v9 derivation intentionally yields a different ID — the
    // bug was applying the legacy rule to CURRENT v9/v10 traffic.
    expect(await computeWireEventId(GNU_LINUX_CREATE, '9')).not.toBe(
      '$vg_GNDVSf2hYj1hJUJSmYoA760umYC5dJPl14SUhR4o'
    );
  });

  it('v2 retains origin and prev_state; v9 and modern forms drop them', () => {
    const legacy = redactEventForSigning(GNU_LINUX_CREATE, '2') as Record<string, unknown>;
    expect(legacy.origin).toBe('halogen.city');
    expect(legacy.prev_state).toEqual([]);
    const v9 = redactEventForSigning(GNU_LINUX_CREATE, '9') as Record<string, unknown>;
    expect('origin' in v9).toBe(false);
    expect('prev_state' in v9).toBe(false);
    const modern = redactEventForSigning(GNU_LINUX_CREATE) as Record<string, unknown>;
    expect('origin' in modern).toBe(false);
    expect('prev_state' in modern).toBe(false);
  });

  it('member events without origin/prev_state hash identically under both rules (why modern rooms worked)', async () => {
    const member = {
      ...GNU_LINUX_CREATE,
      type: 'm.room.member',
      state_key: '@mazunki:halogen.city',
      content: { membership: 'join' },
    } as Record<string, unknown>;
    delete member.origin;
    delete member.prev_state;
    // m.room.member content and top-level keeps coincide across v9/v11+.
    expect(await computeWireEventId(member, '9')).toBe(await computeWireEventId(member));
  });
});

describe('inbound ID candidates preserve remote (resident-authored) IDs', () => {
  it('prefers the legacy form for pre-2023 origin-bearing v9 events', async () => {
    const candidates = await inboundWireEventIdCandidates(GNU_LINUX_CREATE, '9');
    expect(candidates).toEqual([
      '$vg_GNDVSf2hYj1hJUJSmYoA760umYC5dJPl14SUhR4o',
      await computeWireEventId(GNU_LINUX_CREATE, '9'),
    ]);
    // Our outbound derivation is untouched: it still uses room-version rules.
    expect(await computeWireEventId(GNU_LINUX_CREATE, '9')).not.toBe(candidates[0]);
  });

  it('uses only room-version derivation for modern events and v11+ rooms', async () => {
    const modern = {
      ...GNU_LINUX_CREATE,
      origin_server_ts: 1_700_000_000_000,
    } as Record<string, unknown>;
    delete modern.origin;
    delete modern.prev_state;
    expect(await inboundWireEventIdCandidates(modern, '9')).toEqual([
      await computeWireEventId(modern, '9'),
    ]);

    const v11 = { ...GNU_LINUX_CREATE, room_version: '11' } as Record<string, unknown>;
    expect(await inboundWireEventIdCandidates(v11, '11')).toEqual([
      await computeWireEventId(v11, '11'),
    ]);
  });
});
