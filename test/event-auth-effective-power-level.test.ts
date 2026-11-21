/**
 * Focused pins for getEffectiveUserPowerLevel (src/services/event-auth.ts).
 *
 * The helper has two jobs: ordinary users resolve from the power-levels map
 * (explicit entry, then users_default, then 0), while MSC4289 room creators
 * in v12-family rooms get implicit CREATOR_POWER_LEVEL even when they are
 * absent from (or explicitly listed in) the users map. No bindings, no routes.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATOR_POWER_LEVEL,
  getEffectiveUserPowerLevel,
} from '../src/services/event-auth';
import type { RoomPowerLevelsContent } from '../src/types';

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const CAROL = '@carol:example.com';

type CreateEvent = { sender?: string; content?: unknown } | null | undefined;

function pl(overrides: RoomPowerLevelsContent = {}): RoomPowerLevelsContent {
  return { users: {}, users_default: 0, ...overrides };
}

function create(
  roomVersion: string | number,
  extra: Record<string, unknown> = {},
  sender = ALICE
): CreateEvent {
  return { sender, content: { room_version: roomVersion, ...extra } };
}

describe('getEffectiveUserPowerLevel — ordinary power-level resolution', () => {
  it('uses an explicit users-map entry when present', () => {
    const levels = pl({ users: { [ALICE]: 75 }, users_default: 25 });
    expect(getEffectiveUserPowerLevel(levels, ALICE, null)).toBe(75);
  });

  it('an explicit 0 beats a non-zero users_default', () => {
    const levels = pl({ users: { [ALICE]: 0 }, users_default: 100 });
    expect(getEffectiveUserPowerLevel(levels, ALICE, undefined)).toBe(0);
  });

  it('falls back to users_default and then to 0', () => {
    expect(getEffectiveUserPowerLevel(pl({ users_default: 42 }), BOB, null)).toBe(42);
    expect(getEffectiveUserPowerLevel(pl(), CAROL, null)).toBe(0);
    expect(getEffectiveUserPowerLevel({}, CAROL, null)).toBe(0);
  });

  it('an old-version create event does not change the resolved level', () => {
    const levels = pl({ users: { [ALICE]: 50 } });
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('10'))).toBe(50);
    expect(getEffectiveUserPowerLevel(levels, BOB, create('11'))).toBe(0);
  });
});

describe('getEffectiveUserPowerLevel — MSC4289 creator power', () => {
  it('exposes the Synapse-compatible creator power constant', () => {
    expect(CREATOR_POWER_LEVEL).toBe(2 ** 53);
  });

  it('grants the create sender implicit power in v12 rooms, overriding the users map', () => {
    const levels = pl({ users: { [ALICE]: 100 }, users_default: 50 });
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('12'))).toBe(2 ** 53);
  });

  it('recognises the unstable hydra version and numeric v12', () => {
    const levels = pl();
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('org.matrix.hydra.11'))).toBe(2 ** 53);
    expect(getEffectiveUserPowerLevel(levels, ALICE, create(12))).toBe(2 ** 53);
  });

  it('does not grant creator power below v12 or without a room_version', () => {
    const levels = pl({ users: { [ALICE]: 60 } });
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('11'))).toBe(60);
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('10'))).toBe(60);
    expect(getEffectiveUserPowerLevel(levels, ALICE, { sender: ALICE, content: {} })).toBe(60);
    expect(getEffectiveUserPowerLevel(levels, ALICE, { sender: ALICE })).toBe(60);
  });

  it('grants implicit power to listed additional creators, not to other users', () => {
    const levels = pl({ users: { [BOB]: 10, [CAROL]: 30 } });
    const event = create('12', { additional_creators: [BOB] });
    expect(getEffectiveUserPowerLevel(levels, BOB, event)).toBe(2 ** 53);
    expect(getEffectiveUserPowerLevel(levels, CAROL, event)).toBe(30);
    expect(getEffectiveUserPowerLevel(levels, ALICE, event)).toBe(2 ** 53);
  });

  it('ignores a non-array additional_creators field', () => {
    const levels = pl({ users: { [BOB]: 7 } });
    expect(getEffectiveUserPowerLevel(levels, BOB, create('12', { additional_creators: BOB }))).toBe(7);
  });

  it('parses stringified create content, but tolerates malformed JSON', () => {
    const levels = pl({ users: { [ALICE]: 5, [BOB]: 9 } });
    const json = JSON.stringify({ room_version: '12', additional_creators: [BOB] });
    expect(getEffectiveUserPowerLevel(levels, ALICE, { sender: ALICE, content: json })).toBe(2 ** 53);
    expect(getEffectiveUserPowerLevel(levels, BOB, { sender: ALICE, content: json })).toBe(2 ** 53);

    const malformed: CreateEvent = { sender: ALICE, content: '{not json' };
    expect(getEffectiveUserPowerLevel(levels, ALICE, malformed)).toBe(5);
    expect(getEffectiveUserPowerLevel(levels, BOB, malformed)).toBe(9);
  });

  it('requires an exact user-id match for the create sender', () => {
    const levels = pl({ users: { [ALICE]: 20 } });
    expect(getEffectiveUserPowerLevel(levels, ALICE, create('12', {}, '@ALICE:example.com'))).toBe(20);
  });
});
