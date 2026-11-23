/**
 * extractAccessToken — header-only credential extraction.
 *
 * Spec v1.20 (breaking): "Sending the access token as a query string parameter
 * is no longer supported." This suite pins the header grammar and, explicitly,
 * that a query-string token is never treated as a credential. (The previous
 * query-fallback fuzz corpus was removed with the behaviour it described.)
 */
import { describe, it, expect } from 'vitest';
import { extractAccessToken } from '../src/middleware/auth';

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe('extractAccessToken — Authorization header', () => {
  it('reads a Bearer token', () => {
    expect(extractAccessToken(req('https://m.example/_matrix/client/v3/sync', {
      Authorization: 'Bearer syt_secret_token',
    }))).toBe('syt_secret_token');
  });

  it('is case-insensitive on the Bearer scheme', () => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      expect(extractAccessToken(req('https://m.example/', {
        Authorization: `${scheme} tok`,
      }))).toBe('tok');
    }
  });

  it('accepts ASCII whitespace between the scheme and the token', () => {
    for (const sep of [' ', '   ', '\t', '\v', '\f']) {
      expect(extractAccessToken(req('https://m.example/', {
        Authorization: `Bearer${sep}tok`,
      }))).toBe('tok');
    }
  });

  it('preserves interior spaces and punctuation in the greedy capture', () => {
    expect(extractAccessToken(req('https://m.example/', {
      Authorization: 'Bearer tok with spaces',
    }))).toBe('tok with spaces');
    expect(extractAccessToken(req('https://m.example/', {
      Authorization: 'Bearer Bearer xyz',
    }))).toBe('Bearer xyz');
    expect(extractAccessToken(req('https://m.example/', {
      Authorization: 'Bearer =abc,def;ghi',
    }))).toBe('=abc,def;ghi');
  });

  it('preserves long and Latin-1 tokens without truncation', () => {
    const long = `syt_${'x'.repeat(4096)}`;
    expect(extractAccessToken(req('https://m.example/', {
      Authorization: `Bearer ${long}`,
    }))).toBe(long);
    expect(extractAccessToken(req('https://m.example/', {
      Authorization: 'Bearer tökén',
    }))).toBe('tökén');
  });

  it('returns null without an Authorization header', () => {
    expect(extractAccessToken(req('https://m.example/'))).toBeNull();
  });

  it('returns null for malformed headers', () => {
    for (const value of ['Basic abc', 'Bearer', 'Bearer ', 'Bearer\t', 'Bearerx tok', 'NotBearer tok']) {
      expect(extractAccessToken(req('https://m.example/', { Authorization: value }))).toBeNull();
    }
  });

  it('does not accept header names other than Authorization', () => {
    expect(extractAccessToken(req('https://m.example/', { 'X-Authorization': 'Bearer tok' }))).toBeNull();
  });

  it('method and body do not affect extraction', () => {
    const r = new Request('https://m.example/', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: '{}',
    });
    expect(extractAccessToken(r)).toBe('tok');
  });
});

describe('extractAccessToken — query strings are not credentials (spec v1.20)', () => {
  it('ignores a query-only token', () => {
    expect(extractAccessToken(req('https://m.example/_matrix/client/v3/sync?access_token=query_token')))
      .toBeNull();
  });

  it('ignores a percent-encoded or empty query token', () => {
    expect(extractAccessToken(req('https://m.example/?access_token=t%C3%B6k'))).toBeNull();
    expect(extractAccessToken(req('https://m.example/?access_token='))).toBeNull();
    expect(extractAccessToken(req('https://m.example/?access_token=%20'))).toBeNull();
  });

  it('ignores query duplicates and unrelated parameters', () => {
    expect(extractAccessToken(req(
      'https://m.example/?foo=1&access_token=first&access_token=second'
    ))).toBeNull();
  });

  it('ignores a non-Bearer Authorization scheme plus a query token', () => {
    for (const scheme of ['Basic', 'Digest', 'Token', 'MAC', 'Negotiate']) {
      expect(extractAccessToken(req('https://m.example/?access_token=from_query', {
        Authorization: `${scheme} abc`,
      }))).toBeNull();
    }
  });

  it('still uses the header when both a header and a query token are present', () => {
    expect(extractAccessToken(req('https://m.example/?access_token=from_query', {
      Authorization: 'Bearer from_header',
    }))).toBe('from_header');
  });

  it('ignores URL fragments that look like a token', () => {
    expect(extractAccessToken(req('https://m.example/#access_token=from_fragment'))).toBeNull();
  });

  it('ignores path segments named access_token', () => {
    expect(extractAccessToken(req('https://m.example/access_token/tok'))).toBeNull();
  });

  it('resolves parallel header∥query∥missing requests independently', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        if (i % 3 === 0) return extractAccessToken(req(`https://m.example/?access_token=q${i}`));
        if (i % 3 === 1) {
          return extractAccessToken(req('https://m.example/', { Authorization: `Bearer h${i}` }));
        }
        return extractAccessToken(req('https://m.example/'));
      })
    );
    for (let i = 0; i < results.length; i++) {
      if (i % 3 === 0) expect(results[i]).toBeNull();
      else if (i % 3 === 1) expect(results[i]).toBe(`h${i}`);
      else expect(results[i]).toBeNull();
    }
  });
});
