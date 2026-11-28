// Rate Limiting Middleware
// Implements rate limiting using Durable Objects for persistence
// Uses a sliding window algorithm with different limits for different endpoints

import type { Context, Next } from 'hono';
import type { AppEnv } from '../types';

// Rate limit configurations for different endpoint types
export const RATE_LIMITS: Record<string, { requests: number; windowMs: number }> = {
  login: { requests: 10, windowMs: 60 * 1000 }, // 10 per minute
  register: { requests: 5, windowMs: 60 * 1000 }, // 5 per minute
  default: { requests: 100, windowMs: 60 * 1000 }, // 100 per minute
  sync: { requests: 300, windowMs: 60 * 1000 }, // 300 per minute (long-polling)
  e2ee: { requests: 500, windowMs: 60 * 1000 }, // 500 per minute (key uploads)
  media_upload: { requests: 30, windowMs: 60 * 1000 }, // 30 per minute
  media_download: { requests: 200, windowMs: 60 * 1000 }, // 200 per minute
  search: { requests: 30, windowMs: 60 * 1000 }, // 30 per minute
  federation: { requests: 500, windowMs: 60 * 1000 }, // 500 per minute
  send_message: { requests: 60, windowMs: 60 * 1000 }, // 60 per minute
  create_room: { requests: 10, windowMs: 60 * 1000 }, // 10 per minute
};

/** Classify a request path/method into a rate-limit bucket. Exported for unit tests. */
export function getRateLimitType(path: string, method: string): string {
  if (path.includes('/login') && method === 'POST') return 'login';
  if (path.includes('/register') && method === 'POST') return 'register';
  if (path.includes('/sync')) return 'sync';
  if (path.includes('/keys/')) return 'e2ee';
  if (path.includes('/media') || path.includes('/upload')) {
    return method === 'POST' || method === 'PUT' ? 'media_upload' : 'media_download';
  }
  if (path.includes('/search')) return 'search';
  if (path.includes('/_matrix/federation') || path.includes('/_matrix/key')) return 'federation';
  if (path.includes('/createRoom') && method === 'POST') return 'create_room';
  if (path.match(/\/rooms\/[^/]+\/send/) && method === 'PUT') return 'send_message';
  return 'default';
}

// Get client identifier (IP or user ID).
//
// IP source trust:
//   - `CF-Connecting-IP` is set by Cloudflare's edge and is authoritative
//     when the worker is reached via Cloudflare. We always prefer it.
//   - `X-Forwarded-For` is client-spoofable when the worker is reached
//     directly. We only fall back to it when `TRUST_FORWARDED_FOR=true` is
//     explicitly configured (i.e. the operator is fronting the worker with
//     another trusted proxy that rewrites XFF).
//   - When no trusted IP source is available we use a single 'unknown' bucket.
//     This is intentionally a strict shared bucket — if you see legitimate
//     'unknown' traffic, fix the deployment to expose a trusted IP source.
/** Exported for unit tests. */
export function getClientId(c: Context<AppEnv>): string {
  // Try to get user ID first (for authenticated requests)
  const userId = c.get('userId');
  if (userId) {
    return `user:${userId}`;
  }

  // Always prefer the Cloudflare-set header.
  const cfConnectingIp = c.req.header('CF-Connecting-IP');
  if (cfConnectingIp) {
    return `ip:${cfConnectingIp}`;
  }

  // Fall back to X-Forwarded-For only if the operator opts in.
  const trustForwarded = c.env.TRUST_FORWARDED_FOR === 'true';
  if (trustForwarded) {
    const xForwardedFor = c.req.header('X-Forwarded-For');
    const xff = xForwardedFor?.split(',')[0]?.trim();
    if (xff) {
      return `ip:${xff}`;
    }
  }

  return 'ip:unknown';
}

// Buckets that require strict globally-consistent Durable Object enforcement
// (credential-stuffing / signup-abuse targets). All other high-frequency
// buckets use the isolate-local fast path to avoid doubling request costs
// with a DO RPC on every normal Matrix API call.
const STRICT_DO_LIMIT_TYPES = new Set(['login', 'register']);

interface LocalRateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
  resetAt?: number;
}

const MAX_LOCAL_RATE_LIMIT_ENTRIES = 10_000;
const localRateLimitCounters = new Map<string, LocalRateLimitEntry>();

/** Reset isolate-local rate limit counters. Exported for unit tests. */
export function resetLocalRateLimits(): void {
  localRateLimitCounters.clear();
}

function checkLocalRateLimit(
  bucketKey: string,
  limit: number,
  windowMs: number
): RateLimitCheckResult {
  const now = Date.now();
  const entry = localRateLimitCounters.get(bucketKey);

  if (entry && entry.windowStart > now - windowMs) {
    if (entry.count >= limit) {
      const resetAt = entry.windowStart + windowMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: resetAt - now,
        resetAt,
      };
    }

    entry.count++;
    return {
      allowed: true,
      remaining: limit - entry.count,
      resetAt: entry.windowStart + windowMs,
    };
  }

  // Lazy eviction when map reaches cap to bound isolate memory
  if (localRateLimitCounters.size >= MAX_LOCAL_RATE_LIMIT_ENTRIES) {
    for (const [k, v] of localRateLimitCounters) {
      if (v.windowStart <= now - windowMs) {
        localRateLimitCounters.delete(k);
      }
    }
    while (localRateLimitCounters.size >= MAX_LOCAL_RATE_LIMIT_ENTRIES) {
      const oldest = localRateLimitCounters.keys().next().value;
      if (oldest === undefined) break;
      localRateLimitCounters.delete(oldest);
    }
  }

  localRateLimitCounters.set(bucketKey, { count: 1, windowStart: now });
  return {
    allowed: true,
    remaining: limit - 1,
    resetAt: now + windowMs,
  };
}

