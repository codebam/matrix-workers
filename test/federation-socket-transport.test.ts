import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  buildRequestText,
  parseHttpResponse,
  responseComplete,
  socketFetchResponse,
} from '../src/services/socket-transport';
import { federationFetch } from '../src/services/federation-http';
import { fetchRemoteServerKeys, getServerSigningKey, makeFederationRequest } from '../src/services/federation-keys';
import { generateSigningKeyPair } from '../src/utils/crypto';

// ---------------------------------------------------------------------------
// Scripted fake of the cloudflare:sockets module. The transport is exercised
// against a fake TLS socket whose bytes we control chunk by chunk.
// ---------------------------------------------------------------------------

const socketsMock = vi.hoisted(() => ({
  calls: [] as Array<{ address: unknown; options: unknown }>,
  queued: null as null | (() => unknown),
}));

vi.mock('cloudflare:sockets', () => ({
  connect: (address: unknown, options?: unknown) => {
    socketsMock.calls.push({ address, options });
    if (!socketsMock.queued) throw new Error('No fake socket queued');
    const factory = socketsMock.queued;
    socketsMock.queued = null;
    return factory();
  },
}));

const encoder = new TextEncoder();

interface ScriptedSocket {
  chunks?: Uint8Array[];
  /** Keep the readable open forever, like a keep-alive peer. */
  neverEnd?: boolean;
  /** Fail the readable instead of serving bytes. */
  error?: Error;
}

function makeScriptedSocket(script: ScriptedSocket) {
  const decoder = new TextDecoder();
  let requestText = '';
  let closedByClient = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let index = 0;
  const closeCalls = { count: 0 };
  const scriptState = script;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    pull(controller) {
      if (scriptState.error) {
        const error = scriptState.error;
        scriptState.error = undefined;
        controller.error(error);
        return;
      }
      if (index < (scriptState.chunks?.length ?? 0)) {
        controller.enqueue(scriptState.chunks![index++]);
        return;
      }
      if (scriptState.neverEnd && !closedByClient) {
        // Hold the stream open; only the client-side close() (timeout/abort)
        // or a completed response ends the read.
        return new Promise<void>(() => {});
      }
      controller.close();
    },
  });

  const socket = {
    readable,
    writable: new WritableStream<Uint8Array>({
      write(chunk: Uint8Array) {
        requestText += decoder.decode(chunk, { stream: true });
      },
    }),
    closed: Promise.resolve(),
    opened: Promise.resolve({}),
    upgraded: false,
    secureTransport: 'on' as const,
    close: async () => {
      closeCalls.count++;
      closedByClient = true;
      try {
        controllerRef?.close();
      } catch {
        // Already closed.
      }
    },
    startTls: () => socket,
    getRequestText: () => requestText,
    closeCalls,
  };
  return socket;
}

function queueSocket(script: ScriptedSocket) {
  const socket = makeScriptedSocket(script);
  socketsMock.queued = () => socket;
  return socket;
}

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

beforeEach(() => {
  socketsMock.calls.length = 0;
  socketsMock.queued = null;
});

// ---------------------------------------------------------------------------
// Node's WebCrypto spells Ed25519 differently than workerd (NODE-ED25519);
// remap so key generation/signing work under vitest.
// ---------------------------------------------------------------------------

function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (
    alg: AlgorithmIdentifier | EcKeyGenParams | EcKeyImportParams | EcdsaParams | unknown
  ): AlgorithmIdentifier => {
    if (typeof alg === 'string') {
      return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    }
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') {
      return 'Ed25519';
    }
    return alg as AlgorithmIdentifier;
  };

  subtle.generateKey = ((alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg), extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    alg: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[]
  ) =>
    origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;

  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}

let restoreShim: (() => void) | undefined;
beforeAll(() => {
  restoreShim = installNodeEd25519Shim();
});
afterAll(() => {
  restoreShim?.();
});

// ---------------------------------------------------------------------------
// Request serialization
// ---------------------------------------------------------------------------

