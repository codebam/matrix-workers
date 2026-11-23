/**
 * MSC4108 insecure rendezvous session transport — unstable endpoint
 *   POST|GET|PUT|DELETE /_matrix/client/unstable/org.matrix.msc4108/rendezvous[/:id]
 *
 * Pinned spec revision (MSC4108, "Insecure rendezvous session", "API",
 * "Maximum payload size", "ETags" and "Unstable prefix"):
 * https://raw.githubusercontent.com/matrix-org/matrix-spec-proposals/87f8317a902cd7bc5c2d2d225f71021b3a509e2d/proposals/4108-oidc-qr-login.md
 *
 * Contract under test (from that revision):
 *  - POST text/plain -> 201 JSON {url}; url is the absolute rendezvous URL.
 *  - Common response headers on 201/200/304/202/412: ETag, Expires,
 *    Last-Modified, Cache-Control: no-store, Pragma: no-cache.
 *  - PUT requires a strong, single-valued If-Match ETag; stale -> 412 with
 *    errcode M_UNKNOWN plus org.matrix.msc4108.errcode = M_CONCURRENT_WRITE
 *    (the unstable-prefix rule for brand-new errcodes).
 *  - Maximum payload size is 4KB (4096 bytes).
 *  - Sessions are short-lived, unauthenticated, and cancelled with DELETE.
 *
 * Tests intentionally assert only the wire contract plus KV namespace
 * isolation, so they can be run against the transport once it is integrated.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import rendezvous from '../src/api/rendezvous';

const SPEC_URL =
  'https://raw.githubusercontent.com/matrix-org/matrix-spec-proposals/87f8317a902cd7bc5c2d2d225f71021b3a509e2d/proposals/4108-oidc-qr-login.md';

const PREFIX = '/_matrix/client/unstable/org.matrix.msc4108/rendezvous';
const SERVER_NAME = 'example.com';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

type MockKv = KVNamespace & { data: Record<string, string> };

/** Same in-memory KV convention as the existing rendezvous tests. */
function mockKv(): MockKv {
  const data: Record<string, string> = {};
  return {
    data,
    get: async (key: string, type?: string) => {
      const raw = data[key];
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string, _options?: { expirationTtl?: number }) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as MockKv;
}

function envFor(sessions: MockKv): Env {
  return { SESSIONS: sessions, SERVER_NAME } as unknown as Env;
}

async function req(path: string, init: RequestInit = {}, env: Env = envFor(mockKv())) {
  const res = await rendezvous.request(`https://${SERVER_NAME}${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, headers: res.headers };
}

function plainInit(method: 'POST' | 'PUT', body: string, extra: Record<string, string> = {}): RequestInit {
  // Hono's app.request() does not synthesise Content-Length for string bodies;
  // MSC4108 lists it as a required request header on POST and PUT.
  return {
    method,
    headers: {
      'Content-Type': 'text/plain',
      'Content-Length': String(new TextEncoder().encode(body).length),
      ...extra,
    },
    body,
  };
}

/**
 * MSC4108 "Common HTTP response headers" are mandatory on 201/200/304/202/412.
 * Returns the strong ETag so callers can chain If-Match / If-None-Match checks.
 */
function expectCommonHeaders(headers: Headers, where: string): string {
  for (const name of ['ETag', 'Expires', 'Last-Modified', 'Cache-Control', 'Pragma']) {
    expect(headers.get(name), `${where}: missing ${name} (${SPEC_URL})`).not.toBeNull();
  }
  expect(headers.get('Cache-Control'), `${where}: caches must not rewrite ETags`).toBe('no-store');
  expect(headers.get('Pragma'), `${where}: caches must not rewrite ETags`).toBe('no-cache');
  expect(Number.isNaN(Date.parse(headers.get('Expires')!)), `${where}: Expires is an HTTP-date`).toBe(false);
  expect(Number.isNaN(Date.parse(headers.get('Last-Modified')!)), `${where}: Last-Modified is an HTTP-date`).toBe(false);

  const etag = headers.get('ETag')!;
  // MSC4108 "ETags": only strong, single-valued ETags are accepted.
  expect(etag.startsWith('W/'), `${where}: ETag must be strong`).toBe(false);
  expect(etag.includes(','), `${where}: ETag must be single-valued`).toBe(false);
  return etag;
}

/** Parse the absolute rendezvous URL from a 201 response into a request path. */
function sessionPath(created: { body: any }): { path: string; id: string } {
  const parsed = new URL(created.body.url); // throws unless the URL is absolute
  expect(parsed.protocol).toBe('https:');
  expect(parsed.host).toBe(SERVER_NAME);
  expect(parsed.pathname.startsWith(`${PREFIX}/`)).toBe(true);
  const id = parsed.pathname.slice(PREFIX.length + 1);
  expect(id.length).toBeGreaterThan(0);
  expect(id).not.toContain('/');
  return { path: `${PREFIX}/${id}`, id };
}

describe('MSC4108 rendezvous transport', () => {
  it('POST text/plain creates a session: 201 + {url} + required cache headers', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);
    const payload = 'Hello from A';

    const created = await req(PREFIX, plainInit('POST', payload), env);

    expect(created.status).toBe(201);
    expect(created.headers.get('Content-Type')).toMatch(/^application\/json/);
    // MSC4108: "a JSON object with a single key `url` whose value is the
    // absolute URL of the rendezvous session".
    expect(created.body).toEqual({ url: expect.any(String) });
    expect(Object.keys(created.body)).toEqual(['url']);
    const { path } = sessionPath(created);
    expectCommonHeaders(created.headers, 'POST 201');

    // The URL is immediately usable by the other device.
    const got = await req(path, {}, env);
    expect(got.status).toBe(200);
    expect(got.text).toBe(payload);
  });

  it('POST validates Content-Type, missing body and the 4096-byte cap', async () => {
    const env = envFor(mockKv());

    // MSC4108: invalid Content-Type -> 400 M_INVALID_PARAM.
    const wrongType = await req(
      PREFIX,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '13' }, body: '{"data":"x"}' },
      env
    );
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.errcode).toBe('M_INVALID_PARAM');

    // MSC4108: missing required header/body -> 400 M_MISSING_PARAM.
    const noBody = await req(PREFIX, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, env);
    expect(noBody.status).toBe(400);
    expect(noBody.body.errcode).toBe('M_MISSING_PARAM');

    // Explicit Content-Length but no Content-Type is likewise a missing param.
    const noType = await req(
      PREFIX,
      { method: 'POST', headers: { 'Content-Length': '1' }, body: new Uint8Array([120]) },
      env
    );
    expect(noType.status).toBe(400);
    expect(noType.body.errcode).toBe('M_MISSING_PARAM');

    // MSC4108: "The server enforce a maximum payload size of 4KB".
    const tooLarge = await req(PREFIX, plainInit('POST', 'x'.repeat(4097)), env);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.errcode).toBe('M_TOO_LARGE');

    // Exactly 4096 bytes is accepted.
    const atLimit = await req(PREFIX, plainInit('POST', 'x'.repeat(4096)), env);
    expect(atLimit.status).toBe(201);
  });

  it('GET returns the exact payload, 304 on If-None-Match, 404 for an unknown id', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);
    const payload = 'MATRIX_QR_CODE_LOGIN_INITIATE|some-base64';
    const created = await req(PREFIX, plainInit('POST', payload), env);
    expect(created.status).toBe(201);
    const { path } = sessionPath(created);
    const etag = expectCommonHeaders(created.headers, 'POST 201');

    const got = await req(path, {}, env);
    expect(got.status).toBe(200);
    expect(got.text).toBe(payload);
    expect(got.headers.get('Content-Type')).toMatch(/^text\/plain/);
    expect(got.headers.get('ETag')).toBe(etag);
    expectCommonHeaders(got.headers, 'GET 200');

    // MSC4108: "304 Not Modified - when If-None-Match is supplied and the
    // ETag matched the existing payload" (with the common headers).
    const notModified = await req(path, { headers: { 'If-None-Match': etag } }, env);
    expect(notModified.status).toBe(304);
    expectCommonHeaders(notModified.headers, 'GET 304');

    const missing = await req(`${PREFIX}/${UNKNOWN_ID}`, {}, env);
    expect(missing.status).toBe(404);
    expect(missing.body.errcode).toBe('M_NOT_FOUND');
  });

  it('PUT with matching If-Match: 202 + new ETag, visible on the next GET', async () => {
    const env = envFor(mockKv());
    const created = await req(PREFIX, plainInit('POST', 'Hello from A'), env);
    const { path } = sessionPath(created);
    const firstEtag = expectCommonHeaders(created.headers, 'POST 201');

    const nextPayload = 'MATRIX_QR_CODE_LOGIN_OK';
    const wrote = await req(path, plainInit('PUT', nextPayload, { 'If-Match': firstEtag }), env);

    expect(wrote.status).toBe(202);
    const secondEtag = expectCommonHeaders(wrote.headers, 'PUT 202');
    expect(secondEtag).not.toBe(firstEtag); // new revision -> new ETag

    const got = await req(path, {}, env);
    expect(got.status).toBe(200);
    expect(got.text).toBe(nextPayload);
    expect(got.headers.get('ETag')).toBe(secondEtag);
  });

  it('PUT rejects stale/missing/malformed If-Match and unknown ids', async () => {
    const env = envFor(mockKv());
    const created = await req(PREFIX, plainInit('POST', 'Hello from A'), env);
    const { path } = sessionPath(created);
    const firstEtag = expectCommonHeaders(created.headers, 'POST 201');

    const wrote = await req(path, plainInit('PUT', 'Hello from B', { 'If-Match': firstEtag }), env);
    expect(wrote.status).toBe(202);
    const currentEtag = expectCommonHeaders(wrote.headers, 'PUT 202');

    // MSC4108 "Unstable prefix": new M_CONCURRENT_WRITE errcode is carried in
    // org.matrix.msc4108.errcode while errcode itself is M_UNKNOWN.
    const stale = await req(path, plainInit('PUT', 'stale write', { 'If-Match': firstEtag }), env);
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({
      errcode: 'M_UNKNOWN',
      'org.matrix.msc4108.errcode': 'M_CONCURRENT_WRITE',
    });
    expectCommonHeaders(stale.headers, 'PUT 412');
    expect((await req(path, {}, env)).text).toBe('Hello from B'); // failed CAS is a no-op

    const noIfMatch = await req(path, plainInit('PUT', 'no header'), env);
    expect(noIfMatch.status).toBe(400);
    expect(noIfMatch.body.errcode).toBe('M_MISSING_PARAM');

    // MSC4108: "we only accept strong, single-valued ETag values".
    const weak = await req(path, plainInit('PUT', 'weak', { 'If-Match': `W/${currentEtag}` }), env);
    expect(weak.status).toBe(400);
    expect(weak.body.errcode).toBe('M_INVALID_PARAM');
    const list = await req(path, plainInit('PUT', 'list', { 'If-Match': `"a", ${currentEtag}` }), env);
    expect(list.status).toBe(400);
    expect(list.body.errcode).toBe('M_INVALID_PARAM');

    const missing = await req(
      `${PREFIX}/${UNKNOWN_ID}`,
      plainInit('PUT', 'nobody here', { 'If-Match': currentEtag }),
      env
    );
    expect(missing.status).toBe(404);
    expect(missing.body.errcode).toBe('M_NOT_FOUND');
  });

  it('DELETE cancels a session: 204 then GET is 404', async () => {
    const env = envFor(mockKv());
    const created = await req(PREFIX, plainInit('POST', 'cancel me'), env);
    const { path } = sessionPath(created);

    const deleted = await req(path, { method: 'DELETE' }, env);
    expect(deleted.status).toBe(204);

    const gone = await req(path, {}, env);
    expect(gone.status).toBe(404);
    expect(gone.body.errcode).toBe('M_NOT_FOUND');

    const again = await req(path, { method: 'DELETE' }, env);
    expect(again.status).toBe(404);
    expect(again.body.errcode).toBe('M_NOT_FOUND');
  });

  it('a session whose stored expires value has passed is a 404 (no timers)', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);
    const created = await req(PREFIX, plainInit('POST', 'expiring'), env);
    const { path } = sessionPath(created);
    const etag = created.headers.get('ETag')!;

    const key = Object.keys(sessions.data).find((k) => k.includes('msc4108'))!;
    const stored = JSON.parse(sessions.data[key]);
    expect(stored.expires).toBeGreaterThan(Date.now());
    // MSC4108 "Expiry": after the expiry time, queries and updates MUST fail.
    sessions.data[key] = JSON.stringify({ ...stored, expires: Date.now() - 1000 });

    expect((await req(path, {}, env)).status).toBe(404);
    expect((await req(path, plainInit('PUT', 'too late', { 'If-Match': etag }), env)).status).toBe(404);
  });

  it('uses a KV namespace that cannot collide with rendezvous: / rendezvous:v1: keys', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);

    // Seed one session of each existing transport in the same KV namespace.
    const legacy = await req('/_matrix/client/unstable/org.matrix.msc3886/rendezvous', {
      method: 'POST',
      headers: { 'Content-Length': '0' },
    }, env);
    expect(legacy.status).toBe(201);
    const v1 = await req('/_matrix/client/v1/rendezvous', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: '' }),
    }, env);
    expect(v1.status).toBe(200);
    const preExisting = Object.keys(sessions.data);
    expect(preExisting.length).toBe(2);

    const created = await req(PREFIX, plainInit('POST', 'namespaced'), env);
    expect(created.status).toBe(201);
    const { path, id } = sessionPath(created);

    const after = Object.keys(sessions.data);
    expect(after.length).toBe(preExisting.length + 1);
    const added = after.filter((key) => !preExisting.includes(key));
    expect(added).toHaveLength(1);
    const msc4108Key = added[0];
    expect(msc4108Key).toContain(id);
    // The legacy byte channel uses `rendezvous:<id>` and MSC4388 uses
    // `rendezvous:v1:<prefix>:<id>`; MSC4108 must live in its own namespace.
    expect(msc4108Key).not.toBe(`rendezvous:${id}`);
    expect(msc4108Key.startsWith('rendezvous:v1:')).toBe(false);
    expect(msc4108Key).toContain('msc4108');

    // Existing sessions are untouched, and the new id is not readable through
    // either older transport.
    for (const key of preExisting) expect(sessions.data[key]).toBeDefined();
    expect((await req(`/_matrix/client/unstable/org.matrix.msc3886/rendezvous/${id}`, {}, env)).status).toBe(404);
    expect((await req(`/_matrix/client/v1/rendezvous/${id}`, {}, env)).status).toBe(404);

    expect((await req(path, { method: 'DELETE' }, env)).status).toBe(204);
    for (const key of preExisting) expect(sessions.data[key]).toBeDefined();
  });
});
