// MSC4140 delayed events scheduler. A single global instance owns the alarm
// that dispatches due delayed events; API handlers re-arm it via /schedule.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { dispatchDueDelayedEvents } from '../services/delayed-events';

export class DelayedEventsDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/schedule' && request.method === 'POST') {
      const { due_ts } = await request.json() as { due_ts: number };
      const current = await this.ctx.storage.get<number>('next_due');
      if (current == null || due_ts < current) {
        await this.ctx.storage.put('next_due', due_ts);
        await this.ctx.storage.setAlarm(due_ts);
      }
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const next = await dispatchDueDelayedEvents(this.env);
    if (next != null) {
      await this.ctx.storage.put('next_due', next);
      await this.ctx.storage.setAlarm(next);
    } else {
      await this.ctx.storage.delete('next_due');
    }
  }
}