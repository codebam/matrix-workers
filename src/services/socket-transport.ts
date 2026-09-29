// Raw-socket HTTP transport for Cloudflare Workers.
//
// Workers fetch() can only reach a fixed set of destination ports (443/8443/
// 2053/2083/2087/2096 for https); for any other port it silently connects to
// the scheme-default port instead (cloudflare-docs issue #4299). Matrix
// federation's default port 8448 is *not* in that allowlist, so peers that
// only serve federation there are unreachable through fetch().
//
// This module opens a TLS connection with the cloudflare:sockets API and
// speaks HTTP/1.1 directly, rebuilding a real Response object so callers are
// oblivious to which transport served the request.
//
// Assumptions, matching the immediate-connection cases of the Matrix server
// discovery algorithm: TLS SNI equals the dialed host (connect() derives it
// from the hostname), and responses are HTTP/1.1 with either Content-Length,
// chunked transfer-encoding, or connection-close delimited bodies. An
// "Accept-Encoding: identity" header is sent so bodies arrive uncompressed.

import { connect } from 'cloudflare:sockets';

const DEFAULT_TIMEOUT_MS = 30_000;

// Federation responses are small JSON documents; cap the read so a malicious
// peer cannot stream unbounded data into the Worker.
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SocketHttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

// Headers that describe this individual HTTP/1.1 connection (or that we
// request the identity encoding of) and must not be forwarded to fetch()
// callers or re-sent from caller-supplied values.
const MANAGED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
]);

// Hop-by-hop response headers stripped before rebuilding the Response.
const SKIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key] = String(value);
  }
  return out;
}

function findCrlf(data: Uint8Array, from: number): number {
  for (let i = from; i + 1 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10) return i;
  }
  return -1;
}

