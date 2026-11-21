import { describe, expect, it } from 'vitest';
import {
  MSC4583_ROOM_VERSION,
  MSC4583_ROOM_VERSION_BEHAVIOR,
  msc4583ComputeRedactedContent,
  msc4583RedactionAllowedKeys,
  msc4583RequiredPowerLevel,
  msc4583StateMinimum,
} from '../src/api/msc4583';

describe('MSC4583 minimum power level to send state', () => {
  it('uses the unstable room version with v12 behaviour', () => {
    expect(MSC4583_ROOM_VERSION).toBe('dev.zirco.msc4583.v1');
    expect(MSC4583_ROOM_VERSION_BEHAVIOR).toMatchObject({
      version: MSC4583_ROOM_VERSION,
      eventIdFormat: 'v4',
      redactionAlgorithm: 'v11',
      authRuleVariant: 'v10',
      updatedRedactionRules: true,
      stable: false,
    });
  });

  it('defaults state_minimum to 50 when absent, missing power levels, or invalid', () => {
    expect(msc4583StateMinimum({ state_minimum: 75 })).toBe(75);
    expect(msc4583StateMinimum({})).toBe(50);
    expect(msc4583StateMinimum(undefined)).toBe(50);
    expect(msc4583StateMinimum({ state_minimum: '75' })).toBe(50);
    expect(msc4583StateMinimum({ state_minimum: 1.5 })).toBe(50);
  });

  it('floors a state event override with state_minimum', () => {
    const powerLevels = {
      events: { 'm.room.message': 0, 'm.reaction': 80 },
      events_default: 1,
      state_default: 50,
      state_minimum: 50,
    };
    // The problem case from the MSC: m.room.message: 0 must not permit state.
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.room.message', true)).toBe(50);
    // A higher override is kept as-is.
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.reaction', true)).toBe(80);
  });

  it('floors an unlisted state event with max(state_default, state_minimum)', () => {
    expect(msc4583RequiredPowerLevel({ state_default: 30, state_minimum: 50 }, 'm.custom', true)).toBe(50);
    expect(msc4583RequiredPowerLevel({ state_default: 80, state_minimum: 50 }, 'm.custom', true)).toBe(80);
    expect(msc4583RequiredPowerLevel({}, 'm.custom', true)).toBe(50);
  });

  it('leaves non-state event requirements unchanged', () => {
    const powerLevels = {
      events: { 'm.room.message': 0 },
      events_default: 1,
      state_default: 50,
      state_minimum: 100,
    };
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.room.message', false)).toBe(0);
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.reaction', false)).toBe(1);
  });

  it('preserves state_minimum through redaction of power levels', () => {
    const content = {
      events: { 'm.room.message': 0 },
      state_default: 50,
      state_minimum: 50,
      secret: 'drop-me',
    };
    expect(msc4583ComputeRedactedContent('m.room.power_levels', content)).toEqual({
      events: { 'm.room.message': 0 },
      state_default: 50,
      state_minimum: 50,
    });
    expect(msc4583RedactionAllowedKeys('m.room.power_levels')).toContain('state_minimum');
    expect(msc4583RedactionAllowedKeys('m.room.name')).not.toContain('state_minimum');
  });

  it('does not add state_minimum to other event types redacted content', () => {
    expect(msc4583ComputeRedactedContent('m.room.topic', { state_minimum: 5, topic: 'kept?' })).toEqual({});
  });
});
