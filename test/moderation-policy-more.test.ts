/**
 * Additional pins for the pure moderation-policy helpers. The existing
 * moderation-policy.test.ts covers the happy paths of parsePolicyRule and
 * '*' globs; this file pins the input-validation branches and the remaining
 * glob semantics ('?' and literal regex metacharacters) that were uncovered.
 */
import { describe, expect, it } from 'vitest';
import {
  isRoomBannedByPolicy,
  isServerBannedByPolicy,
  isUserBannedByPolicy,
  parsePolicyRule,
  rulesFromState,
  type PolicyRules,
} from '../src/services/moderation-policy';
import type { PDU } from '../src/types';

describe('parsePolicyRule — uncovered input validation', () => {
  it('rejects non-object content primitives', () => {
    expect(parsePolicyRule('user', 'm.ban')).toBeNull();
    expect(parsePolicyRule('user', 42)).toBeNull();
    expect(parsePolicyRule('user', true)).toBeNull();
  });

  it('rejects array content (no entity field)', () => {
    expect(parsePolicyRule('user', [])).toBeNull();
  });

  it('rejects an empty or non-string entity', () => {
    expect(parsePolicyRule('user', { entity: '', recommendation: 'm.ban' })).toBeNull();
    expect(parsePolicyRule('user', { entity: 123, recommendation: 'm.ban' })).toBeNull();
    expect(parsePolicyRule('user', { entity: {}, recommendation: 'm.ban' })).toBeNull();
  });

  it('rejects a missing recommendation', () => {
    expect(parsePolicyRule('user', { entity: '@a:b' })).toBeNull();
  });

  it('normalises a non-string reason to an empty string', () => {
    expect(parsePolicyRule('room', { entity: '!r:b', reason: 42, recommendation: 'm.ban' })).toEqual({
      entity: '!r:b',
      reason: '',
      kind: 'room',
    });
  });

  it('preserves the caller-supplied kind and ignores extra fields', () => {
    expect(
      parsePolicyRule('server', {
        entity: 'evil.example.org',
        reason: 'x',
        recommendation: 'm.ban',
        extra: 'ignored',
      })
    ).toEqual({ entity: 'evil.example.org', reason: 'x', kind: 'server' });
  });
});

type PolicyRuleKind = 'user' | 'room' | 'server';

function rulesWithEntity(kind: PolicyRuleKind, entity: string, reason = 'r'): PolicyRules {
  const type = `m.policy.rule.${kind}`;
  const state = [{ type, state_key: 'rule', event_id: '$r', content: { entity, reason, recommendation: 'm.ban' } }] as unknown as PDU[];
  return rulesFromState(state);
}

describe('glob semantics via pure matchers', () => {
  it('supports the single-character "?" wildcard for users and rooms', () => {
    const users = rulesWithEntity('user', '@bot?:evil.example.org');
    expect(isUserBannedByPolicy(users, '@bot1:evil.example.org')?.reason).toBe('r');
    expect(isUserBannedByPolicy(users, '@bot12:evil.example.org')).toBeNull();

    const rooms = rulesWithEntity('room', '!raid-?:evil.example.org');
    expect(isRoomBannedByPolicy(rooms, '!raid-a:evil.example.org')?.reason).toBe('r');
    expect(isRoomBannedByPolicy(rooms, '!raid-ab:evil.example.org')).toBeNull();
  });

  it('treats regex metacharacters in an entity literally', () => {
    const users = rulesWithEntity('user', '@a+b:example.org');
    expect(isUserBannedByPolicy(users, '@a+b:example.org')?.reason).toBe('r');
    // A raw '+' would match one-or-more 'a'; the escaped glob must not.
    expect(isUserBannedByPolicy(users, '@aaab:example.org')).toBeNull();

    const rooms = rulesWithEntity('room', '!a.b:example.org');
    expect(isRoomBannedByPolicy(rooms, '!a.b:example.org')?.reason).toBe('r');
    expect(isRoomBannedByPolicy(rooms, '!axb:example.org')).toBeNull();
  });

  it('lets "*" match an empty span', () => {
    const users = rulesWithEntity('user', '@spam*:example.org');
    expect(isUserBannedByPolicy(users, '@spam:example.org')?.reason).toBe('r');
  });

  it('lowercases the rule entity for server rules before matching', () => {
    const servers = rulesWithEntity('server', '*.SpamHouse.Example.ORG');
    expect(isServerBannedByPolicy(servers, 'sub.spamhouse.example.org')?.reason).toBe('r');
    expect(isServerBannedByPolicy(servers, 'sub.spamhouse.example.org:8448')?.reason).toBe('r');
  });

  it('returns the first matching rule when several globs match', () => {
    const state = [
      { type: 'm.policy.rule.user', state_key: '1', event_id: '$1', content: { entity: '@bad*:example.org', reason: 'first', recommendation: 'm.ban' } },
      { type: 'm.policy.rule.user', state_key: '2', event_id: '$2', content: { entity: '@bad1:example.org', reason: 'second', recommendation: 'm.ban' } },
    ] as unknown as PDU[];
    const rules = rulesFromState(state);
    expect(isUserBannedByPolicy(rules, '@bad1:example.org')?.reason).toBe('first');
  });
});
