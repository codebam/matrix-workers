/**
 * Third-party protocol lookup endpoints (Matrix v1.17).
 * No bridges are configured, so every lookup answers 404 M_NOT_FOUND and
 * the field-based lookups require their query parameters.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth')>();
  return {
    ...actual,
    requireAuth: () => {
      return async (
        c: { set: (k: string, v: unknown) => void },
        next: () => Promise<void>
      ) => {
        c.set('userId', '@alice:example.com');
        c.set('deviceId', 'DEVICE');
        await next();
      };
    },
  };
});

import thirdparty from '../src/api/thirdparty';

const env = { SERVER_NAME: 'example.com' } as Env;

async function get(path: string) {
  const res = await thirdparty.request(`http://localhost${path}`, { method: 'GET' }, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('thirdparty lookups without bridges', () => {
  it('protocol lookup answers 404 M_NOT_FOUND', async () => {
    const { status, body } = await get('/_matrix/client/v3/thirdparty/protocol/irc');
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('user-by-protocol lookup answers 404 M_NOT_FOUND', async () => {
    const { status, body } = await get('/_matrix/client/v3/thirdparty/user/irc');
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('location-by-protocol lookup answers 404 M_NOT_FOUND', async () => {
    const { status, body } = await get('/_matrix/client/v3/thirdparty/location/irc');
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('user lookup by userid answers 404 M_NOT_FOUND', async () => {
    const { status, body } = await get(
      '/_matrix/client/v3/thirdparty/user?userid=%40alice%3Aexample.com'
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('user lookup without userid answers 400 M_MISSING_PARAM', async () => {
    const { status, body } = await get('/_matrix/client/v3/thirdparty/user');
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });

  it('location lookup by alias answers 404 M_NOT_FOUND', async () => {
    const { status, body } = await get(
      '/_matrix/client/v3/thirdparty/location?alias=%23room%3Aexample.com'
    );
    expect(status).toBe(404);
    expect(body.errcode).toBe('M_NOT_FOUND');
  });

  it('location lookup without alias answers 400 M_MISSING_PARAM', async () => {
    const { status, body } = await get('/_matrix/client/v3/thirdparty/location');
    expect(status).toBe(400);
    expect(body.errcode).toBe('M_MISSING_PARAM');
  });
});