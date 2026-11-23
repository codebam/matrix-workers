import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  discoverServer,
  probeDelegatedServer,
} from '../src/services/server-discovery';

// Issue doc 007.6: probe delegated target before trusting it.

describe('server-discovery probe (007.6)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('accepts delegation when probe succeeds', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/.well-known/matrix/server')) {
        return new Response(JSON.stringify({ 'm.server': 'delegated.example.com:8443' }), { status: 200 });
      }
      if (u.includes('/_matrix/federation/v1/version')) {
        return new Response(JSON.stringify({ server: { name: 'tuwunel', version: '1.0' } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const result = await discoverServer('origin.example.com');
    expect(result).toEqual({
      host: 'delegated.example.com',
      port: 8443,
      tlsHostname: 'delegated.example.com',
    });
  });

  it('rejects delegation when probe fails (non-OK)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/.well-known/matrix/server')) {
        return new Response(JSON.stringify({ 'm.server': 'delegated.example.com:8443' }), { status: 200 });
      }
      // probe endpoints fail
      if (u.includes('/_matrix/')) {
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify({ Status: 2 }), { status: 200 });
    });

    const result = await discoverServer('origin.example.com');
    // falls through to default
    expect(result).toEqual({
      host: 'origin.example.com',
      port: 8448,
      tlsHostname: 'origin.example.com',
    });
  });

  it('rejects delegation when probe throws', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/.well-known/matrix/server')) {
        return new Response(JSON.stringify({ 'm.server': 'delegated.example.com:8443' }), { status: 200 });
      }
      if (u.includes('/_matrix/')) {
        throw new Error('network reset');
      }
      return new Response(JSON.stringify({ Status: 2 }), { status: 200 });
    });

    const result = await discoverServer('origin.example.com');
    expect(result).toEqual({
      host: 'origin.example.com',
      port: 8448,
      tlsHostname: 'origin.example.com',
    });
  });

  it('SSRF still blocks delegated target', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/.well-known/matrix/server')) {
        return new Response(JSON.stringify({ 'm.server': '127.0.0.1:8448' }), { status: 200 });
      }
      return new Response(JSON.stringify({ Status: 2 }), { status: 200 });
    });

    const result = await discoverServer('public.example.com');
    expect(result).toEqual({
      host: 'public.example.com',
      port: 8448,
      tlsHostname: 'public.example.com',
    });
    // probeDelegatedServer direct
    expect(await probeDelegatedServer('127.0.0.1:8448')).toBe(false);
  });

  it('probe timeout aborts (returns false)', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes('/.well-known/matrix/server')) {
        return new Response(JSON.stringify({ 'm.server': 'slow.example.com:8443' }), { status: 200 });
      }
      if (u.includes('/_matrix/')) {
        // simulate abort
        const err = new Error('aborted');
        (err as any).name = 'AbortError';
        throw err;
      }
      return new Response('{}', { status: 404 });
    });

    const result = await discoverServer('origin.example.com');
    expect(result).toEqual({
      host: 'origin.example.com',
      port: 8448,
      tlsHostname: 'origin.example.com',
    });
    expect(await probeDelegatedServer('slow.example.com:8443')).toBe(false);
  });

  it('probeDelegatedServer accepts client versions endpoint', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/_matrix/client/versions')) {
        return new Response(JSON.stringify({ versions: ['v1.12'] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await probeDelegatedServer('versions.example.com:8443')).toBe(true);
  });

  it('probeDelegatedServer returns false on invalid JSON', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('/_matrix/')) {
        return new Response('not json', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    expect(await probeDelegatedServer('badjson.example.com:8443')).toBe(false);
  });
});