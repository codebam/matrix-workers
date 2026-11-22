import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/rate-limit', () => ({
  federationOriginRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  getRateLimitType: () => 'default',
  getClientId: () => 'unknown',
  RATE_LIMITS: {},
}));
vi.mock('hono/logger', () => ({ logger: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../src/middleware/analytics', () => ({
  analyticsMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', '@alice:example.com');
    c.set('deviceId', 'DEVICE');
    await next();
  },
  optionalAuth: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', '@alice:example.com');
    await next();
  },
  extractAccessToken: () => 'test-token',
  validateAccessToken: async () => ({ userId: '@alice:example.com', deviceId: 'DEVICE' }),
}));
vi.mock('../src/durable-objects', () => ({
  RoomDurableObject: class {}, SyncDurableObject: class {}, FederationDurableObject: class {},
  CallRoomDurableObject: class {}, AdminDurableObject: class {}, UserKeysDurableObject: class {},
  PushDurableObject: class {}, RateLimitDurableObject: class {}, DelayedEventsDurableObject: class {},
  LiveKitShimDurableObject: class {},
}));
vi.mock('../src/workflows', () => ({
  RoomJoinWorkflow: class {}, PushNotificationWorkflow: class {}, FederationCatchupWorkflow: class {},
  MediaCleanupWorkflow: class {}, StateCompactionWorkflow: class {},
}));

import app from '../src/index';

const PATH =
  '/_matrix/client/v3/user/%40alice%3Aexample.com/account_data/net.f0rest.msc4584.soft_ignore_config';

function envFor(): Env {
  return {
    SERVER_NAME: 'example.com',
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
  } as unknown as Env;
}

describe('MSC4584 route mounting', () => {
  it('rejects an invalid soft-ignore config before the generic account-data route', async () => {
    const res = await app.request(
      PATH,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'not-a-boolean' }),
      },
      envFor()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).errcode).toBe('M_INVALID_PARAM');
  });
});
