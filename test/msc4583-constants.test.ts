import { describe, expect, it } from 'vitest';
import {
  MSC4583_STATE_MINIMUM_DEFAULT,
  msc4583RedactionContentKeys,
} from '../src/api/msc4583';

describe('MSC4583 exported constants', () => {
  it('pins the default state_minimum value', () => {
    expect(MSC4583_STATE_MINIMUM_DEFAULT).toBe(50);
  });

  it('pins the power-levels redaction content keys, including state_minimum', () => {
    expect(msc4583RedactionContentKeys('m.room.power_levels')).toEqual([
      'ban', 'events', 'events_default', 'invite', 'kick',
      'redact', 'state_default', 'users', 'users_default', 'notifications',
      'state_minimum',
    ]);
  });

  it('pins the member redaction content keys', () => {
    expect(msc4583RedactionContentKeys('m.room.member')).toEqual([
      'membership', 'join_authorised_via_users_server', 'third_party_invite',
    ]);
  });

  it('pins the create redaction content keys', () => {
    expect(msc4583RedactionContentKeys('m.room.create')).toEqual(['creator', 'room_version']);
  });

  it('pins the join-rules redaction content keys', () => {
    expect(msc4583RedactionContentKeys('m.room.join_rules')).toEqual(['join_rule', 'allow']);
  });

  it('pins the history-visibility redaction content keys', () => {
    expect(msc4583RedactionContentKeys('m.room.history_visibility')).toEqual(['history_visibility']);
  });

  it('pins the redaction redaction content keys', () => {
    expect(msc4583RedactionContentKeys('m.room.redaction')).toEqual(['redacts']);
  });

  it('returns no content keys for event types outside the keep-list', () => {
    expect(msc4583RedactionContentKeys('m.room.name')).toEqual([]);
    expect(msc4583RedactionContentKeys('')).toEqual([]);
  });
});
