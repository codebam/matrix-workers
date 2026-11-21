// Focused pin for federationOriginRateLimit, the one rate-limit export with no
// direct coverage elsewhere in test/. These cases stay on the pure decision
// paths (factory shape, graceful degradation, origin-keyed DO request body).
import { describe, it, expect, vi } from 'vitest';
import { federationOriginRateLimit } from '../src/middleware/rate-limit';
import type { Context } from 'hono';
import type { AppEnv } from '../src/types';

const PATH = '/_matrix/federation/v1/send/123';

function makeCtx(
  opts: { origin?: string; path?: string; env?: Record<string, unknown> } = {}
): Context<AppEnv> & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    get: (key: string) => (key === 'federationOrigin' ? opts.origin : undefined),
    req: { path: opts.path ?? PATH, method: 'PUT' },
    env: opts.env ?? {},
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    _headers: headers,
  } as unknown as Context<AppEnv> & { _headers: Record<string, string> };
}

function makeBinding(fetchImpl: (req: Request) => Promise<Response>) {
  const idFromName = vi.fn((name: string) => ({ name }));
  const get = vi.fn(() => ({ fetch: fetchImpl }));
  return { RATE_LIMIT: { idFromName, get }, idFromName, get };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('federationOriginRateLimit', () => {
  it('is a factory that returns a middleware function', () => {
    expect(typeof federationOriginRateLimit(5, 10_000)).toBe('function');
  });

  it('calls next without touching the DO when no federation origin was set', async () => {
    const binding = makeBinding(async () => jsonResponse({ allowed: false, remaining: 0 }));
    const next = vi.fn(async () => 'ok');
    const ctx = makeCtx({ env: binding });

    await expect(federationOriginRateLimit(5, 10_000)(ctx, next)).resolves.toBe('ok');
    expect(next).toHaveBeenCalledOnce();
    expect(binding.idFromName).not.toHaveBeenCalled();
    expect(binding.get).not.toHaveBeenCalled();
  });

  it('calls next when the origin is present but the RATE_LIMIT binding is missing', async () => {
    const next = vi.fn(async () => 'ok');
    const ctx = makeCtx({ origin: 'remote.test' });

    await expect(federationOriginRateLimit(5, 10_000)(ctx, next)).resolves.toBe('ok');
    expect(next).toHaveBeenCalledOnce();
  });

  it('keys the bucket by calling server and sends an origin clientId', async () => {
    let seenBody: Record<string, unknown> | undefined;
    const binding = makeBinding(async (req) => {
      seenBody = (await req.json()) as Record<string, unknown>;
      return jsonResponse({ allowed: true, remaining: 4 });
    });
    const next = vi.fn(async () => 'ok');
    const ctx = makeCtx({ origin: 'remote.test:8448', env: binding });

    await expect(federationOriginRateLimit(5, 10_000)(ctx, next)).resolves.toBe('ok');
    expect(binding.idFromName).toHaveBeenCalledWith(
      `federation:${PATH}:remote.test:8448`
    );
    expect(seenBody).toEqual({
      action: 'check',
      clientId: 'origin:remote.test:8448',
      limit: 5,
      windowMs: 10_000,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('denies with 429 and the DO-provided retry hint', async () => {
    const binding = makeBinding(async () =>
      jsonResponse({ allowed: false, remaining: 0, retryAfterMs: 5_200 })
    );
    const next = vi.fn(async () => 'ok');
    const ctx = makeCtx({ origin: 'remote.test', env: binding });

    const result = (await federationOriginRateLimit(5, 10_000)(ctx, next)) as {
      status: number;
      body: { errcode: string; error: string; retry_after_ms: number };
    };
    expect(result.status).toBe(429);
    expect(result.body).toEqual({
      errcode: 'M_LIMIT_EXCEEDED',
      error: 'Too many requests',
      retry_after_ms: 5_200,
    });
    expect(ctx._headers['Retry-After']).toBe('6');
    expect(next).not.toHaveBeenCalled();
  });

  it('falls back to the configured window when the DO omits retryAfterMs', async () => {
    const binding = makeBinding(async () => jsonResponse({ allowed: false, remaining: 0 }));
    const ctx = makeCtx({ origin: 'remote.test', env: binding });

    const result = (await federationOriginRateLimit(5, 10_000)(ctx, async () => 'ok')) as {
      body: { retry_after_ms: number };
    };
    expect(result.body.retry_after_ms).toBe(10_000);
    expect(ctx._headers['Retry-After']).toBe('10');
  });

  it('fails open when the DO fetch rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const binding = makeBinding(async () => {
        throw new Error('DO unavailable');
      });
      const next = vi.fn(async () => 'ok');
      const ctx = makeCtx({ origin: 'remote.test', env: binding });

      await expect(federationOriginRateLimit(5, 10_000)(ctx, next)).resolves.toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(err).toHaveBeenCalledOnce();
    } finally {
      err.mockRestore();
    }
  });
});
