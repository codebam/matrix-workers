/**
 * Spec v1.20 (MSC4140) — delayed events: stabilized paths and sender-only
 * `unsigned.delay_id`. Roadmap: ROADMAP-2026-11-23.md M1.
 */
import { describe, expect, it } from 'vitest';
import delayedEvents from '../src/api/delayed-events';
import { attachDelayIds } from '../src/services/served-events';

type Route = { method: string; path: string };

// Hono reports each registered route twice (the router keeps both the
// sub-app and the flattened entry), so the table is deduplicated.
const routeTable = (mod: { routes: Route[] }): string[] =>
  [...new Set(mod.routes.map((r) => `${r.method} ${r.path}`))];

/** Minimal D1 stand-in for the single batched delayed_events lookup. */
function fakeDelayDb(rows: Array<{ final_event_id: string; delay_id: string }>, onQuery?: (sql: string) => void) {
  return {
    prepare(sql: string) {
      onQuery?.(sql);
      return {
        bind() {
          return {
            async all() {
              return { results: rows };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('M1 — delayed events stabilized surface', () => {
  it('registers the spec v1.20 paths alongside the unstable aliases', () => {
    const routes = routeTable(delayedEvents);
    expect(routes).toContain(
      'PUT /_matrix/client/v3/rooms/:roomId/delayed_event/:eventType/:txnId'
    );
    expect(routes).toContain('GET /_matrix/client/v1/delayed_events/:delayId');
    expect(routes).toContain('POST /_matrix/client/v1/delayed_events/:delayId/:action');
    // compatibility aliases stay registered
    expect(routes).toContain(
      'PUT /_matrix/client/unstable/org.matrix.msc4140/rooms/:roomId/delayed_event/:eventType/:txnId'
    );
    expect(routes).toContain(
      'GET /_matrix/client/unstable/org.matrix.msc4140/delayed_events/:delayId'
    );
  });

  it('exposes send/cancel/restart through the :action parameter', () => {
    const routes = routeTable(delayedEvents);
    // The single :action route covers all three spec endpoints; pin that no
    // bespoke route hides a typo in one of them.
    expect(routes).toContain('POST /_matrix/client/v1/delayed_events/:delayId/:action');
    expect(routes.filter((r) => r.includes('/delayed_events/') && r.startsWith('POST')).length).toBe(2);
  });

  it('attaches unsigned.delay_id to the sender only', async () => {
    const events = [
      { event_id: '$delayed:1', sender: '@alice:example.com', unsigned: {} },
      { event_id: '$other:1', sender: '@bob:example.com', unsigned: {} },
    ];
    const queried: string[] = [];
    await attachDelayIds(fakeDelayDb([{ final_event_id: '$delayed:1', delay_id: 'delay-1' }], (sql) => queried.push(sql)), events, '@alice:example.com');

    expect(events[0].unsigned.delay_id).toBe('delay-1');
    expect(events[1].unsigned.delay_id).toBeUndefined();
    expect(queried).toHaveLength(1);
    expect(queried[0]).toContain('delayed_events');
  });

  it('does not query or mutate anything without a viewer', async () => {
    const events = [{ event_id: '$delayed:1', sender: '@alice:example.com', unsigned: {} }];
    await attachDelayIds(fakeDelayDb([], () => {
      throw new Error('must not query');
    }), events, null);
    expect(events[0].unsigned.delay_id).toBeUndefined();
  });

  it('swallows lookup failures so serving never breaks', async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error('D1 down');
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const events = [{ event_id: '$delayed:1', sender: '@alice:example.com', unsigned: {} }];
    await expect(attachDelayIds(db, events, '@alice:example.com')).resolves.toBeUndefined();
  });
});
