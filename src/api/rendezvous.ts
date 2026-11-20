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

export default app;