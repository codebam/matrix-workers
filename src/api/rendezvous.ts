// Rendezvous channels for QR login (MSC3906 flows over the MSC3886 HTTP
// transport). Unauthenticated, short-lived, ETag-guarded byte channels:
// POST creates a session, GET polls (If-None-Match -> 304), PUT replaces the
// payload (If-Match required, stale -> 412 M_CONCURRENT_WRITE), DELETE
// cancels. Exposed under both unstable prefixes so legacy Element
// (org.matrix.msc3886) and MSC3906 clients work; the well-known
// io.element.rendezvous entry points clients at this server.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';

const app = new Hono<AppEnv>();

const MAX_BYTES = 10240;
const TTL_SECONDS = 600;

const PREFIXES = [
  '/_matrix/client/unstable/org.matrix.msc3886',
  '/_matrix/client/unstable/org.matrix.msc3906',
];

interface RendezvousSession {
  payload: string; // base64 bytes
  contentType: string;
  etag: string;
  created: number;
  expires: number;
}

function newEtag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sessionHeaders(c: any, session: RendezvousSession): void {
  c.header('ETag', session.etag);
  c.header('Expires', new Date(session.expires).toUTCString());
  c.header('Last-Modified', new Date(session.created).toUTCString());
}

async function loadSession(c: any, id: string): Promise<RendezvousSession | null> {
  return c.env.SESSIONS.get(`rendezvous:${id}`, 'json') as Promise<RendezvousSession | null>;
}

