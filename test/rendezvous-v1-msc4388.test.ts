/**
 * MSC4388 secure QR channel transport: the stable v1 JSON rendezvous API
 * (plus the io.element.msc4388 unstable prefix) in src/api/rendezvous.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import rendezvous from '../src/api/rendezvous';

const PREFIXES = [
  { path: '/_matrix/client/v1/rendezvous', errcode: 'M_CONCURRENT_WRITE' },
  {
    path: '/_matrix/client/unstable/io.element.msc4388/rendezvous',
    errcode: 'IO_ELEMENT_MSC4388_CONCURRENT_WRITE',
  },
];

function mockKv() {
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
  } as unknown as KVNamespace & { data: Record<string, string> };
}

function envFor(sessions: ReturnType<typeof mockKv>): Env {
  return { SESSIONS: sessions, SERVER_NAME: 'example.com' } as unknown as Env;
}

async function req(path: string, init: RequestInit = {}, env = envFor(mockKv())) {
  const res = await rendezvous.request(`https://example.com${path}`, init, env);
  const text = await res.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('MSC4388 v1 rendezvous discovery and lifecycle', () => {
  for (const { path, errcode } of PREFIXES) {
    it(`${path}: discovery reports create_available`, async () => {
      const res = await req(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ create_available: true });
    });

    it(`${path}: create / read / CAS write / idempotent retry / cancel`, async () => {
      const sessions = mockKv();
      const env = envFor(sessions);

      const created = await req(path, jsonInit('POST', { data: '' }), env);
      expect(created.status).toBe(200);
      expect(created.body.sequence_token).toBe('1');
      expect(created.body.expires_in_ms).toBeGreaterThan(299_000);
      expect(created.body.expires_in_ms).toBeLessThanOrEqual(300_000);
      expect(typeof created.body.id).toBe('string');
      const id = created.body.id as string;
      expect(Object.keys(sessions.data)).toEqual([`rendezvous:v1:${path}:${id}`]);

      const empty = await req(`${path}/${id}`, {}, env);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ data: '', sequence_token: '1' });

      const stale = await req(
        `${path}/${id}/txn-stale`,
        jsonInit('PUT', { sequence_token: '0', data: 'bad' }),
        env
      );
      expect(stale.status).toBe(409);
      expect(stale.body.errcode).toBe(errcode);

      const wrote = await req(
        `${path}/${id}/txn-1`,
        jsonInit('PUT', { sequence_token: '1', data: 'MATRIX-QR' }),
        env
      );
      expect(wrote.status).toBe(200);
      expect(wrote.body).toEqual({ sequence_token: '2' });

      // Same txnId replays the recorded result without advancing the token.
      const replay = await req(
        `${path}/${id}/txn-1`,
        jsonInit('PUT', { sequence_token: '1', data: 'DIFFERENT' }),
        env
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ sequence_token: '2' });
      const afterReplay = await req(`${path}/${id}`, {}, env);
      expect(afterReplay.body.data).toBe('MATRIX-QR');

      // The new sequence token is required for the next write.
      const next = await req(
        `${path}/${id}/txn-2`,
        jsonInit('PUT', { sequence_token: '2', data: 'second' }),
        env
      );
      expect(next.body).toEqual({ sequence_token: '3' });

      const deleted = await req(`${path}/${id}`, { method: 'DELETE' }, env);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({});
      expect((await req(`${path}/${id}`, {}, env)).status).toBe(404);
    });

    it(`${path}: validates input shapes and size`, async () => {
      const sessions = mockKv();
      const env = envFor(sessions);
      expect((await req(path, jsonInit('POST', {}), env)).status).toBe(400);
      expect((await req(path, jsonInit('POST', { data: 3 }), env)).status).toBe(400);
      const big = await req(path, jsonInit('POST', { data: 'x'.repeat(4097) }), env);
      expect(big.status).toBe(413);
      expect(big.body.errcode).toBe('M_TOO_LARGE');
      expect((await req(path, { method: 'POST', body: '{bad' }, env)).status).toBe(400);

      const created = await req(path, jsonInit('POST', { data: '' }), env);
      const id = created.body.id as string;
      const noToken = await req(
        `${path}/${id}/txn-a`,
        jsonInit('PUT', { data: 'x' }),
        env
      );
      expect(noToken.status).toBe(400);
      const noData = await req(
        `${path}/${id}/txn-b`,
        jsonInit('PUT', { sequence_token: '1' }),
        env
      );
      expect(noData.status).toBe(400);
    });
  }

  it('refuses top-level document navigation to a rendezvous read', async () => {
    const sessions = mockKv();
    const created = await req(
      '/_matrix/client/v1/rendezvous',
      jsonInit('POST', { data: '' }),
      envFor(sessions)
    );
    const res = await req(
      `/_matrix/client/v1/rendezvous/${created.body.id}`,
      { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } },
      envFor(sessions)
    );
    expect(res.status).toBe(403);
    expect(res.body.errcode).toBe('M_FORBIDDEN');
  });

  it('stable and unstable channels are isolated', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);
    const [stable, unstable] = await Promise.all([
      req('/_matrix/client/v1/rendezvous', jsonInit('POST', { data: '' }), env),
      req(
        '/_matrix/client/unstable/io.element.msc4388/rendezvous',
        jsonInit('POST', { data: '' }),
        env
      ),
    ]);
    expect(stable.body.id).not.toBe(unstable.body.id);
    expect((await req(`/_matrix/client/v1/rendezvous/${unstable.body.id}`, {}, env)).status).toBe(404);
  });

  it('legacy MSC3886 byte channels remain unchanged', async () => {
    const sessions = mockKv();
    const env = envFor(sessions);
    const created = await req(
      '/_matrix/client/unstable/org.matrix.msc3906/rendezvous',
      { method: 'POST', headers: { 'Content-Length': '0' } },
      env
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('X-Max-Bytes')).toBe('10240');
  });
});
