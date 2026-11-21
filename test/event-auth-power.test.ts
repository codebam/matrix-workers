/**
 * Pins for the pure MSC4289 power-level helpers in event-auth: creator
 * detection and effective power level. These helpers have no dedicated
 * coverage in the existing event-auth suites, which only exercise them
 * indirectly through checkEventAuth.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATOR_POWER_LEVEL,
  getEffectiveUserPowerLevel,
  isRoomCreator,
} from '../src/services/event-auth';
import type { RoomPowerLevelsContent } from '../src/types';

const CREATOR = '@alice:example.com';
const OTHER = '@bob:example.com';

function createEvent(
  roomVersion: string | undefined,
  sender: string = CREATOR,
  additionalCreators?: unknown
): { sender?: string; content?: unknown } {
  return {
    sender,
    content: {
      ...(roomVersion !== undefined ? { room_version: roomVersion } : {}),
      ...(additionalCreators !== undefined ? { additional_creators: additionalCreators } : {}),
    },
  };
}

const powerLevels = (overrides: RoomPowerLevelsContent = {}): RoomPowerLevelsContent => ({
  users: {},
  users_default: 0,
  ...overrides,
});

describe('CREATOR_POWER_LEVEL', () => {
  it('matches the Synapse CREATOR_POWER_LEVEL constant (2^53)', () => {
    expect(CREATOR_POWER_LEVEL).toBe(2 ** 53);
  });
});

describe('isRoomCreator', () => {
  it('returns false when there is no create event', () => {
    expect(isRoomCreator(null, CREATOR)).toBe(false);
    expect(isRoomCreator(undefined, CREATOR)).toBe(false);
  });

  it('returns false for pre-v12 room versions, even for the create sender', () => {
    expect(isRoomCreator(createEvent('9'), CREATOR)).toBe(false);
    expect(isRoomCreator(createEvent('10'), CREATOR)).toBe(false);
    expect(isRoomCreator(createEvent('11'), CREATOR)).toBe(false);
  });

  it('treats the create sender as creator in a v12 room', () => {
    expect(isRoomCreator(createEvent('12'), CREATOR)).toBe(true);
    expect(isRoomCreator(createEvent('12'), OTHER)).toBe(false);
  });

  it('treats org.matrix.hydra.11 and later versions as creator-power versions', () => {
    expect(isRoomCreator(createEvent('org.matrix.hydra.11'), CREATOR)).toBe(true);
    expect(isRoomCreator(createEvent('13'), CREATOR)).toBe(true);
  });

  it('recognises users listed in additional_creators', () => {
    const create = createEvent('12', CREATOR, [OTHER, '@carol:example.com']);
    expect(isRoomCreator(create, OTHER)).toBe(true);
    expect(isRoomCreator(create, '@carol:example.com')).toBe(true);
    expect(isRoomCreator(create, '@dave:example.com')).toBe(false);
  });

  it('ignores a non-array additional_creators', () => {
    expect(isRoomCreator(createEvent('12', CREATOR, OTHER), OTHER)).toBe(false);
  });

  it('parses a stringified JSON create content', () => {
    const create = { sender: CREATOR, content: JSON.stringify({ room_version: '12' }) };
    expect(isRoomCreator(create, CREATOR)).toBe(true);
  });

  it('returns false on unparseable string content', () => {
    const create = { sender: CREATOR, content: '{not json' };
    expect(isRoomCreator(create, CREATOR)).toBe(false);
  });

  it('returns false when room_version is missing', () => {
    expect(isRoomCreator({ sender: CREATOR }, CREATOR)).toBe(false);
    expect(isRoomCreator({ sender: CREATOR, content: {} }, CREATOR)).toBe(false);
  });
});

describe('getEffectiveUserPowerLevel', () => {
  it('grants creators the implicit creator power level in a v12 room', () => {
    const create = createEvent('12');
    // The implicit level wins even over an explicit users entry.
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users: { [CREATOR]: 100 } }), CREATOR, create)
    ).toBe(CREATOR_POWER_LEVEL);
  });

  it('grants additional creators the implicit power level too', () => {
    const create = createEvent('12', CREATOR, [OTHER]);
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users: { [OTHER]: 10 } }), OTHER, create)
    ).toBe(CREATOR_POWER_LEVEL);
  });

  it('returns the explicit users entry for non-creators', () => {
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users: { [OTHER]: 50 } }), OTHER, createEvent('12'))
    ).toBe(50);
  });

  it('falls back to users_default when the user is absent', () => {
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users_default: 25 }), OTHER, createEvent('12'))
    ).toBe(25);
  });

  it('falls back to 0 when neither users nor users_default is set', () => {
    expect(getEffectiveUserPowerLevel({}, OTHER, createEvent('12'))).toBe(0);
  });

  it('does not grant implicit power to creators in pre-v12 rooms', () => {
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users: { [CREATOR]: 75 } }), CREATOR, createEvent('10'))
    ).toBe(75);
  });

  it('falls back to the map when there is no create event', () => {
    expect(
      getEffectiveUserPowerLevel(powerLevels({ users: { [CREATOR]: 60 } }), CREATOR, null)
    ).toBe(60);
    expect(getEffectiveUserPowerLevel(powerLevels(), CREATOR, null)).toBe(0);
  });
});
