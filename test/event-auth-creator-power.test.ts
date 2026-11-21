import { describe, expect, it } from 'vitest';
import type { RoomPowerLevelsContent } from '../src/types';
import {
  CREATOR_POWER_LEVEL,
  getEffectiveUserPowerLevel,
  isRoomCreator,
} from '../src/services/event-auth';

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';

function createEvent(content: unknown = { room_version: '12' }, sender = ALICE) {
  return { sender, content };
}

function powerLevels(overrides: Partial<RoomPowerLevelsContent> = {}): RoomPowerLevelsContent {
  return { users: {}, users_default: 0, events: {}, events_default: 0, ...overrides };
}

describe('CREATOR_POWER_LEVEL', () => {
  it('is Synapse\'s 2^53 creator power, above the safe-integer range', () => {
    expect(CREATOR_POWER_LEVEL).toBe(2 ** 53);
    expect(CREATOR_POWER_LEVEL).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });
});

describe('isRoomCreator', () => {
  it('is false when there is no create event or its content is unusable', () => {
    expect(isRoomCreator(null, ALICE)).toBe(false);
    expect(isRoomCreator(undefined, ALICE)).toBe(false);
    expect(isRoomCreator({ sender: ALICE }, ALICE)).toBe(false);
    expect(isRoomCreator(createEvent('{not json'), ALICE)).toBe(false);
  });

  it('recognises the create sender only on creator-power room versions', () => {
    expect(isRoomCreator(createEvent(), ALICE)).toBe(true);
    expect(isRoomCreator(createEvent(), BOB)).toBe(false);
    expect(isRoomCreator(createEvent({ room_version: '11' }), ALICE)).toBe(false);
    expect(isRoomCreator(createEvent({ room_version: 'org.matrix.hydra.11' }), ALICE)).toBe(true);
    expect(isRoomCreator({ sender: ALICE, content: JSON.stringify({ room_version: '12' }) }, ALICE)).toBe(true);
  });

  it('recognises additional creators listed in the create content', () => {
    const event = createEvent({ room_version: '12', additional_creators: [BOB] });
    expect(isRoomCreator(event, BOB)).toBe(true);
    expect(isRoomCreator({ ...event, sender: BOB }, BOB)).toBe(true);
    expect(isRoomCreator(event, '@carol:example.com')).toBe(false);
    expect(isRoomCreator(createEvent({ room_version: '12', additional_creators: BOB }), BOB)).toBe(false);
  });
});

describe('getEffectiveUserPowerLevel', () => {
  it('gives creators implicit power even when the users map holds a finite level', () => {
    const levels = powerLevels({ users: { [ALICE]: 100, [BOB]: 50 } });
    expect(getEffectiveUserPowerLevel(levels, ALICE, createEvent())).toBe(CREATOR_POWER_LEVEL);
    expect(getEffectiveUserPowerLevel(levels, BOB, createEvent())).toBe(50);
  });

  it('falls back to the users map, users_default, then zero for non-creators', () => {
    const create = createEvent();
    expect(getEffectiveUserPowerLevel(powerLevels({ users: { [BOB]: 75 } }), BOB, create)).toBe(75);
    expect(getEffectiveUserPowerLevel(powerLevels({ users_default: 25 }), BOB, create)).toBe(25);
    expect(getEffectiveUserPowerLevel(powerLevels(), BOB, create)).toBe(0);
    expect(getEffectiveUserPowerLevel(powerLevels({ users: { [BOB]: -10 } }), BOB, create)).toBe(-10);
  });

  it('ignores creation metadata that does not mark this user as a creator', () => {
    const levels = powerLevels({ users: { [BOB]: 50 } });
    expect(getEffectiveUserPowerLevel(levels, BOB, createEvent({ room_version: '11' }))).toBe(50);
    expect(getEffectiveUserPowerLevel(levels, BOB, null)).toBe(50);
  });
});
