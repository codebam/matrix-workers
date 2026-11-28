// Rate Limiting Durable Object
// Uses in-memory counters to avoid KV rate limit issues
//
// Each instance handles rate limiting for a specific category (login, register, etc.)
// Counters are stored in memory and automatically cleaned up when they expire

import { DurableObject } from 'cloudflare:workers';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface CheckLimitRequest {
  action: 'check';
  clientId: string;
  limit: number;
  windowMs: number;
}

interface ResetRequest {
  action: 'reset';
  clientId: string;
}

interface CleanupRequest {
  action: 'cleanup';
}

type RateLimitRequest = CheckLimitRequest | ResetRequest | CleanupRequest;

interface CheckLimitResponse {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
  resetAt?: number;
}

export class RateLimitDurableObject extends DurableObject<Record<string, unknown>> {
  private counters: Map<string, RateLimitEntry> = new Map();
  private cleanupAlarm: number | null = null;

  async fetch(request: Request): Promise<Response> {
    try {
      const body: RateLimitRequest = await request.json();

      switch (body.action) {
        case 'check':
          return Response.json(await this.checkLimit(body.clientId, body.limit, body.windowMs));
        case 'reset':
          this.counters.delete(body.clientId);
          return Response.json({ success: true });
        case 'cleanup':
          this.cleanupExpiredEntries();
          return Response.json({ success: true });
        default:
          return Response.json({ error: 'Unknown action' }, { status: 400 });
      }
    } catch (error) {
      console.error('RateLimitDurableObject error:', error);
      return Response.json({ error: 'Internal error' }, { status: 500 });
    }
  }

  private async checkLimit(clientId: string, limit: number, windowMs: number): Promise<CheckLimitResponse> {
    const now = Date.now();
    const entry = this.counters.get(clientId);

    let response: CheckLimitResponse;

    // Check if entry exists and is within the window (update synchronously
    // before any await to avoid TOCTOU lost updates across concurrent fetches)
    if (entry && entry.windowStart > now - windowMs) {
      if (entry.count >= limit) {
        const retryAfterMs = entry.windowStart + windowMs - now;
        response = {
          allowed: false,
          remaining: 0,
          retryAfterMs,
          resetAt: entry.windowStart + windowMs,
        };
      } else {
        entry.count++;
        response = {
          allowed: true,
          remaining: limit - entry.count,
          resetAt: entry.windowStart + windowMs,
        };
      }
    } else {
      // New window or expired - start fresh
      this.counters.set(clientId, { count: 1, windowStart: now });
      response = {
        allowed: true,
        remaining: limit - 1,
        resetAt: now + windowMs,
      };
    }

    // Avoid redundant storage.getAlarm()/setAlarm() calls while cleanupAlarm is active
    if (!this.cleanupAlarm || this.cleanupAlarm < now) {
      await this.scheduleCleanup(now);
    }

    return response;
  }

  private cleanupExpiredEntries() {
    const now = Date.now();
    // Clean up entries older than 2 minutes (max window is 60 seconds)
    const maxAge = 2 * 60 * 1000;

    for (const [clientId, entry] of this.counters) {
      if (entry.windowStart < now - maxAge) {
        this.counters.delete(clientId);
      }
    }
  }

  private async scheduleCleanup(now: number = Date.now()) {
    const fiveMinutes = 5 * 60 * 1000;

    if (!this.cleanupAlarm || this.cleanupAlarm < now) {
      const target = now + fiveMinutes;
      // Set synchronously so concurrent requests in the same tick don't all hit getAlarm()
      this.cleanupAlarm = target;
      try {
        // Schedule a real DO alarm so cleanup runs even without incoming requests
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (!currentAlarm) {
          await this.ctx.storage.setAlarm(target);
        } else if (currentAlarm > now) {
          this.cleanupAlarm = currentAlarm;
        }
      } catch (error) {
        this.cleanupAlarm = null;
        throw error;
      }
    }
  }

  async alarm() {
    this.cleanupExpiredEntries();
    // Reschedule if there are still entries to track
    if (this.counters.size > 0) {
      const nextAlarm = Date.now() + 5 * 60 * 1000;
      await this.ctx.storage.setAlarm(nextAlarm);
      this.cleanupAlarm = nextAlarm;
    } else {
      this.cleanupAlarm = null;
    }
  }
}
