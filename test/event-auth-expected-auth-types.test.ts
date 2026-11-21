// Pins the pure expectedAuthTypes helper: which auth-event keys an event of a
// given shape requires. No auth-flow or network behaviour is exercised here.
import { describe, expect, it } from 'vitest';
import { expectedAuthTypes } from '../src/services/event-auth';

// The state-map key format the helper emits: type, a null byte, then state key.
const k = (type: string, key = ''): string => `${type}\u0000${key}`;

const ALICE = '@alice:example.com';
const BOB = '@bob:example.com';
const AUTHORISER = '@mod:example.com';

describe('expectedAuthTypes', () => {
  it('returns no auth events for the create event itself', () => {
    expect(expectedAuthTypes('m.room.create', ALICE, '', {
      membership: 'join',
      join_authorised_via_users_server: AUTHORISER,
    })).toEqual(new Set());
  });

  it('always requires power_levels and the sender membership for a non-member event', () => {
    expect(expectedAuthTypes('m.room.power_levels', ALICE, '', {})).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', ALICE),
    ]));
    // Join-rule / target logic is gated on the member event type only.
    expect(expectedAuthTypes('m.room.topic', BOB, 'topic', {
      membership: 'join',
      join_authorised_via_users_server: AUTHORISER,
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', BOB),
    ]));
  });

  it('join requires join_rules, target membership, and the authorising user', () => {
    expect(expectedAuthTypes('m.room.member', BOB, ALICE, {
      membership: 'join',
      join_authorised_via_users_server: AUTHORISER,
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', BOB),
      k('m.room.join_rules'),
      k('m.room.member', ALICE),
      k('m.room.member', AUTHORISER),
    ]));
  });

  it('join without a string authorising user omits that auth event', () => {
    expect(expectedAuthTypes('m.room.member', ALICE, ALICE, {
      membership: 'join',
      join_authorised_via_users_server: 42,
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', ALICE),
      k('m.room.join_rules'),
    ]));
  });

  it('invite requires join_rules, target membership and a signed third-party invite token', () => {
    expect(expectedAuthTypes('m.room.member', BOB, ALICE, {
      membership: 'invite',
      third_party_invite: { signed: { token: 'token-xyz' } },
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', BOB),
      k('m.room.join_rules'),
      k('m.room.member', ALICE),
      k('m.room.third_party_invite', 'token-xyz'),
    ]));
  });

  it('invite without a signed token omits the third-party invite auth event', () => {
    expect(expectedAuthTypes('m.room.member', BOB, ALICE, {
      membership: 'invite',
      third_party_invite: { signed: {} },
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', BOB),
      k('m.room.join_rules'),
      k('m.room.member', ALICE),
    ]));
    // Authorising user is only consulted for joins, never invites.
    expect(expectedAuthTypes('m.room.member', BOB, ALICE, {
      membership: 'invite',
      join_authorised_via_users_server: AUTHORISER,
    })).not.toContain(k('m.room.member', AUTHORISER));
  });

  it('knock requires join_rules but not a third-party invite', () => {
    expect(expectedAuthTypes('m.room.member', ALICE, ALICE, {
      membership: 'knock',
      third_party_invite: { signed: { token: 'token-xyz' } },
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', ALICE),
      k('m.room.join_rules'),
    ]));
  });

  it('leave and ban add the target membership but no join_rules', () => {
    for (const membership of ['leave', 'ban']) {
      expect(expectedAuthTypes('m.room.member', BOB, ALICE, { membership })).toEqual(new Set([
        k('m.room.power_levels'),
        k('m.room.member', BOB),
        k('m.room.member', ALICE),
      ]));
    }
  });

  it('omits the target membership key when state_key is undefined', () => {
    expect(expectedAuthTypes('m.room.member', ALICE, undefined, {
      membership: 'join',
    })).toEqual(new Set([
      k('m.room.power_levels'),
      k('m.room.member', ALICE),
      k('m.room.join_rules'),
    ]));
  });
});
