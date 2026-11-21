/**
 * MSC4289 creator power: the exported pure helpers that decide whether a user
 * is a room creator and what effective power level they get. They live behind
 * checkEventAuth in production but are exported and used directly by callers,
 * so their own contract is pinned here.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATOR_POWER_LEVEL,
  getEffectiveUserPowerLevel,
  isRoomCreator,
} from '../src/services/event-auth';

type CreateLike = { sender?: string; content?: unknown } | null | undefined;

const v12 = (content: Record<string, unknown> = {}): CreateLike => ({
  sender: '@alice:example.com',
  content: { room_version: '12', ...content },
});

describe('CREATOR_POWER_LEVEL', () => {
  it('matches Synapse\'s implicit creator power constant', () => {
    expect(CREATOR_POWER_LEVEL).toBe(2 ** 53);
  });
});

describe('isRoomCreator', () => {
  it('returns false without a create event', () => {
    expect(isRoomCreator(null, '@alice:example.com')).toBe(false);
    expect(isRoomCreator(undefined, '@alice:example.com')).toBe(false);
  });

  it('returns false with no content or an unsupported room version', () => {
    expect(isRoomCreator({}, '@alice:example.com')).toBe(false);
    expect(isRoomCreator({ sender: '@alice:example.com', content: { room_version: '10' } }, '@alice:example.com')).toBe(false);
    expect(isRoomCreator({ sender: '@alice:example.com', content: { room_version: '11' } }, '@alice:example.com')).toBe(false);
  });

  it('recognises the create-event sender in an MSC4291 room version', () => {
    expect(isRoomCreator(v12(), '@alice:example.com')).toBe(true);
    expect(isRoomCreator({ sender: '@alice:example.com', content: { room_version: 'org.matrix.hydra.11' } }, '@alice:example.com')).toBe(true);
  });

  it('recognises additional creators listed in the create content', () => {
    expect(isRoomCreator(v12({ additional_creators: ['@bob:example.com', '@carol:example.com'] }), '@bob:example.com')).toBe(true);
    expect(isRoomCreator(v12({ additional_creators: ['@bob:example.com'] }), '@eve:example.com')).toBe(false);
  });

  it('accepts JSON-string content and rejects invalid JSON', () => {
    const event: CreateLike = {
      sender: '@alice:example.com',
      content: JSON.stringify({ room_version: '12', additional_creators: ['@bob:example.com'] }),
    };
    expect(isRoomCreator(event, '@bob:example.com')).toBe(true);
    expect(isRoomCreator({ sender: '@alice:example.com', content: '{not json' }, '@alice:example.com')).toBe(false);
  });

  it('ignores a non-array additional_creators value', () => {
    expect(isRoomCreator(v12({ additional_creators: '@bob:example.com' }), '@bob:example.com')).toBe(false);
  });
});

describe('getEffectiveUserPowerLevel', () => {
  it('uses the explicit users-map entry when present', () => {
    expect(getEffectiveUserPowerLevel({ users: { '@bob:example.com': 50 } }, '@bob:example.com', null)).toBe(50);
    expect(getEffectiveUserPowerLevel({ users: { '@bob:example.com': 0 } }, '@bob:example.com', null)).toBe(0);
  });

  it('falls back to users_default then to zero', () => {
    expect(getEffectiveUserPowerLevel({ users_default: 25 }, '@bob:example.com', null)).toBe(25);
    expect(getEffectiveUserPowerLevel({}, '@bob:example.com', null)).toBe(0);
  });

  it('grants implicit creator power in an MSC4291 room version', () => {
    expect(
      getEffectiveUserPowerLevel(
        { users: { '@alice:example.com': 25 } },
        '@alice:example.com',
        v12()
      )
    ).toBe(CREATOR_POWER_LEVEL);
    expect(
      getEffectiveUserPowerLevel(
        { users: { '@bob:example.com': 75 } },
        '@bob:example.com',
        v12({ additional_creators: ['@bob:example.com'] })
      )
    ).toBe(CREATOR_POWER_LEVEL);
  });

  it('does not grant creator power in pre-MSC4291 room versions', () => {
    expect(
      getEffectiveUserPowerLevel(
        { users: { '@alice:example.com': 25 } },
        '@alice:example.com',
        { sender: '@alice:example.com', content: { room_version: '10' } }
      )
    ).toBe(25);
  });
});
