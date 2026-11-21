/**
 * Focused pin for the pure `rulesFromState` adapter in moderation-policy:
 * room state in, PolicyRules out — no DB, no cache, no clock.
 */
import { describe, expect, it } from 'vitest';
import { rulesFromState } from '../src/services/moderation-policy';
import type { PDU } from '../src/types';

function stateEvent(type: string, content: Record<string, unknown>, stateKey = 'rule'): PDU {
  return {
    type,
    state_key: stateKey,
    content,
    event_id: `$${stateKey}:example.com`,
    room_id: '!policy:example.com',
    sender: '@mod:example.com',
    origin_server_ts: 1,
    auth_events: [],
    prev_events: [],
    depth: 1,
  } as unknown as PDU;
}

const ban = (entity: string, reason = 'reason') => ({
  entity,
  reason,
  recommendation: 'm.ban',
});

describe('rulesFromState', () => {
  it('returns an empty ruleset marked as one subscription for empty state', () => {
    expect(rulesFromState([])).toEqual({ users: [], rooms: [], servers: [], subscriptions: 1 });
  });

  it('buckets m.ban rules by kind, preserving entity and reason', () => {
    const rules = rulesFromState([
      stateEvent('m.policy.rule.user', ban('@spam:evil.example.org', 'spam')),
      stateEvent('m.policy.rule.room', ban('!raid:evil.example.org', 'raid')),
      stateEvent('m.policy.rule.server', ban('*.evil.example.org', 'evil net')),
    ]);
    expect(rules).toEqual({
      users: [{ entity: '@spam:evil.example.org', reason: 'spam', kind: 'user' }],
      rooms: [{ entity: '!raid:evil.example.org', reason: 'raid', kind: 'room' }],
      servers: [{ entity: '*.evil.example.org', reason: 'evil net', kind: 'server' }],
      subscriptions: 1,
    });
  });

  it('ignores non-policy events, non-m.ban recommendations and malformed rules', () => {
    const rules = rulesFromState([
      stateEvent('m.room.member', { membership: 'join' }),
      stateEvent('m.policy.rule.user', {
        entity: '@fine:example.org',
        reason: 'opinion',
        recommendation: 'm.opinion',
      }),
      stateEvent('m.policy.rule.server', { reason: 'no entity', recommendation: 'm.ban' }),
      stateEvent('m.policy.rule.custom', ban('ignored', 'ignored')),
      stateEvent('m.policy.rule.room', ban('!kept:example.org', 'kept')),
    ]);
    expect(rules.users).toEqual([]);
    expect(rules.servers).toEqual([]);
    expect(rules.rooms).toEqual([{ entity: '!kept:example.org', reason: 'kept', kind: 'room' }]);
    expect(rules.subscriptions).toBe(1);
  });

  it('defaults a missing reason to an empty string', () => {
    const rules = rulesFromState([
      stateEvent('m.policy.rule.user', { entity: '@a:b', recommendation: 'm.ban' }),
    ]);
    expect(rules.users).toEqual([{ entity: '@a:b', reason: '', kind: 'user' }]);
  });

  it('does not mutate the supplied state events', () => {
    const event = stateEvent('m.policy.rule.user', ban('@spam:evil.example.org'));
    const before = structuredClone(event);
    rulesFromState([event]);
    expect(event).toEqual(before);
  });
});
