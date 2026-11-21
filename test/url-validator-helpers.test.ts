import { describe, it, expect } from 'vitest';
import { validateUrl, validateUrlForPreview } from '../src/utils/url-validator';

const blockedIp = { valid: false, error: 'Access to internal IP addresses is not allowed' };
const blockedHost = { valid: false, error: 'Access to internal hostnames is not allowed' };

// Narrow lane: only cases NOT already pinned by test/url-validator.test.ts or
// test/worker-utils-helpers.test.ts. Both public helpers are exercised through
// validateUrl/validateUrlForPreview because the range helpers are module-private.

describe('SSRF blocked IPv4 range edges not pinned elsewhere', () => {
  it('blocks the lower bound of the loopback and 10/8 ranges', () => {
    expect(validateUrl('http://127.0.0.0/')).toEqual(blockedIp);
    expect(validateUrl('http://10.0.0.0/')).toEqual(blockedIp);
  });

  it('blocks an interior 172.16/12 address and the first host of 192.168/16', () => {
    expect(validateUrl('http://172.20.0.1/')).toEqual(blockedIp);
    expect(validateUrl('http://192.168.0.1/')).toEqual(blockedIp);
  });

  it('blocks the top of link-local 169.254/16', () => {
    expect(validateUrl('http://169.254.255.255/')).toEqual(blockedIp);
  });
});

describe('SSRF decimal / hex / short IPv4 forms', () => {
  it('blocks loopback written as one decimal integer', () => {
    expect(validateUrl('http://2130706433/')).toEqual(blockedIp);
  });

  it('blocks loopback written in hex, octal, and mixed dotted forms', () => {
    expect(validateUrl('http://0x7f000001/')).toEqual(blockedIp);
    expect(validateUrl('http://0177.0.0.1/')).toEqual(blockedIp);
    expect(validateUrl('http://0x7f.0.0.1/')).toEqual(blockedIp);
  });

  it('blocks loopback with omitted octets', () => {
    expect(validateUrl('http://127.1/')).toEqual(blockedIp);
    expect(validateUrl('http://127.0.1/')).toEqual(blockedIp);
  });

  it('blocks the same normalized forms through validateUrlForPreview', () => {
    expect(validateUrlForPreview('http://2130706433/')).toEqual(blockedIp);
    expect(validateUrlForPreview('http://0x7f000001/')).toEqual(blockedIp);
  });
});

describe('SSRF blocked hostname list edges not pinned elsewhere', () => {
  it('blocks uppercase localhost.localdomain', () => {
    expect(validateUrl('http://LOCALHOST.LOCALDOMAIN/')).toEqual(blockedHost);
  });

  it('blocks subdomains of the exact metadata and ip6 hostnames', () => {
    expect(validateUrl('http://x.metadata/')).toEqual(blockedHost);
    expect(validateUrl('http://a.ip6-localhost/')).toEqual(blockedHost);
    expect(validateUrl('http://a.ip6-loopback/')).toEqual(blockedHost);
  });

  it('blocks uppercase IPv4-mapped loopback and mapped broadcast', () => {
    expect(validateUrl('http://[::FFFF:127.0.0.1]/')).toEqual(blockedIp);
    expect(validateUrl('http://[::ffff:255.255.255.255]/')).toEqual(blockedIp);
  });
});

describe('ordinary public URLs are unaffected', () => {
  it('allows a public host with path, query, and fragment', () => {
    const result = validateUrl('https://example.com/a/b?q=1#frag');
    expect(result.valid).toBe(true);
    expect(result.sanitizedUrl).toBe('https://example.com/a/b?q=1#frag');
  });

  it('allows a public IPv4 address outside the blocked ranges', () => {
    expect(validateUrl('http://1.1.1.1/').valid).toBe(true);
  });

  it('allows a public URL with path and query through preview validation', () => {
    const result = validateUrlForPreview('https://example.com/a?q=1');
    expect(result.valid).toBe(true);
    expect(result.sanitizedUrl).toBe('https://example.com/a?q=1');
  });
});
