/**
 * Spec v1.20 (MSC4354) — sticky events as real PDUs: the send parameter,
 * served-event enrichment (remaining duration, redaction, 1h cap) and
 * persistence. Roadmap: ROADMAP-2026-11-23.md M8.
 */
import { describe, expect, it } from 'vitest';
import { parseStickyDurationQuery } from '../src/api/rooms';
import { attachStickyMetadata } from '../src/services/served-events';

/** DB stub returning sticky/received_ts rows for the batched enrichment query. */
function stickyDb(rows: Array<{ event_id: string; sticky: string | null; received_ts?: number | null; origin_server_ts?: number }>) {
  return {
    prepare() {
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

describe('M8 — sticky event query parameter', () => {
  it('accepts only strictly positive integers', () => {
    expect(parseStickyDurationQuery(undefined)).toEqual({ ok: true });
    expect(parseStickyDurationQuery('60000')).toEqual({ ok: true, value: 60000 });
    for (const bad of ['', '0', '-1', '1.5', 'abc', ' 1000', '+5']) {
      expect(parseStickyDurationQuery(bad)).toEqual({ ok: false });
    }
  });
});

describe('M8 — served sticky metadata', () => {
  const NOW = 1_800_000_000_000;

  it('adds the top-level sticky object and the remaining duration', async () => {
    const events = [
      {
        event_id: '$sticky:example.com',
        sender: '@alice:example.com',
        origin_server_ts: NOW - 10_000,
        unsigned: {},
      },
    ];
    const db = stickyDb([
      {
        event_id: '$sticky:example.com',
        sticky: JSON.stringify({ duration_ms: 60_000 }),
        received_ts: NOW - 10_000,
        origin_server_ts: NOW - 10_000,
      },
    ]);
    await attachStickyMetadata(db, events, NOW);
    expect(events[0].sticky).toEqual({ duration_ms: 60_000 });
    expect(events[0].unsigned.sticky_duration_remaining_ms).toBe(50_000);
  });

  it('uses min(received_ts, origin_server_ts) and caps at one hour', async () => {
    // A two-hour request is capped to one hour from the earlier timestamp.
    const events = [
      {
        event_id: '$long:example.com',
        sender: '@alice:example.com',
        origin_server_ts: NOW - 120_000,
        unsigned: {},
      },
    ];
    const db = stickyDb([
      {
        event_id: '$long:example.com',
        sticky: JSON.stringify({ duration_ms: 7_200_000 }),
        received_ts: NOW - 1_800_000,
        origin_server_ts: NOW - 120_000,
      },
    ]);
    await attachStickyMetadata(db, events, NOW);
    // start = min(received, origin) = NOW - 30min; end = start + 1h (capped).
    expect(events[0].unsigned.sticky_duration_remaining_ms).toBe(1_800_000);
  });

  it('keeps sticky but omits the remaining duration once expired', async () => {
    const events = [
      {
        event_id: '$old:example.com',
        sender: '@alice:example.com',
        origin_server_ts: NOW - 120_000,
        unsigned: {},
      },
    ];
    const db = stickyDb([
      {
        event_id: '$old:example.com',
        sticky: JSON.stringify({ duration_ms: 60_000 }),
        received_ts: NOW - 120_000,
        origin_server_ts: NOW - 120_000,
      },
    ]);
    await attachStickyMetadata(db, events, NOW);
    expect(events[0].sticky).toEqual({ duration_ms: 60_000 });
    expect(events[0].unsigned.sticky_duration_remaining_ms).toBeUndefined();
  });

  it('hides sticky from redacted events', async () => {
    const events = [
      {
        event_id: '$redacted:example.com',
        sender: '@alice:example.com',
        origin_server_ts: NOW - 1_000,
        unsigned: { redacted_because: { event_id: '$r:example.com' } },
      },
    ];
    const db = stickyDb([
      {
        event_id: '$redacted:example.com',
        sticky: JSON.stringify({ duration_ms: 60_000 }),
        received_ts: NOW - 1_000,
        origin_server_ts: NOW - 1_000,
      },
    ]);
    await attachStickyMetadata(db, events, NOW);
    expect(events[0].sticky).toBeUndefined();
    expect(events[0].unsigned.sticky_duration_remaining_ms).toBeUndefined();
  });
});

describe('M8 — sticky survives storage', () => {
  it('storeEvent persists the top-level sticky object and receipt clock', async () => {
    const { storeEvent } = await import('../src/services/database');
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        const unbound = {
          async first() {
            return { position: 7 };
          },
          async run() {
            calls.push({ sql, args: [] });
            return { meta: { changes: 1 } };
          },
          bind(...args: unknown[]) {
            return {
              async first() {
                return { position: 7 };
              },
              async run() {
                calls.push({ sql, args });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
        return unbound;
      },
    } as unknown as D1Database;

    await storeEvent(db, {
      event_id: '$sticky:example.com',
      room_id: '!room:example.com',
      sender: '@alice:example.com',
      type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' },
      origin_server_ts: 1_800_000_000_000,
      depth: 3,
      auth_events: ['$a'],
      prev_events: ['$p'],
      sticky: { duration_ms: 60_000 },
    });

    const insert = calls.find((call) => call.sql.includes('INSERT INTO events'));
    expect(insert).toBeDefined();
    expect(insert!.args).toContain(JSON.stringify({ duration_ms: 60_000 }));
  });
});