describe('buildRequestText', () => {
  it('assembles an HTTP/1.1 request with Host, auth and Content-Length', () => {
    const text = buildRequestText(new URL('https://peer.example:8448/_matrix/federation/v1/send/txn1'), {
      method: 'PUT',
      headers: {
        Authorization: 'X-Matrix origin="local.example",key="ed25519:abc",sig="sig"',
        'Content-Type': 'application/json',
      },
      body: '{"a":1}',
    });
    expect(text).toContain('PUT /_matrix/federation/v1/send/txn1 HTTP/1.1\r\n');
    expect(text).toContain('Host: peer.example:8448\r\n');
    expect(text).toContain('Accept-Encoding: identity\r\n');
    expect(text).toContain('Connection: close\r\n');
    expect(text).toContain('Authorization: X-Matrix origin="local.example",key="ed25519:abc",sig="sig"\r\n');
    expect(text).toContain('Content-Length: 7\r\n');
    expect(text.endsWith('\r\n\r\n{"a":1}')).toBe(true);
  });

  it('omits Content-Length for bodyless GETs and keeps the query string', () => {
    const text = buildRequestText(new URL('https://peer.example:8448/_matrix/key/v2/server?x=1'), {
      headers: { Accept: 'application/json' },
    });
    expect(text).toContain('GET /_matrix/key/v2/server?x=1 HTTP/1.1\r\n');
    expect(text).toContain('Host: peer.example:8448\r\n');
    expect(text).not.toContain('Content-Length');
    expect(text.endsWith('\r\n\r\n')).toBe(true);
  });

  it('does not let callers override transport-managed headers', () => {
    const text = buildRequestText(new URL('https://peer.example:8448/p'), {
      method: 'POST',
      headers: {
        Host: 'spoofed.example',
        Connection: 'keep-alive',
        'Content-Length': '999',
        'Accept-Encoding': 'gzip',
      },
      body: 'x',
    });
    expect(text).not.toContain('spoofed.example');
    expect(text.match(/Connection: /g)).toHaveLength(1);
    expect(text.match(/Accept-Encoding: /g)).toHaveLength(1);
    expect(text).toContain('Content-Length: 1\r\n');
    expect(text).not.toContain('gzip');
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('parseHttpResponse', () => {
  it('parses status, headers and a Content-Length body', () => {
    const raw = bytesOf('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"pdus":{}}');
    const parsed = parseHttpResponse(raw);
    expect(parsed.status).toBe(200);
    expect(parsed.statusText).toBe('OK');
    expect(parsed.headers['content-type']).toBe('application/json');
    expect(new TextDecoder().decode(parsed.body)).toBe('{"pdus":{}}');
  });

  it('decodes chunked bodies', () => {
    const raw = bytesOf(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"pdus"\r\n4\r\n:{}}\r\n0\r\n\r\n'
    );
    const parsed = parseHttpResponse(raw);
    expect(new TextDecoder().decode(parsed.body)).toBe('{"pdus":{}}');
  });

  it('rejects a truncated chunked body', () => {
    const raw = bytesOf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"pdu');
    expect(() => parseHttpResponse(raw)).toThrow(/Incomplete chunked/);
  });

  it('rejects malformed chunk sizes', () => {
    const raw = bytesOf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n{"pdus":{}}\r\n0\r\n\r\n');
    expect(() => parseHttpResponse(raw)).toThrow(/Malformed chunk size/);
  });
});

describe('responseComplete', () => {
  it('is false until the Content-Length body is fully buffered', () => {
    expect(responseComplete(bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"pd'))).toBe(false);
    expect(responseComplete(bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"pdus":{}}'))).toBe(true);
  });

  it('is true once the terminal chunk arrives', () => {
    expect(responseComplete(bytesOf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"pdu'))).toBe(false);
    expect(responseComplete(bytesOf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'))).toBe(true);
  });

  it('is false for close-delimited bodies (no framing headers)', () => {
    expect(responseComplete(bytesOf('HTTP/1.1 200 OK\r\n\r\nhello'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

describe('socketFetchResponse', () => {
  it('serves a response over a TLS socket and dials the exact host/port', async () => {
    const socket = queueSocket({
      chunks: [bytesOf('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"pdus":{}}')],
    });

    const res = await socketFetchResponse(new URL('https://peer.example:8448/_matrix/federation/v1/send/t1'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ pdus: {} });
    expect(socketsMock.calls).toHaveLength(1);
    expect(socketsMock.calls[0].address).toEqual({ hostname: 'peer.example', port: 8448 });
    expect(socketsMock.calls[0].options).toEqual({ secureTransport: 'on', allowHalfOpen: false });
    expect(socket.getRequestText()).toContain('PUT /_matrix/federation/v1/send/t1 HTTP/1.1');
  });

  it('reassembles a response split across multiple socket reads', async () => {
    const full = bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    queueSocket({ chunks: [full.slice(0, 10), full.slice(10, 25), full.slice(25)] });

    const res = await socketFetchResponse(new URL('https://peer.example:8448/p'), {});
    expect(await res.text()).toBe('ok');
  });

  it('handles chunked responses with trailers', async () => {
    queueSocket({
      chunks: [
        bytesOf('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwiki\r\n5\r\npedia\r\n0\r\nX-Trailer: 1\r\n\r\n'),
      ],
    });

    const res = await socketFetchResponse(new URL('https://peer.example:8448/p'), {});
    expect(await res.text()).toBe('wikipedia');
  });

  it('stops reading once framing is complete even if the peer keeps the connection open', async () => {
    queueSocket({
      chunks: [bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')],
      neverEnd: true,
    });

    const res = await socketFetchResponse(new URL('https://peer.example:8448/p'), {});
    expect(await res.text()).toBe('ok');
  });

  it('drops responses without a body (204)', async () => {
    queueSocket({ chunks: [bytesOf('HTTP/1.1 204 No Content\r\n\r\n')] });
    const res = await socketFetchResponse(new URL('https://peer.example:8448/p'), {});
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('rejects when the peer never completes a response (timeout)', async () => {
    queueSocket({
      chunks: [bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n')],
      neverEnd: true,
    });

    await expect(socketFetchResponse(new URL('https://peer.example:8448/p'), {}, 50)).rejects.toThrow(
      /timed out/
    );
  });

  it('rejects with an AbortError when the caller aborts', async () => {
    queueSocket({ neverEnd: true });
    const controller = new AbortController();
    const promise = socketFetchResponse(new URL('https://peer.example:8448/p'), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects non-https URLs', async () => {
    await expect(socketFetchResponse(new URL('http://peer.example:8448/p'), {})).rejects.toThrow(/https/);
  });
});

// ---------------------------------------------------------------------------
// federationFetch routing
// ---------------------------------------------------------------------------

describe('federationFetch routing', () => {
  it('routes non-fetch ports through the socket transport without touching fetch', async () => {
    queueSocket({ chunks: [bytesOf('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await federationFetch('https://peer.example:8448/ping', { method: 'GET' });
      expect(await res.text()).toBe('ok');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(socketsMock.calls[0].address).toEqual({ hostname: 'peer.example', port: 8448 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates socket connection failures instead of silently retrying fetch()', async () => {
    socketsMock.queued = () => {
      throw new Error('connection refused');
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(federationFetch('https://peer.example:8448/ping', {})).rejects.toThrow(
        'connection refused'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: signed federation requests to an 8448-only peer
// ---------------------------------------------------------------------------

function signingKeyDb(keyId: string, privateKeyJwk: JsonWebKey) {
  return {
    prepare(sql: string) {
      return {
        first: async () =>
          sql.includes('server_keys')
            ? { key_id: keyId, private_key_jwk: JSON.stringify(privateKeyJwk) }
            : null,
      };
    },
  } as unknown as D1Database;
}

function discoveryCache(serverName: string, host: string, port: number) {
  return {
    get: async (key: string) =>
      key === `discovery:${serverName}` ? JSON.stringify({ host, port, tlsHostname: host }) : null,
    put: async () => {},
  } as unknown as KVNamespace;
}

describe('makeFederationRequest over the socket transport', () => {
  it('signs and sends a PUT to an 8448-only peer', async () => {
    const keyPair = await generateSigningKeyPair();
    const db = signingKeyDb(keyPair.keyId, keyPair.privateKeyJwk);
    const signingKey = await getServerSigningKey(db);
    expect(signingKey).not.toBeNull();
    const cache = discoveryCache('peer.example', 'peer.example', 8448);
    const socket = queueSocket({
      chunks: [bytesOf('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"pdus":{}}')],
    });

    const res = await makeFederationRequest(
      'PUT',
      'peer.example',
      '/_matrix/federation/v1/send/txn42',
      'local.example',
      signingKey!,
      cache,
      { pdus: {} }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pdus: {} });

    const wire = socket.getRequestText();
    expect(wire).toContain('PUT /_matrix/federation/v1/send/txn42 HTTP/1.1\r\n');
    expect(wire).toContain('Host: peer.example:8448\r\n');
    expect(wire).toContain(
      `Authorization: X-Matrix origin="local.example",destination="peer.example",key="${keyPair.keyId}",sig="`
    );
    expect(wire).toContain('Content-Length: 11\r\n');
    expect(wire.endsWith('{"pdus":{}}')).toBe(true);
  });

  it('fetches remote server keys from an 8448-only peer', async () => {
    const keyPair = await generateSigningKeyPair();
    const keyResponse = {
      server_name: 'peer.example',
      valid_until_ts: Date.now() + 24 * 60 * 60 * 1000,
      verify_keys: { [keyPair.keyId]: { key: keyPair.publicKey } },
    };
    const bodyJson = JSON.stringify(keyResponse);
    const socket = queueSocket({
      chunks: [
        bytesOf(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bodyJson.length}\r\n\r\n${bodyJson}`
        ),
      ],
    });

    const cache = {
      get: async (key: string) =>
        key === 'discovery:peer.example'
          ? JSON.stringify({ host: 'peer.example', port: 8448, tlsHostname: 'peer.example' })
          : null,
      put: async () => {},
    } as unknown as KVNamespace;

    const inserts: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        if (sql.includes('FROM remote_server_keys')) {
          return {
            bind: () => ({ all: async () => ({ results: [] }) }),
          };
        }
        if (sql.includes('INSERT OR REPLACE INTO remote_server_keys')) {
          return {
            bind: (...args: unknown[]) => {
              inserts.push(args);
              return { run: async () => ({ meta: { changes: 1 } }) };
            },
          };
        }
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
      },
    } as unknown as D1Database;

    const keys = await fetchRemoteServerKeys('peer.example', db, cache);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      server_name: 'peer.example',
      key_id: keyPair.keyId,
      public_key: keyPair.publicKey,
    });
    expect(inserts).toHaveLength(1);
    expect(socket.getRequestText()).toContain('GET /_matrix/key/v2/server HTTP/1.1');
  });
});
