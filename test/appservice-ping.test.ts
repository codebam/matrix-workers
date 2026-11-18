/**
 * Appservice ping (Matrix v1.7+):
 * - HS-side POST /_matrix/client/v1/appservice/{id}/ping (as_token auth),
 *   probing the AS's /_matrix/app/v1/ping with the hs_token.
 * - AS-side POST /_matrix/app/v1/ping (hs_token auth).
 * Spec error mapping: M_FORBIDDEN / M_URL_NOT_SET / M_BAD_STATUS /
 * M_CONNECTION_FAILED / M_CONNECTION_TIMEOUT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

import appservice from '../src/api/appservice';

const SERVER = 'example.com';

interface AsRow {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  rate_limited: number;
  protocols: string | null;
  namespaces: string;
}

function asRow(partial: Partial<AsRow> = {}): AsRow {
  return {
    id: 'bridge',
    url: 'https://bridge.example.com',
    as_token: 'as-token-123',
    hs_token: 'hs-token-456',
    sender_localpart: 'bridgebot',
    rate_limited: 0,
    protocols: null,
    namespaces: JSON.stringify({ users: [], rooms: [], aliases: [] }),
    ...partial,
  };
}

function createDb(rows: AsRow[]) {
  const stmt = (sql: string) => {
    const bound = (...args: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (sql.includes('WHERE as_token = ?')) {
          return (rows.find(r => r.as_token === args[0]) ?? null) as T | null;
        }
        if (sql.includes('WHERE hs_token = ?')) {
          return (rows.find(r => r.hs_token === args[0]) ?? null) as T | null;
        }
        return null as T;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    });
    return { bind: bound, all: bound().all, first: bound().first, run: bound().run };
  };
  return { prepare: (sql: string) => stmt(sql) };
}

function envFor(rows: AsRow[]): Env {
  return {
    SERVER_NAME: SERVER,
    DB: createDb(rows) as unknown as D1Database,
  } as unknown as Env;
}

async function ping(env: Env, appId: string, init: RequestInit = {}) {
  const res = await appservice.request(
    `http://localhost/_matrix/client/v1/appservice/${appId}/ping`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: 'txn-1' }), ...init },
    env
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HS-side appservice ping', () => {
  it('probes the AS with the hs_token and reports duration_ms', async () => {
    const env = envFor([asRow()]);
    const { status, body } = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(status).toBe(200);
    expect(typeof body.duration_ms).toBe('number');
    expect(body.duration_ms).toBeGreaterThanOrEqual(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bridge.example.com/_matrix/app/v1/ping');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer hs-token-456');
    expect(JSON.parse(String(init.body))).toEqual({ transaction_id: 'txn-1' });
  });

  it('accepts the as_token via query parameter', async () => {
    const env = envFor([asRow()]);
    const res = await appservice.request(
      'http://localhost/_matrix/client/v1/appservice/bridge/ping?access_token=as-token-123',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(res.status).toBe(200);
  });

  it('403 M_FORBIDDEN for another appservice id, unknown token, or missing token', async () => {
    const env = envFor([asRow()]);
    const wrongId = await ping(env, 'other', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(wrongId.status).toBe(403);
    expect(wrongId.body.errcode).toBe('M_FORBIDDEN');

    const wrongToken = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
    });
    expect(wrongToken.status).toBe(403);

    const noToken = await ping(env, 'bridge');
    expect(noToken.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400 M_URL_NOT_SET when the registration has no URL', async () => {
    const env = envFor([asRow({ url: '' })]);
    const { status, body } = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_URL_NOT_SET');
  });

  it('502 M_BAD_STATUS with the AS status and body on non-success', async () => {
    fetchMock.mockResolvedValue(new Response('{"errcode":"M_UNKNOWN_TOKEN"}', { status: 401 }));
    const env = envFor([asRow()]);
    const { status, body } = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(status).toBe(502);
    expect(body.errcode).toBe('M_BAD_STATUS');
    expect(body.status).toBe(401);
    expect(body.body).toContain('M_UNKNOWN_TOKEN');
  });

  it('502 M_CONNECTION_FAILED when the connection fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('connection refused'));
    const env = envFor([asRow()]);
    const { status, body } = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(status).toBe(502);
    expect(body.errcode).toBe('M_CONNECTION_FAILED');
  });

  it('504 M_CONNECTION_TIMEOUT when the probe times out', async () => {
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutErr);
    const env = envFor([asRow()]);
    const { status, body } = await ping(env, 'bridge', {
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123' },
    });
    expect(status).toBe(504);
    expect(body.errcode).toBe('M_CONNECTION_TIMEOUT');
  });

  it('400 M_BAD_JSON for a malformed body', async () => {
    const env = envFor([asRow()]);
    const res = await appservice.request(
      'http://localhost/_matrix/client/v1/appservice/bridge/ping',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer as-token-123', }, body: '{' },
      env
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).errcode).toBe('M_BAD_JSON');
  });
});

describe('AS-side /_matrix/app/v1/ping', () => {
  it('answers 200 {} for a valid hs_token', async () => {
    const env = envFor([asRow()]);
    const res = await appservice.request(
      'http://localhost/_matrix/app/v1/ping',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer hs-token-456' }, body: '{}' },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('rejects missing or invalid hs_token', async () => {
    const env = envFor([asRow()]);
    const missing = await appservice.request(
      'http://localhost/_matrix/app/v1/ping',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      env
    );
    expect(missing.status).toBe(401);
    const invalid = await appservice.request(
      'http://localhost/_matrix/app/v1/ping',
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' },
      env
    );
    expect(invalid.status).toBe(403);
  });
});