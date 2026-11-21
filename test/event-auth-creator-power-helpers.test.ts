import { describe, it, expect } from 'vitest';
import {
  CREATOR_POWER_LEVEL,
  getEffectiveUserPowerLevel,
  isRoomCreator,
} from '../src/services/event-auth';
import type { RoomPowerLevelsContent } from '../src/types';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';

const create = (content: Record<string, unknown>, sender = USER) => ({ sender, content });

const levels = (partial: Record<string, unknown> = {}): RoomPowerLevelsContent =>
  ({
    users: {},
    users_default: 0,
    events: {},
    events_default: 0,
    state_default: 50,
    ban: 50,
    kick: 50,
    redact: 50,
    invite: 0,
    ...partial,
  }) as RoomPowerLevelsContent;

describe('CREATOR_POWER_LEVEL', () => {
  it('is Synapse\'s implicit creator power, 2^53', () => {
    expect(CREATOR_POWER_LEVEL).toBe(2 ** 53);
    expect(Number.isSafeInteger(CREATOR_POWER_LEVEL)).toBe(false);
  });
});

describe('isRoomCreator', () => {
  it('rejects a missing or unparseable create event', () => {
    expect(isRoomCreator(null, USER)).toBe(false);
    expect(isRoomCreator(undefined, USER)).toBe(false);
    expect(isRoomCreator({ sender: USER, content: '{not json' }, USER)).toBe(false);
  });

  it('only recognises MSC4291 room versions', () => {
    expect(isRoomCreator(create({ room_version: '10' }), USER)).toBe(false);
    expect(isRoomCreator(create({ room_version: '11' }), USER)).toBe(false);
    expect(isRoomCreator(create({ creator: USER }), USER)).toBe(false);
    expect(isRoomCreator(create({ room_version: '12' }), USER)).toBe(true);
    expect(isRoomCreator(create({ room_version: '13' }), USER)).toBe(true);
    expect(isRoomCreator(create({ room_version: 'org.matrix.hydra.11' }), USER)).toBe(true);
  });

  it('accepts a JSON-encoded content and the additional_creators list', () => {
    expect(isRoomCreator(create(JSON.stringify({ room_version: '12' })), USER)).toBe(true);
    const founder = create({ room_version: '12', additional_creators: [OTHER] }, '@founder:example.com');
    expect(isRoomCreator(founder, OTHER)).toBe(true);
    expect(isRoomCreator(founder, USER)).toBe(false);
    expect(isRoomCreator(create({ room_version: '12', additional_creators: OTHER }, '@founder:example.com'), USER)).toBe(false);
  });
});

describe('getEffectiveUserPowerLevel', () => {
  it('gives creators implicit power even when they appear in users', () => {
    const power = levels({ users: { [USER]: 100 } });
    expect(getEffectiveUserPowerLevel(power, USER, create({ room_version: '12' }))).toBe(CREATOR_POWER_LEVEL);
  });

  it('uses the explicit level for non-creators', () => {
    const power = levels({ users: { [USER]: 100, [OTHER]: 50 }, users_default: 7 });
    const foreignCreate = create({ room_version: '12' }, '@founder:example.com');
    expect(getEffectiveUserPowerLevel(power, USER, foreignCreate)).toBe(100);
    expect(getEffectiveUserPowerLevel(power, OTHER, foreignCreate)).toBe(50);
  });

  it('falls back to users_default, then zero', () => {
    expect(getEffectiveUserPowerLevel(levels({ users_default: 7 }), USER, null)).toBe(7);
    expect(getEffectiveUserPowerLevel(levels(), USER, undefined)).toBe(0);
  });
});
