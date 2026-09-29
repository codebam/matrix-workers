import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { federationFetch, isFetchSupportedUrl } from '../src/services/federation-http';

// These tests run in Node, where cloudflare:sockets does not exist. They
// cover (a) the port allowlist that decides between fetch() and the socket
// transport, and (b) the graceful fallback to fetch() when the sockets module
// cannot be loaded — the same path dev/test environments take. The socket
// transport itself is covered in federation-socket-transport.test.ts.

describe('isFetchSupportedUrl', () => {
  it('accepts the documented fetch() port allowlist', () => {
    expect(isFetchSupportedUrl(new URL('https://h.example/'))).toBe(true); // implicit 443
    expect(isFetchSupportedUrl(new URL('https://h.example:443/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('https://h.example:8443/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('https://h.example:2053/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('https://h.example:2083/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('https://h.example:2087/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('https://h.example:2096/'))).toBe(true);
    expect(isFetchSupportedUrl(new URL('http://h.example:8080/'))).toBe(true);
  });

  it('rejects the Matrix default port 8448 and other arbitrary ports', () => {
    expect(isFetchSupportedUrl(new URL('https://h.example:8448/'))).toBe(false);
    expect(isFetchSupportedUrl(new URL('https://h.example:8449/'))).toBe(false);
    expect(isFetchSupportedUrl(new URL('https://h.example:9999/'))).toBe(false);
  });
});

describe('federationFetch transport selection', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes allowlisted ports straight through to fetch()', async () => {
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    const res = await federationFetch('https://peer.example:8443/_matrix/key/v2/server', init);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://peer.example:8443/_matrix/key/v2/server', init);
  });

  it('falls back to fetch() when cloudflare:sockets is unavailable', async () => {
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    fetchMock.mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    const url = 'https://peer.example:8448/_matrix/key/v2/server';

    const res = await federationFetch(url, init);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, init);
  });
});
