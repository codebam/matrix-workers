import { describe, it, expect } from 'vitest';
import { validateUrl } from '../src/utils/url-validator';

describe('validateUrl fully-qualified (trailing-dot) hostnames', () => {
  it('rejects exact blocked hostnames with a trailing dot', () => {
    expect(validateUrl('http://localhost./').valid).toBe(false);
    expect(validateUrl('http://metadata.google.internal./').valid).toBe(false);
  });

  it('rejects subdomains of blocked hostnames with a trailing dot', () => {
    expect(validateUrl('http://foo.localhost./').valid).toBe(false);
    expect(validateUrl('http://x.metadata.google.internal./').valid).toBe(false);
  });

  it('rejects .local and .internal hostnames with a trailing dot', () => {
    expect(validateUrl('http://svc.local./').valid).toBe(false);
    expect(validateUrl('http://db.internal./').valid).toBe(false);
  });

  it('allows public hostnames with a trailing dot', () => {
    expect(validateUrl('https://example.com./').valid).toBe(true);
  });
});
