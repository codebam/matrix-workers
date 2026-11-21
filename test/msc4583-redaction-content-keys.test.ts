import { describe, expect, it } from 'vitest';
import {
  MSC4583_STATE_MINIMUM_DEFAULT,
  msc4583ComputeRedactedContent,
  msc4583RedactionAllowedKeys,
  msc4583RedactionContentKeys,
  msc4583RequiredPowerLevel,
  msc4583StateMinimum,
} from '../src/api/msc4583';

describe('msc4583RedactionContentKeys', () => {
  it('keeps the whole v12 power-levels keep-list plus state_minimum', () => {
    expect(msc4583RedactionContentKeys('m.room.power_levels')).toEqual([
      'ban', 'events', 'events_default', 'invite', 'kick',
      'redact', 'state_default', 'users', 'users_default', 'notifications',
      'state_minimum',
    ]);
  });

  it('gives each other redaction-aware event its own exact keep-list', () => {
    expect(msc4583RedactionContentKeys('m.room.member')).toEqual([
      'membership', 'join_authorised_via_users_server', 'third_party_invite',
    ]);
    expect(msc4583RedactionContentKeys('m.room.create')).toEqual(['creator', 'room_version']);
    expect(msc4583RedactionContentKeys('m.room.join_rules')).toEqual(['join_rule', 'allow']);
    expect(msc4583RedactionContentKeys('m.room.history_visibility')).toEqual(['history_visibility']);
    expect(msc4583RedactionContentKeys('m.room.redaction')).toEqual(['redacts']);
  });

  it('keeps no content at all for an unknown event type', () => {
    expect(msc4583RedactionContentKeys('m.room.topic')).toEqual([]);
    expect(msc4583RedactionContentKeys('m.custom.state')).toEqual([]);
  });

  it('composes with the top-level keys without leaking state_minimum elsewhere', () => {
    const topLevel = [
      'event_id', 'type', 'room_id', 'sender', 'state_key',
      'hashes', 'signatures', 'depth', 'prev_events', 'auth_events',
      'origin_server_ts',
    ];
    expect(msc4583RedactionAllowedKeys('m.room.power_levels')).toEqual([
      ...topLevel,
      ...msc4583RedactionContentKeys('m.room.power_levels'),
    ]);
    expect(msc4583RedactionAllowedKeys('m.room.member')).toEqual([
      ...topLevel,
      ...msc4583RedactionContentKeys('m.room.member'),
    ]);
    expect(msc4583RedactionAllowedKeys('m.room.topic')).toEqual(topLevel);
  });
});

describe('msc4583 redaction content', () => {
  it('preserves only the content keys of each event type', () => {
    expect(
      msc4583ComputeRedactedContent('m.room.member', {
        membership: 'join',
        third_party_invite: { signed: {} },
        displayname: 'drop-me',
      })
    ).toEqual({ membership: 'join', third_party_invite: { signed: {} } });

    expect(
      msc4583ComputeRedactedContent('m.room.create', {
        creator: '@a:ex.com', room_version: '12', predecessor: 'drop-me',
      })
    ).toEqual({ creator: '@a:ex.com', room_version: '12' });

    expect(
      msc4583ComputeRedactedContent('m.room.join_rules', {
        join_rule: 'restricted', allow: [{ type: 'm.room_membership' }], extra: 1,
      })
    ).toEqual({ join_rule: 'restricted', allow: [{ type: 'm.room_membership' }] });

    expect(
      msc4583ComputeRedactedContent('m.room.redaction', { redacts: '$abc', body: 'drop-me' })
    ).toEqual({ redacts: '$abc' });
  });

  it('returns an empty object for content that is not a record', () => {
    for (const value of [null, undefined, 42, 'power levels', ['events']]) {
      expect(msc4583ComputeRedactedContent('m.room.power_levels', value)).toEqual({});
    }
  });
});

describe('msc4583 power-level guards', () => {
  it('falls back to the exported default for every non-integer value', () => {
    expect(MSC4583_STATE_MINIMUM_DEFAULT).toBe(50);
    for (const value of [null, true, [], { value: 75 }, NaN, Infinity, 1.5, '75']) {
      expect(msc4583StateMinimum({ state_minimum: value })).toBe(MSC4583_STATE_MINIMUM_DEFAULT);
    }
  });

  it('honours a minimum of zero', () => {
    expect(msc4583StateMinimum({ state_minimum: 0 })).toBe(0);
    expect(
      msc4583RequiredPowerLevel(
        { events: { 'm.custom': 0 }, state_default: 50, state_minimum: 0 },
        'm.custom',
        true,
      )
    ).toBe(0);
  });

  it('ignores invalid per-event overrides instead of treating them as levels', () => {
    expect(
      msc4583RequiredPowerLevel(
        { events: { 'm.custom': '80' }, state_default: 60, state_minimum: 40 },
        'm.custom',
        true,
      )
    ).toBe(60);
    expect(
      msc4583RequiredPowerLevel(
        { events: { 'm.room.message': '0' }, events_default: 2, state_minimum: 100 },
        'm.room.message',
        false,
      )
    ).toBe(2);
  });

  it('leaves membership and redaction requirements alone when they are not state events', () => {
    const powerLevels = { events: { 'm.room.member': 0, 'm.room.redaction': 0 }, state_minimum: 90 };
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.room.member', false)).toBe(0);
    expect(msc4583RequiredPowerLevel(powerLevels, 'm.room.redaction', false)).toBe(0);
  });
});
