import { describe, it, expect } from 'vitest';
import {
  base64UrlEncode,
  base64UrlDecode,
  formatUserId,
  parseUserId,
  formatRoomAlias,
  parseRoomAlias,
  parseRoomId,
} from '../src/utils/ids';

describe('ids pure helpers — uncovered edges', () => {
  it('base64url uses - and _ and drops = with an exact known-answer vector', () => {
    // Standard base64 of [0xfb, 0xff] is "+/8="; the URL-safe form is "-_8".
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(Array.from(base64UrlDecode('-_8'))).toEqual([0xfb, 0xff]);
  });

  it('round-trips bytes whose standard base64 needs trailing padding', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const enc = base64UrlEncode(bytes);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(enc))).toEqual(Array.from(bytes));
  });

  it('rejects IDs with an empty server segment after the colon', () => {
    expect(parseUserId('@alice:' as '@a:b')).toBeNull();
    expect(parseRoomId('!opaque:' as '!a:b')).toBeNull();
    expect(parseRoomAlias('#alias:' as '#a:b')).toBeNull();
  });

  it('rejects empty strings and bare sigils', () => {
    expect(parseUserId('' as '@a:b')).toBeNull();
    expect(parseRoomId('' as '!a:b')).toBeNull();
    expect(parseRoomAlias('' as '#a:b')).toBeNull();
    expect(parseUserId('@' as '@a:b')).toBeNull();
    expect(parseRoomId('!' as '!a:b')).toBeNull();
    expect(parseRoomAlias('#' as '#a:b')).toBeNull();
  });

  it('round-trips format/parse when the server name contains a port', () => {
    const userId = formatUserId('alice', 'example.com:8448');
    expect(userId).toBe('@alice:example.com:8448');
    expect(parseUserId(userId)).toEqual({ localpart: 'alice', serverName: 'example.com:8448' });

    const alias = formatRoomAlias('general', 'example.com:8448');
    expect(alias).toBe('#general:example.com:8448');
    expect(parseRoomAlias(alias)).toEqual({ localpart: 'general', serverName: 'example.com:8448' });

    const roomId = '!opaque:example.com:8448' as '!a:b';
    expect(parseRoomId(roomId)).toEqual({ opaque: 'opaque', serverName: 'example.com:8448' });
  });

  it('round-trips a localpart containing . - _ = / through format/parse', () => {
    const localpart = 'a.b_c=d/e';
    expect(parseUserId(formatUserId(localpart, 'example.com'))).toEqual({
      localpart,
      serverName: 'example.com',
    });
    expect(parseRoomAlias(formatRoomAlias(localpart, 'example.com'))).toEqual({
      localpart,
      serverName: 'example.com',
    });
  });
});
