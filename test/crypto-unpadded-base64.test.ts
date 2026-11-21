import { describe, it, expect } from 'vitest';
import { encodeUnpaddedBase64 } from '../src/utils/crypto';

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe('encodeUnpaddedBase64', () => {
  it('returns an empty string for empty input', () => {
    expect(encodeUnpaddedBase64(new Uint8Array(0))).toBe('');
  });

  it('encodes 1-, 2- and 3-byte groups without padding', () => {
    expect(encodeUnpaddedBase64(bytesOf('f'))).toBe('Zg');
    expect(encodeUnpaddedBase64(bytesOf('fo'))).toBe('Zm8');
    expect(encodeUnpaddedBase64(bytesOf('foo'))).toBe('Zm9v');
  });

  it('uses the standard alphabet, keeping + and / instead of - and _', () => {
    expect(encodeUnpaddedBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8');
    expect(encodeUnpaddedBase64(new Uint8Array([0xff]))).toBe('/w');
  });

  it('never emits = padding across arbitrary byte lengths', () => {
    for (let len = 0; len <= 12; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const out = encodeUnpaddedBase64(bytes);
      expect(out).not.toContain('=');
      expect(out).toBe(btoa(String.fromCharCode(...bytes)).replace(/=/g, ''));
    }
  });

  it('encodes a full 256-byte sweep deterministically without padding', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const first = encodeUnpaddedBase64(bytes);
    expect(encodeUnpaddedBase64(bytes)).toBe(first);
    expect(first).not.toContain('=');
    expect(first.length).toBe(Math.ceil((256 * 8) / 6));
  });
});
