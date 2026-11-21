/**
 * Pure byte-level coverage for the chunked-body decoder in the raw-socket
 * HTTP transport. No bindings, no sockets: only Uint8Array in and out.
 */
import { describe, it, expect, vi } from 'vitest';

// The module imports cloudflare:sockets for the transport path. The decoder
// never reaches it, but Vite still needs the specifier to resolve at import.
vi.mock('cloudflare:sockets', () => ({
  connect: () => {
    throw new Error('socket transport is not used by these tests');
  },
}));

import { parseHttpResponse, tryDecodeChunked } from '../src/services/socket-transport';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);

describe('tryDecodeChunked', () => {
  it('decodes a small chunked payload into exactly its concatenated bytes', () => {
    const result = tryDecodeChunked(bytes('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'));

    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(text(result!)).toBe('hello world');
  });

  it('ignores chunk extensions and trailers around the terminal chunk', () => {
    const result = tryDecodeChunked(bytes('4;name=value\r\nWiki\r\n0\r\nX-Trailer: yes\r\n\r\n'));

    expect(result).not.toBeNull();
    expect(text(result!)).toBe('Wiki');
  });

  it('returns null while the message is still incomplete', () => {
    expect(tryDecodeChunked(bytes('5\r\nhel'))).toBeNull();
    expect(tryDecodeChunked(bytes('5\r\nhello\r\n'))).toBeNull();
  });

  it('throws on malformed chunk sizes and chunk terminators', () => {
    expect(() => tryDecodeChunked(bytes('zz\r\nhello\r\n0\r\n\r\n'))).toThrow(/Malformed chunk size/);
    expect(() => tryDecodeChunked(bytes('5\r\nhelloXX0\r\n\r\n'))).toThrow(/Malformed chunk terminator/);
  });
});

describe('non-chunked response bodies', () => {
  it('passes a body with no chunked transfer encoding through unchanged', () => {
    const body = 'plain text, including 5\r\nwhich is not a chunk size';
    const raw = bytes(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${body}`);

    const parsed = parseHttpResponse(raw);

    expect(parsed.headers['transfer-encoding']).toBeUndefined();
    expect(text(parsed.body)).toBe(body);
  });
});