for (const prefix of PREFIXES) {
  // Create a channel. The initial payload is whatever the client POSTed
  // (usually empty); the ETag returned here guards the first PUT.
  app.post(`${prefix}/rendezvous`, async (c) => {
    if (c.req.header('Content-Length') === undefined) {
      return Errors.missingParam('Content-Length').toResponse();
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return Errors.tooLarge(`Rendezvous payload exceeds ${MAX_BYTES} bytes`).toResponse();
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const session: RendezvousSession = {
      payload: toBase64(bytes),
      contentType: c.req.header('Content-Type') ?? 'application/octet-stream',
      etag: newEtag(),
      created: now,
      expires: now + TTL_SECONDS * 1000,
    };
    await c.env.SESSIONS.put(`rendezvous:${id}`, JSON.stringify(session), {
      expirationTtl: TTL_SECONDS,
    });

    const url = `https://${c.env.SERVER_NAME}${prefix}/rendezvous/${id}`;
    c.header('Location', url);
    c.header('X-Max-Bytes', String(MAX_BYTES));
    sessionHeaders(c, session);
    // JSON body carries the session id for clients that probe with a bare
    // POST; the headers above are the MSC3886 contract.
    return c.json({ id, url, expires_at: session.expires }, 201);
  });

  app.get(`${prefix}/rendezvous/:id`, async (c) => {
    const session = await loadSession(c, c.req.param('id'));
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();

    sessionHeaders(c, session);
    if (c.req.header('If-None-Match') === session.etag) {
      return c.body(null, 304);
    }
    c.header('Content-Type', session.contentType);
    return c.body(fromBase64(session.payload), 200);
  });

  app.put(`${prefix}/rendezvous/:id`, async (c) => {
    const session = await loadSession(c, c.req.param('id'));
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();

    const ifMatch = c.req.header('If-Match');
    if (ifMatch === undefined) {
      return Errors.missingParam('If-Match').toResponse();
    }
    // Only strong, single-valued ETags are accepted.
    if (ifMatch.startsWith('W/') || ifMatch.includes(',')) {
      return Errors.invalidParam('If-Match', 'If-Match must be a single strong ETag').toResponse();
    }
    if (ifMatch !== session.etag) {
      sessionHeaders(c, session);
      return Errors.concurrentWrite().toResponse();
    }
    if (c.req.header('Content-Length') === undefined) {
      return Errors.missingParam('Content-Length').toResponse();
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return Errors.tooLarge(`Rendezvous payload exceeds ${MAX_BYTES} bytes`).toResponse();
    }

    const now = Date.now();
    const updated: RendezvousSession = {
      payload: toBase64(bytes),
      contentType: c.req.header('Content-Type') ?? session.contentType,
      etag: newEtag(),
      created: now,
      expires: now + TTL_SECONDS * 1000,
    };
    await c.env.SESSIONS.put(`rendezvous:${c.req.param('id')}`, JSON.stringify(updated), {
      expirationTtl: TTL_SECONDS,
    });

    sessionHeaders(c, updated);
    return c.body(null, 202);
  });

  app.delete(`${prefix}/rendezvous/:id`, async (c) => {
    const session = await loadSession(c, c.req.param('id'));
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();
    await c.env.SESSIONS.delete(`rendezvous:${c.req.param('id')}`);
    return c.body(null, 204);
  });
}

// ---------------------------------------------------------------------------
// MSC4108 insecure rendezvous session — unstable v1 byte transport
// ---------------------------------------------------------------------------
//
// Element Web's "Link new device / Sign in with QR" flow uses the insecure
// rendezvous session from MSC4108, exposed under its unstable prefix. This is
// the MSC3886-style ETag/byte-channel contract (NOT the MSC4388 JSON
// {data} -> {id, sequence_token} contract implemented below), so it needs its
// own routes and its own KV key namespace.
//
// Reference: MSC4108, sections "Insecure rendezvous session", "Maximum payload
// size" / "Maximum duration of a rendezvous" / "ETags", and "Unstable prefix":
// https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/4108-oidc-qr-login.md
//
// Spec points honoured here:
//   - POST requires Content-Length and Content-Type: text/plain; the payload
//     may be an empty string, and is capped at 4KB (4096 bytes).
//   - Common headers on 2xx/412 responses: ETag, Expires, Last-Modified,
//     Cache-Control: no-store, Pragma: no-cache (caches must not rewrite the
//     ETag that drives the compare-and-swap).
//   - Strong, single-valued ETags only; stale If-Match -> 412. Under the
//     unstable prefix a brand-new errcode is reported as M_UNKNOWN with the
//     real code in `org.matrix.msc4108.errcode` (the "Unstable prefix" rule).
//   - Sessions live ~60 seconds, then the URL is a 404 M_NOT_FOUND.
//   - Unauthenticated by design: trust is layered on by the secure channel.

const MSC4108_PREFIX = '/_matrix/client/unstable/org.matrix.msc4108/rendezvous';
const MSC4108_MAX_BYTES = 4096; // MSC4108: "enforce a maximum payload size of 4KB"
const MSC4108_TTL_SECONDS = 60; // MSC4108: "a timeout such as 60 seconds should be adequate"

// Distinct namespace: legacy MSC3886/3906 byte channels use `rendezvous:` and
// the MSC4388 JSON API uses `rendezvous:v1:`. MSC4108 sessions must never
// collide with either (UUID ids also make accidental overlap impossible).
function msc4108Key(id: string): string {
  return `rendezvous:msc4108:${id}`;
}

function msc4108Headers(c: any, session: RendezvousSession): void {
  sessionHeaders(c, session); // ETag, Expires, Last-Modified (unchanged legacy helper)
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

async function loadMsc4108Session(c: any, id: string): Promise<RendezvousSession | null> {
  const key = msc4108Key(id);
  const session = await c.env.SESSIONS.get(key, 'json') as RendezvousSession | null;
  if (!session) return null;
  // KV expirationTtl normally removes the key; check explicitly too so an
  // expired session is still a 404 if KV deletion is ever delayed.
  if (session.expires <= Date.now()) {
    await c.env.SESSIONS.delete(key);
    return null;
  }
  return session;
}

function isTextPlain(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  // Allow parameters such as `text/plain; charset=utf-8`.
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'text/plain';
}

function isStrongEtag(value: string): boolean {
  // MSC4108: "we only accept strong, single-valued ETag values".
  return !value.startsWith('W/') && !value.includes(',');
}

// Create a session. The returned `url` is what Device G puts in the QR code.
app.post(MSC4108_PREFIX, async (c) => {
  if (c.req.header('Content-Length') === undefined) {
    return Errors.missingParam('Content-Length').toResponse();
  }
  const contentType = c.req.header('Content-Type');
  if (contentType === undefined) {
    return Errors.missingParam('Content-Type').toResponse();
  }
  if (!isTextPlain(contentType)) {
    return Errors.invalidParam('Content-Type', 'Content-Type must be text/plain').toResponse();
  }

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MSC4108_MAX_BYTES) {
    return Errors.tooLarge(`Rendezvous payload exceeds ${MSC4108_MAX_BYTES} bytes`).toResponse();
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const session: RendezvousSession = {
    payload: toBase64(bytes), // keep the payload as base64 text in KV
    contentType: 'text/plain',
    etag: newEtag(), // strong + unique per revision (16 random bytes)
    created: now,
    expires: now + MSC4108_TTL_SECONDS * 1000,
  };
  await c.env.SESSIONS.put(msc4108Key(id), JSON.stringify(session), {
    expirationTtl: MSC4108_TTL_SECONDS,
  });

  const url = `https://${c.env.SERVER_NAME}${MSC4108_PREFIX}/${id}`;
  msc4108Headers(c, session);
  return c.json({ url }, 201);
});

// Receive the payload; an If-None-Match hit returns 304 with common headers.
app.get(`${MSC4108_PREFIX}/:id`, async (c) => {
  const session = await loadMsc4108Session(c, c.req.param('id'));
  if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();

  msc4108Headers(c, session);
  if (c.req.header('If-None-Match') === session.etag) {
    return c.body(null, 304);
  }
  c.header('Content-Type', 'text/plain');
  return c.body(fromBase64(session.payload), 200);
});

// Compare-and-swap write. A stale If-Match is a conflict; under the unstable
// prefix the new M_CONCURRENT_WRITE errcode travels in org.matrix.msc4108.errcode.
app.put(`${MSC4108_PREFIX}/:id`, async (c) => {
  const id = c.req.param('id');
  const session = await loadMsc4108Session(c, id);
  if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();

  if (c.req.header('Content-Length') === undefined) {
    return Errors.missingParam('Content-Length').toResponse();
  }
  const contentType = c.req.header('Content-Type');
  if (contentType === undefined) {
    return Errors.missingParam('Content-Type').toResponse();
  }
  if (!isTextPlain(contentType)) {
    return Errors.invalidParam('Content-Type', 'Content-Type must be text/plain').toResponse();
  }
  const ifMatch = c.req.header('If-Match');
  if (ifMatch === undefined) {
    return Errors.missingParam('If-Match').toResponse();
  }
  if (!isStrongEtag(ifMatch)) {
    return Errors.invalidParam('If-Match', 'If-Match must be a single strong ETag').toResponse();
  }
  if (ifMatch !== session.etag) {
    msc4108Headers(c, session);
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        'org.matrix.msc4108.errcode': 'M_CONCURRENT_WRITE',
        error: 'The rendezvous payload was modified concurrently',
      },
      412
    );
  }

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MSC4108_MAX_BYTES) {
    return Errors.tooLarge(`Rendezvous payload exceeds ${MSC4108_MAX_BYTES} bytes`).toResponse();
  }

  const now = Date.now();
  const updated: RendezvousSession = {
    payload: toBase64(bytes),
    contentType: 'text/plain',
    etag: newEtag(), // new revision -> new ETag even if the bytes are identical
    created: now,
    expires: now + MSC4108_TTL_SECONDS * 1000,
  };
  await c.env.SESSIONS.put(msc4108Key(id), JSON.stringify(updated), {
    expirationTtl: MSC4108_TTL_SECONDS,
  });

  msc4108Headers(c, updated);
  return c.body(null, 202);
});

