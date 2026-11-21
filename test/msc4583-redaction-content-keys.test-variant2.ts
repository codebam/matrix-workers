/**
 * msc4583RedactionContentKeys is the per-event-type keep-list that decides
 * which content fields survive redaction in the MSC4583 room version. The
 * existing MSC4583 test only reaches it indirectly (via the compute and
 * allowed-keys wrappers) for power_levels, topic and name, leaving the other
 * branches unpinned. Pin every branch directly — no bindings, no product code.
 */
import { describe, expect, it } from 'vitest';
import { msc4583RedactionContentKeys } from '../src/api/msc4583';

describe('msc4583RedactionContentKeys', () => {
  it('keeps state_minimum alongside the v12 power-levels fields', () => {
    expect(msc4583RedactionContentKeys('m.room.power_levels')).toEqual([
      'ban', 'events', 'events_default', 'invite', 'kick',
      'redact', 'state_default', 'users', 'users_default', 'notifications',
      'state_minimum',
    ]);
  });

  it('keeps the spec-defined fields for the other redaction-aware event types', () => {
    expect(msc4583RedactionContentKeys('m.room.member')).toEqual([
      'membership', 'join_authorised_via_users_server', 'third_party_invite',
    ]);
    expect(msc4583RedactionContentKeys('m.room.create')).toEqual(['creator', 'room_version']);
    expect(msc4583RedactionContentKeys('m.room.join_rules')).toEqual(['join_rule', 'allow']);
    expect(msc4583RedactionContentKeys('m.room.history_visibility')).toEqual(['history_visibility']);
    expect(msc4583RedactionContentKeys('m.room.redaction')).toEqual(['redacts']);
  });

  it('keeps no content for event types without a keep-list', () => {
    expect(msc4583RedactionContentKeys('m.room.message')).toEqual([]);
    expect(msc4583RedactionContentKeys('m.custom.event')).toEqual([]);
    expect(msc4583RedactionContentKeys('')).toEqual([]);
  });
});
