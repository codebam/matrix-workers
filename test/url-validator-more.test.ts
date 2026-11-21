/**
 * Additional pure-validation coverage for src/utils/url-validator.ts.
 * Complements worker-utils-helpers.test.ts: IPv6 special ranges, exact
 * hostname denylist entries, and preview-mode edges it does not pin.
 * No bindings, no product edits.
 */
import { describe, it, expect } from 'vitest';
import { validateUrl, validateUrlForPreview } from '../src/utils/url-validator';

describe('validateUrl IPv6 special ranges', () => {
  it('blocks loopback ::1 in compressed and expanded form', () => {
    expect(validateUrl('http://[::1]/').valid).toBe(false);
    expect(validateUrl('http://[0:0:0:0:0:0:0:1]/').valid).toBe(false);
  });

  it('blocks the unspecified address in compressed and expanded form', () => {
    expect(validateUrl('http://[::]/').valid).toBe(false);
    expect(validateUrl('http://[0:0:0:0:0:0:0:0]/').valid).toBe(false);
  });

  it('blocks deprecated site-local fec0::/10 through fef0::/10', () => {
    for (const prefix of ['fec0', 'fed0', 'fee0', 'fef0']) {
      expect(validateUrl(`http://[${prefix}::1]/`).valid).toBe(false);
    }
  });

  it('blocks IPv4-mapped hex encoding of loopback (::ffff:7f00:1)', () => {
    expect(validateUrl('http://[::ffff:7f00:1]/').valid).toBe(false);
  });
});

describe('validateUrl hostname denylist edges', () => {
  it('blocks exact internal service hostnames by name', () => {
    for (const host of [
      'ip6-localhost',
      'ip6-loopback',
      'internal',
      'kubernetes.default',
      'metadata.google.internal',
    ]) {
      expect(validateUrl(`http://${host}/`).error).toBe('Access to internal hostnames is not allowed');
    }
  });

  it('does not block hostname lookalikes that merely contain a blocked name', () => {
    for (const host of ['notlocalhost.example.com', 'myinternal.example.com', 'localhost.example.com']) {
      expect(validateUrl(`http://${host}/`).valid).toBe(true);
    }
  });
});

describe('validateUrl boundary + malformed-input edges', () => {
  it('blocks the low edge of 10/8 and the high edge of 172.16/12, allows just outside 10/8', () => {
    expect(validateUrl('http://10.0.0.0/').valid).toBe(false);
    expect(validateUrl('http://172.31.255.255/').valid).toBe(false);
    expect(validateUrl('http://9.255.255.255/').valid).toBe(true);
  });

  it('returns Invalid URL format for malformed input', () => {
    expect(validateUrl('not a url').error).toBe('Invalid URL format');
  });
});

describe('validateUrlForPreview extra edges', () => {
  it('rejects a non-allowlisted custom port with the exact preview error', () => {
    expect(validateUrlForPreview('http://example.com:3000/').error).toBe(
      'Only standard HTTP ports (80, 443, 8080, 8443) are allowed for URL preview'
    );
  });

  it('propagates malformed-input and SSRF failures unchanged', () => {
    expect(validateUrlForPreview('not a url')).toEqual(validateUrl('not a url'));
    expect(validateUrlForPreview('http://[::1]/')).toEqual(validateUrl('http://[::1]/'));
  });
});