// Cancel a session (MSC4108: 204 No Content).
app.delete(`${MSC4108_PREFIX}/:id`, async (c) => {
  const id = c.req.param('id');
  const session = await loadMsc4108Session(c, id);
  if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();
  await c.env.SESSIONS.delete(msc4108Key(id));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// MSC4388 secure QR channel — stable v1 JSON rendezvous transport
// ---------------------------------------------------------------------------
//
// The unstable byte-channel API above implements MSC3886/3906 (ETag based).
// MSC4388 uses a JSON API with a sequence token, a client-generated txnId for
// idempotent writes, and a 409 M_CONCURRENT_WRITE on stale writes. Both live
// here so no new binding or schema is needed.

const V1_MAX_DATA_BYTES = 4096;
const V1_TTL_SECONDS = 300; // MSC4388: 120s..300s

interface V1RendezvousSession {
  data: string; // base64 of the UTF-8 payload
  sequenceToken: number;
  created: number;
  expires: number;
  // txnId -> resulting sequence token; lets clients safely retry a PUT.
  txnResults: Record<string, number>;
}

const V1_PREFIXES = [
  {
    path: '/_matrix/client/v1/rendezvous',
    concurrentWriteErrcode: 'M_CONCURRENT_WRITE',
  },
  {
    path: '/_matrix/client/unstable/io.element.msc4388/rendezvous',
    concurrentWriteErrcode: 'IO_ELEMENT_MSC4388_CONCURRENT_WRITE',
  },
];

function v1Key(prefix: string, id: string): string {
  return `rendezvous:v1:${prefix}:${id}`;
}

async function loadV1Session(c: any, prefix: string, id: string): Promise<V1RendezvousSession | null> {
  return c.env.SESSIONS.get(v1Key(prefix, id), 'json') as Promise<V1RendezvousSession | null>;
}

function v1ExpiresIn(session: V1RendezvousSession): number {
  return Math.max(0, session.expires - Date.now());
}

async function readV1Json(c: any): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function v1Utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

for (const { path: prefix, concurrentWriteErrcode } of V1_PREFIXES) {
  // Discovery — clients use this to decide whether QR login is available.
  app.get(prefix, (c) => c.json({ create_available: true }));

  // Create a session with an initial payload (usually the empty string).
  app.post(prefix, async (c) => {
    const body = await readV1Json(c);
    if (!body) return Errors.badJson().toResponse();
    if (typeof body.data !== 'string') {
      return Errors.missingParam('data').toResponse();
    }
    if (v1Utf8Bytes(body.data) > V1_MAX_DATA_BYTES) {
      return Errors.tooLarge(`Rendezvous data exceeds ${V1_MAX_DATA_BYTES} bytes`).toResponse();
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    const session: V1RendezvousSession = {
      data: toBase64(new TextEncoder().encode(body.data)),
      sequenceToken: 1,
      created: now,
      expires: now + V1_TTL_SECONDS * 1000,
      txnResults: {},
    };
    await c.env.SESSIONS.put(v1Key(prefix, id), JSON.stringify(session), {
      expirationTtl: V1_TTL_SECONDS,
    });
    return c.json({ id, sequence_token: '1', expires_in_ms: v1ExpiresIn(session) });
  });

  // Read the current payload.
  app.get(`${prefix}/:id`, async (c) => {
    // MSC4388: refuse unsafe top-level navigation to a rendezvous read.
    if (c.req.header('Sec-Fetch-Mode') === 'navigate' &&
        c.req.header('Sec-Fetch-Dest') === 'document') {
      return Errors.forbidden('Rendezvous sessions cannot be opened as a document').toResponse();
    }
    const session = await loadV1Session(c, prefix, c.req.param('id'));
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();
    return c.json({
      data: new TextDecoder().decode(fromBase64(session.data)),
      sequence_token: String(session.sequenceToken),
      expires_in_ms: v1ExpiresIn(session),
    });
  });

  // Compare-and-swap write. txnId is checked before the body, per MSC4388.
  app.put(`${prefix}/:id/:txnId`, async (c) => {
    const id = c.req.param('id');
    const txnId = c.req.param('txnId');
    const session = await loadV1Session(c, prefix, id);
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();

    const recorded = session.txnResults[txnId];
    if (recorded !== undefined) {
      return c.json({ sequence_token: String(recorded) });
    }

    const body = await readV1Json(c);
    if (!body) return Errors.badJson().toResponse();
    if (typeof body.sequence_token !== 'string') {
      return Errors.missingParam('sequence_token').toResponse();
    }
    if (typeof body.data !== 'string') {
      return Errors.missingParam('data').toResponse();
    }
    if (v1Utf8Bytes(body.data) > V1_MAX_DATA_BYTES) {
      return Errors.tooLarge(`Rendezvous data exceeds ${V1_MAX_DATA_BYTES} bytes`).toResponse();
    }
    if (body.sequence_token !== String(session.sequenceToken)) {
      return c.json(
        {
          errcode: concurrentWriteErrcode,
          error: 'The rendezvous payload was modified concurrently',
        },
        409
      );
    }

    const nextToken = session.sequenceToken + 1;
    session.data = toBase64(new TextEncoder().encode(body.data));
    session.sequenceToken = nextToken;
    session.expires = Date.now() + V1_TTL_SECONDS * 1000;
    // Reject duplicate txnIds per session; keep the map bounded to the
    // session lifetime (300s) so it cannot grow without limit.
    if (Object.keys(session.txnResults).length >= 128) {
      session.txnResults = {};
    }
    session.txnResults[txnId] = nextToken;
    await c.env.SESSIONS.put(v1Key(prefix, id), JSON.stringify(session), {
      expirationTtl: V1_TTL_SECONDS,
    });
    return c.json({ sequence_token: String(nextToken) });
  });

  // Cancel — MSC4388 returns 200 {} rather than 204.
  app.delete(`${prefix}/:id`, async (c) => {
    const session = await loadV1Session(c, prefix, c.req.param('id'));
    if (!session) return Errors.notFound('Unknown rendezvous session').toResponse();
    await c.env.SESSIONS.delete(v1Key(prefix, c.req.param('id')));
    return c.json({});
  });
}

export default app;