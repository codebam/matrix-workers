/**
 * expectedAuthTypes is the pure helper that derives the wire auth_events a
 * receiving server expects for an event. It is consumed indirectly through a
 * test helper in the federation suite, but its own contract was never pinned.
 */
import { describe, expect, it } from 'vitest';
import { expectedAuthTypes } from '../src/services/event-auth';

const NUL = '\u0000';
const powerLevelsKey = `m.room.power_levels${NUL}`;
const joinRulesKey = `m.room.join_rules${NUL}`;
const memberKey = (userId: string) => `m.room.member${NUL}${userId}`;
const thirdPartyInviteKey = (token: string) => `m.room.third_party_invite${NUL}${token}`;

const SENDER = '@alice:example.com';

describe('expectedAuthTypes', () => {
  it('returns an empty set for create events', () => {
    expect(expectedAuthTypes('m.room.create', SENDER, '', {})).toEqual(new Set());
  });

  it('returns only power_levels and the sender membership for a non-member event', () => {
    expect(expectedAuthTypes('m.room.message', SENDER, 'target', {})).toEqual(
      new Set([powerLevelsKey, memberKey(SENDER)])
    );
  });

  it('adds join_rules and the target membership for join/invite/knock memberships', () => {
    for (const membership of ['join', 'invite', 'knock']) {
      expect(expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', { membership })).toEqual(
        new Set([
          powerLevelsKey,
          memberKey(SENDER),
          joinRulesKey,
          memberKey('@bob:example.com'),
        ])
      );
    }
  });

  it('does not add join_rules for leave/ban memberships', () => {
    for (const membership of ['leave', 'ban']) {
      expect(expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', { membership })).toEqual(
        new Set([powerLevelsKey, memberKey(SENDER), memberKey('@bob:example.com')])
      );
    }
  });

  it('omits the target membership when the event has no state_key', () => {
    expect(expectedAuthTypes('m.room.member', SENDER, undefined, { membership: 'join' })).toEqual(
      new Set([powerLevelsKey, memberKey(SENDER), joinRulesKey])
    );
  });

  it('adds the signed third-party-invite token for invites', () => {
    expect(
      expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', {
        membership: 'invite',
        third_party_invite: { signed: { token: 'tok-1' } },
      })
    ).toEqual(
      new Set([
        powerLevelsKey,
        memberKey(SENDER),
        joinRulesKey,
        memberKey('@bob:example.com'),
        thirdPartyInviteKey('tok-1'),
      ])
    );
  });

  it('ignores a third-party invite with no signed token', () => {
    expect(
      expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', {
        membership: 'invite',
        third_party_invite: { signed: {} },
      })
    ).toEqual(
      new Set([
        powerLevelsKey,
        memberKey(SENDER),
        joinRulesKey,
        memberKey('@bob:example.com'),
      ])
    );
  });

  it('adds the authorising user membership for restricted joins', () => {
    expect(
      expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', {
        membership: 'join',
        join_authorised_via_users_server: '@mod:example.com',
      })
    ).toEqual(
      new Set([
        powerLevelsKey,
        memberKey(SENDER),
        joinRulesKey,
        memberKey('@bob:example.com'),
        memberKey('@mod:example.com'),
      ])
    );
  });

  it('ignores a non-string authorising user', () => {
    expect(
      expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', {
        membership: 'join',
        join_authorised_via_users_server: 42,
      })
    ).not.toContain(memberKey('42'));
  });

  it('does not add restricted-join keys for non-join memberships', () => {
    expect(
      expectedAuthTypes('m.room.member', SENDER, '@bob:example.com', {
        membership: 'invite',
        join_authorised_via_users_server: '@mod:example.com',
      })
    ).not.toContain(memberKey('@mod:example.com'));
  });
});
