import { describe, it, expect } from 'vitest';
import { encodeUnpaddedBase64, base64UrlEncode } from '../src/utils/crypto';

describe('encodeUnpaddedBase64', () => {
	it('uses the standard alphabet and drops padding', () => {
		expect(encodeUnpaddedBase64(new Uint8Array([0xfb, 0xff]))).toBe('+/8');
		expect(encodeUnpaddedBase64(new Uint8Array([0xff]))).toBe('/w');
		expect(encodeUnpaddedBase64(new Uint8Array([0xff, 0xff, 0xff]))).toBe('////');
	});

	it('returns an empty string for no bytes', () => {
		expect(encodeUnpaddedBase64(new Uint8Array())).toBe('');
	});

	it('keeps + and / where the URL-safe variant emits - and _', () => {
		const bytes = new Uint8Array([0xfb, 0xff]);
		expect(encodeUnpaddedBase64(bytes)).toBe('+/8');
		expect(base64UrlEncode(bytes)).toBe('-_8');
	});

	it('encodes 32 zero bytes as the unpadded Matrix signature length', () => {
		const encoded = encodeUnpaddedBase64(new Uint8Array(32));
		expect(encoded).toBe('A'.repeat(43));
		expect(encoded).not.toContain('=');
	});
});