function findHeaderEnd(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Serialize an HTTP/1.1 request. Exported for unit tests.
 */
export function buildRequestText(url: URL, init: RequestInit): string {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const hasBody = init.body !== undefined && init.body !== null;
  const bodyText = hasBody ? String(init.body) : '';

  const lines = [
    `${method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'User-Agent: matrix-worker',
    'Accept-Encoding: identity',
    'Connection: close',
  ];

  for (const [key, value] of Object.entries(headers)) {
    if (MANAGED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    lines.push(`${key}: ${value}`);
  }

  if (hasBody) {
    lines.push(`Content-Length: ${encoder.encode(bodyText).length}`);
  }

  return `${lines.join('\r\n')}\r\n\r\n${bodyText}`;
}

/**
 * Parse the status line and header block of an HTTP/1.1 response.
 */
function parseResponseHead(raw: Uint8Array): {
  headEnd: number;
  status: number;
  statusText: string;
  headers: Record<string, string>;
} {
  const headEnd = findHeaderEnd(raw);
  if (headEnd < 0) {
    throw new Error('No HTTP header terminator in socket response');
  }
  const lines = decoder.decode(raw.subarray(0, headEnd)).split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!statusMatch) {
    throw new Error(`Malformed HTTP status line: "${lines[0].slice(0, 80)}"`);
  }

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  return {
    headEnd,
    status: parseInt(statusMatch[1], 10),
    // Strip control characters: Response constructor rejects some reason
    // phrases a peer could send.
    statusText: (statusMatch[2] ?? '').replace(/[^\t\x20-\x7e]/g, ''),
    headers,
  };
}

/**
 * Decode a chunked-encoded body. Returns null when the data ends before the
 * terminal chunk (more bytes are needed); throws on malformed framing.
 * Exported for unit tests.
 */
export function tryDecodeChunked(data: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let i = 0;
  for (;;) {
    const lineEnd = findCrlf(data, i);
    if (lineEnd < 0) return null;
    const sizeText = decoder.decode(data.subarray(i, lineEnd)).trim();
    i = lineEnd + 2;
    const semicolon = sizeText.indexOf(';');
    const sizeHex = (semicolon >= 0 ? sizeText.slice(0, semicolon) : sizeText).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeHex)) {
      throw new Error(`Malformed chunk size "${sizeHex.slice(0, 32)}"`);
    }
    const size = parseInt(sizeHex, 16);
    if (size === 0) {
      // Terminal chunk; any trailers are irrelevant to the payload.
      return concatChunks(parts);
    }
    if (i + size > data.length) return null;
    parts.push(data.slice(i, i + size));
    i += size;
    if (data[i] === 13 && data[i + 1] === 10) {
      i += 2;
    } else if (i >= data.length) {
      return null;
    } else {
      throw new Error('Malformed chunk terminator');
    }
  }
}

/**
 * Parse a complete HTTP/1.1 response. Exported for unit tests.
 */
export function parseHttpResponse(raw: Uint8Array): SocketHttpResult {
  const head = parseResponseHead(raw);
  if (head.status < 200) {
    throw new Error(`Unexpected interim HTTP ${head.status} response`);
  }

  const bodyBytes = raw.subarray(head.headEnd + 4);
  let body = bodyBytes;

  if ((head.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    const decoded = tryDecodeChunked(bodyBytes);
    if (decoded === null) {
      throw new Error('Incomplete chunked response body');
    }
    body = decoded;
  } else if (head.headers['content-length'] !== undefined) {
    const length = parseInt(head.headers['content-length'], 10);
    if (Number.isFinite(length) && length >= 0) {
      body = bodyBytes.subarray(0, Math.min(length, bodyBytes.length));
    }
  }

  return { status: head.status, statusText: head.statusText, headers: head.headers, body };
}

/**
 * Whether the buffered response bytes already contain the complete message.
 * Used to stop reading before the peer closes the connection.
 * Exported for unit tests.
 */
export function responseComplete(raw: Uint8Array): boolean {
  const headEnd = findHeaderEnd(raw);
  if (headEnd < 0) return false;

  let head: { status: number; statusText: string; headers: Record<string, string> };
  try {
    head = parseResponseHead(raw);
  } catch {
    return false;
  }

  const body = raw.subarray(headEnd + 4);
  if ((head.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
    try {
      return tryDecodeChunked(body) !== null;
    } catch {
      return false;
    }
  }
  if (head.headers['content-length'] !== undefined) {
    const length = parseInt(head.headers['content-length'], 10);
    return Number.isFinite(length) && body.length >= length;
  }
  // No framing information: the body is delimited by connection close.
  return false;
}

/**
 * Rebuild a fetch-compatible Response from a parsed socket response.
 */
export function toResponse(result: SocketHttpResult): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (SKIPPED_RESPONSE_HEADERS.has(name)) continue;
    try {
      headers.set(name, value);
    } catch {
      // A misbehaving peer sent an invalid header value; drop it.
    }
  }
  const noBody = result.status === 204 || result.status === 304;
  return new Response(noBody ? null : result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}

function closeQuietly(socket: { close(): Promise<void> }): void {
  Promise.resolve()
    .then(() => socket.close())
    .catch(() => {
      // Already closed / peer gone; nothing to do.
    });
}

/**
 * Perform an HTTP request over a TLS socket and return a Response.
 *
 * Only used for ports that fetch() cannot target; errors are propagated to
 * the caller exactly like a failed fetch() would be.
 */
export async function socketFetchResponse(
  url: URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  if (url.protocol !== 'https:') {
    throw new Error(`Socket transport requires https, got ${url.protocol}`);
  }
  const port = url.port ? parseInt(url.port, 10) : 443;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port in URL: ${url.href}`);
  }

  // URL.hostname keeps IPv6 brackets; SocketAddress wants the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const requestText = buildRequestText(url, init);

  const socket = connect(
    { hostname, port },
    { secureTransport: 'on', allowHalfOpen: false }
  );

  const signal = init.signal ?? undefined;
  let aborted = signal?.aborted ?? false;
  let timedOut = false;
  const onAbort = () => {
    aborted = true;
    closeQuietly(socket);
  };
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort);
  }

  const timer = setTimeout(() => {
    timedOut = true;
    closeQuietly(socket);
  }, timeoutMs);

  try {
    const writer = (socket.writable as WritableStream<Uint8Array>).getWriter();
    try {
      await writer.write(encoder.encode(requestText));
    } finally {
      writer.releaseLock();
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        chunks.push(value);
        received += value.length;
        if (received > MAX_RESPONSE_BYTES) {
          throw new Error(`Federation response exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        if (responseComplete(concatChunks(chunks))) break;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Stream already errored/closed; releasing is best-effort.
      }
    }

    const raw = concatChunks(chunks);
    if (aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (timedOut && !responseComplete(raw)) {
      throw new Error(`TLS socket request to ${url.host} timed out after ${timeoutMs}ms`);
    }

    return toResponse(parseHttpResponse(raw));
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    closeQuietly(socket);
  }
}