// Rate limiter: uses isolate-local sliding windows on hot-path endpoints to
// avoid a Durable Object RPC per request, reserving RateLimitDurableObject
// for strict auth/register buckets (or when RATE_LIMIT_DISTRIBUTED=true).
export async function rateLimitMiddleware(c: Context<AppEnv>, next: Next) {
  const path = c.req.path;
  const method = c.req.method;

  // Skip rate limiting for OPTIONS (CORS preflight)
  if (method === 'OPTIONS') {
    return next();
  }

  // Skip rate limiting for sync endpoints with long timeout
  // These have natural rate limiting via the timeout parameter
  if (path.includes('/sync')) {
    return next();
  }

  const limitType = getRateLimitType(path, method);
  const config = RATE_LIMITS[limitType];
  const clientId = getClientId(c);

  const useDurableObject =
    STRICT_DO_LIMIT_TYPES.has(limitType) || c.env.RATE_LIMIT_DISTRIBUTED === 'true';

  if (!useDurableObject) {
    const result = checkLocalRateLimit(`${limitType}:${clientId}`, config.requests, config.windowMs);

    c.header('X-RateLimit-Limit', String(config.requests));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.resetAt) {
      c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    }

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.retryAfterMs || config.windowMs) / 1000);
      c.header('Retry-After', String(retryAfter));

      return c.json(
        {
          errcode: 'M_LIMIT_EXCEEDED',
          error: 'Too many requests',
          retry_after_ms: result.retryAfterMs || config.windowMs,
        },
        429
      );
    }

    return next();
  }

  // Use rate limit type as the DO ID to distribute load
  // Each strict limit type gets its own DO instance
  const doId = c.env.RATE_LIMIT.idFromName(limitType);
  const stub = c.env.RATE_LIMIT.get(doId);

  try {
    const response = await stub.fetch(
      new Request('https://internal/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'check',
          clientId,
          limit: config.requests,
          windowMs: config.windowMs,
        }),
      })
    );

    const result = (await response.json()) as RateLimitCheckResult;

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(config.requests));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.resetAt) {
      c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    }

    if (!result.allowed) {
      // Rate limited
      const retryAfter = Math.ceil((result.retryAfterMs || config.windowMs) / 1000);
      c.header('Retry-After', String(retryAfter));

      return c.json(
        {
          errcode: 'M_LIMIT_EXCEEDED',
          error: 'Too many requests',
          retry_after_ms: result.retryAfterMs || config.windowMs,
        },
        429
      );
    }
  } catch (error) {
    // If rate limiting fails, allow the request (fail open)
    // Log the error but don't block the request
    console.error('Rate limiting error:', error);
  }

  return next();
}

// Stricter rate limiter for specific endpoints (can be used as route-specific middleware)
export function strictRateLimit(requests: number, windowMs: number) {
  return async (c: Context<AppEnv>, next: Next) => {
    const clientId = getClientId(c);
    const path = c.req.path;

    // Use a unique DO ID for strict rate limits
    const doId = c.env.RATE_LIMIT.idFromName(`strict:${path}`);
    const stub = c.env.RATE_LIMIT.get(doId);

    try {
      const response = await stub.fetch(
        new Request('https://internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'check',
            clientId,
            limit: requests,
            windowMs,
          }),
        })
      );

      const result = (await response.json()) as {
        allowed: boolean;
        remaining: number;
        retryAfterMs?: number;
      };

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.retryAfterMs || windowMs) / 1000);
        c.header('Retry-After', String(retryAfter));

        return c.json(
          {
            errcode: 'M_LIMIT_EXCEEDED',
            error: 'Too many requests',
            retry_after_ms: result.retryAfterMs || windowMs,
          },
          429
        );
      }
    } catch (error) {
      console.error('Strict rate limiting error:', error);
    }

    return next();
  };
}

// Origin-keyed strict limit for federation-authenticated endpoints (e.g.
// the MSC4284 policy /sign endpoint, which the spec marks rate-limited):
// one bucket per CALLING SERVER rather than per user or IP, so a busy
// room's asks cannot be dodged by rotating tokens and a misbehaving
// server cannot crowd out others.
export function federationOriginRateLimit(requests: number, windowMs: number) {
  return async (c: Context<AppEnv>, next: Next) => {
    const origin = (c as { get: (key: string) => unknown }).get('federationOrigin') as
      | string
      | undefined;
    // No origin means federation auth did not run (or failed open in a
    // test harness): nothing sensible to key on — let the auth middleware
    // be the gate.
    if (!origin) return next();
    // Degrade gracefully without the DO binding (test harnesses, minimal
    // environments): enforcement is best-effort, never a 500.
    if (!c.env.RATE_LIMIT) return next();    const doId = c.env.RATE_LIMIT.idFromName(`federation:${c.req.path}:${origin}`);
    const stub = c.env.RATE_LIMIT.get(doId);

    try {
      const response = await stub.fetch(
        new Request('https://internal/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'check',
            clientId: `origin:${origin}`,
            limit: requests,
            windowMs,
          }),
        })
      );

      const result = (await response.json()) as {
        allowed: boolean;
        remaining: number;
        retryAfterMs?: number;
      };

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.retryAfterMs || windowMs) / 1000);
        c.header('Retry-After', String(retryAfter));

        return c.json(
          {
            errcode: 'M_LIMIT_EXCEEDED',
            error: 'Too many requests',
            retry_after_ms: result.retryAfterMs || windowMs,
          },
          429
        );
      }
    } catch (error) {
      console.error('Federation origin rate limiting error:', error);
    }

    return next();
  };
}
