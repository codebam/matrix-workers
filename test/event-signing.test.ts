import { describe, expect, it } from 'vitest';
import {
  computeEventReferenceHash,
  computeWireEventId,
  eventSigningCanonicalJson,
  redactEventForSigning,
  toWireEventObject,
} from '../src/utils/event-signing';

function memberEvent(overrides: Record<string, unknown> = {}) {
  return {
    room_id: '!room:example.com',
    sender: '@alice:example.com',
    type: 'm.room.member',
    state_key: '@alice:example.com',
    content: {
      membership: 'join',
      displayname: 'Alice',
      avatar_url: 'mxc://example.com/abc',
      reason: 'because',
    },
    origin_server_ts: 1700000000000,
    depth: 5,
    auth_events: ['$invite:example.com'],
    prev_events: ['$prev:example.com'],
    hashes: { sha256: 'content-hash' },
    signatures: { 'example.com': { 'ed25519:1': 'sig' } },
    unsigned: { age: 12 },
    ...overrides,
  } as Record<string, unknown>;
}

describe('redactEventForSigning', () => {
  it('keeps only the redaction-allowed keys for m.room.member content', () => {
    const redacted = redactEventForSigning(memberEvent());
    expect(redacted.content).toEqual({ membership: 'join' });
    // Non-content non-essential fields are dropped too.
    expect(redacted.unsigned).toBeUndefined();
  });

  it('keeps top-level fields required for verification', () => {
    const redacted = redactEventForSigning(memberEvent());
    expect(redacted.room_id).toBe('!room:example.com');
    expect(redacted.sender).toBe('@alice:example.com');
    expect(redacted.state_key).toBe('@alice:example.com');
    expect(redacted.depth).toBe(5);
    expect(redacted.auth_events).toEqual(['$invite:example.com']);
    expect(redacted.prev_events).toEqual(['$prev:example.com']);
    expect(redacted.origin_server_ts).toBe(1700000000000);
    expect(redacted.hashes).toEqual({ sha256: 'content-hash' });
    expect(redacted.signatures).toEqual({ 'example.com': { 'ed25519:1': 'sig' } });
  });

  it('strips message content entirely', () => {
    const redacted = redactEventForSigning(
      memberEvent({ type: 'm.room.message', content: { body: 'hello', msgtype: 'm.text' } })
    );
    expect(redacted.content).toEqual({});
  });

  it('keeps full content for m.room.create', () => {
    const redacted = redactEventForSigning(
      memberEvent({ type: 'm.room.create', content: { room_version: '12', extra: true } })
    );
    expect(redacted.content).toEqual({ room_version: '12', extra: true });
  });

  it('keeps only known keys for m.room.join_rules / power_levels', () => {
    const jr = redactEventForSigning(
      memberEvent({ type: 'm.room.join_rules', content: { join_rule: 'invite', extra: 1 } })
    );
    expect(jr.content).toEqual({ join_rule: 'invite' });

    const pl = redactEventForSigning(
      memberEvent({
        type: 'm.room.power_levels',
        content: { users: { '@a:example.com': 100 }, users_default: 0, extra: 1 },
      })
    );
    expect(pl.content).toEqual({ users: { '@a:example.com': 100 }, users_default: 0 });
  });

  it('drops unknown top-level fields', () => {
    const redacted = redactEventForSigning(memberEvent({ some_future_field: 'x' }));
    expect('some_future_field' in redacted).toBe(false);
  });
});

describe('eventSigningCanonicalJson / reference hash', () => {
  it('excludes signatures and unsigned but keeps hashes', () => {
    const canonical = eventSigningCanonicalJson(memberEvent());
    expect(canonical).not.toContain('signatures');
    expect(canonical).not.toContain('unsigned');
    expect(canonical).toContain('content-hash');
  });

  it('hashes the same event identically and changes with content', async () => {
    const a = await computeEventReferenceHash(memberEvent());
    const b = await computeEventReferenceHash(memberEvent());
    const c = await computeEventReferenceHash(
      memberEvent({ content: { membership: 'leave' } })
    );
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('produces URL-safe, $-prefixed event IDs', async () => {
    const id = await computeWireEventId(memberEvent());
    expect(id).toMatch(/^\$[A-Za-z0-9_-]{43}$/);
  });
});

describe('toWireEventObject', () => {
  it('strips event_id for the wire', () => {
    const wire = toWireEventObject(memberEvent({ event_id: '$local:example.com' }));
    expect('event_id' in wire).toBe(false);
    expect(wire.room_id).toBe('!room:example.com');
  });
});
