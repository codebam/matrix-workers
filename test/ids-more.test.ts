/**
 * Additional pure-helper coverage for src/utils/ids.ts.
 * Complements worker-utils-helpers.test.ts: formatting/parsing edges and
 * validation/determinism cases it does not pin. No bindings, no product edits.
 */
import { describe, it, expect } from 'vitest';
import {
  formatUserId,
  parseUserId,
  formatRoomAlias,
  parseRoomAlias,
  parseRoomId,
  isValidLocalpart,
  isValidServerName,
  getServerName,
  base64UrlEncode,
  base64UrlDecode,
  generateDeterministicEventId,
} from '../src/utils/ids';

describe('ids formatRoomAlias / parse edges', () => {
  it('format helpers interpolate without validating, so empty/embedded colons survive', () => {
    expect(formatUserId('', 'ex.com')).toBe('@:ex.com');
    expect(formatRoomAlias('', 'ex.com')).toBe('#:ex.com');
    expect(formatRoomAlias('a:b', 'ex.com')).toBe('#a:b:ex.com');
  });

  it('parse helpers reject empty localpart or empty server components', () => {
    expect(parseUserId('@u:')).toBeNull();
    expect(parseRoomId('!:ex.com')).toBeNull();
    expect(parseRoomAlias('#:ex.com')).toBeNull();
  });

  it('parseRoomAlias uses a greedy server group for colons and ports', () => {
    expect(parseRoomAlias('#a:b:ex.com')).toEqual({ localpart: 'a', serverName: 'b:ex.com' });
    expect(parseRoomAlias(formatRoomAlias('general', 'ex.com:8448'))).toEqual({
      localpart: 'general',
      serverName: 'ex.com:8448',
    });
  });

  it('getServerName returns null for a trailing colon with no server', () => {
    expect(getServerName('a:')).toBeNull();
  });

  it('base64Url helpers handle empty input', () => {
    expect(base64UrlEncode(new Uint8Array(0))).toBe('');
    expect(Array.from(base64UrlDecode(''))).toEqual([]);
  });
});

describe('ids validation edges not pinned elsewhere', () => {
  it('isValidLocalpart rejects uppercase letters (regex is lowercase-only)', () => {
    expect(isValidLocalpart('Alice')).toBe(false);
    expect(isValidLocalpart('aBc')).toBe(false);
  });

  it('isValidServerName accepts bracketed IPv6 with a port but not bare/unterminated forms', () => {
    expect(isValidServerName('[::1]:8448')).toBe(true);
    expect(isValidServerName('::1')).toBe(false);
    expect(isValidServerName('[::1]:')).toBe(false);
  });

  it('isValidServerName requires a numeric port and allows uppercase hosts', () => {
    expect(isValidServerName('ex.com:abc')).toBe(false);
    expect(isValidServerName('EXAMPLE.COM')).toBe(true);
  });
});

describe('generateDeterministicEventId pure formatting extras', () => {
  const ts = 1_700_000_000_000;

  it('ignores serverName for modern formats but uses it as the v1 suffix', async () => {
    const modernA = await generateDeterministicEventId('a.com', '!r:x', '@u:x', 'join', ts, 1, '10');
    const modernB = await generateDeterministicEventId('b.com', '!r:x', '@u:x', 'join', ts, 1, '10');
    expect(modernA).toBe(modernB);

    const v1A = await generateDeterministicEventId('a.com', '!r:x', '@u:x', 'join', ts, 1, '1');
    const v1B = await generateDeterministicEventId('b.com', '!r:x', '@u:x', 'join', ts, 1, '1');
    expect(v1A).not.toBe(v1B);
    expect(v1A.endsWith(':a.com')).toBe(true);
    expect(v1B.endsWith(':b.com')).toBe(true);
  });

  it('rounds on exact bucket boundaries (bucketSeconds=10)', async () => {
    const on = await generateDeterministicEventId('ex.com', '!r:x', '@u:x', 'join', ts, 10, '10');
    const before = await generateDeterministicEventId('ex.com', '!r:x', '@u:x', 'join', ts - 1, 10, '10');
    const within = await generateDeterministicEventId('ex.com', '!r:x', '@u:x', 'join', ts + 9_999, 10, '10');
    expect(before).not.toBe(on);
    expect(within).toBe(on);
  });
});
