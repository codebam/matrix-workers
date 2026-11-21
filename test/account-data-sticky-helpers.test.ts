// Focused tests for the exported sticky-event helpers in src/api/account-data.ts
// that have no direct test: parseStickyDuration, putStickyEvent,
// getStickyEventsForRooms and getStickyEventsForRoom. Only the helpers' own
// behaviour is exercised; the D1 binding is a small in-memory stub.
import { describe, expect, it } from 'vitest';
import {
  STICKY_EVENT_TYPE_PREFIX,
  getStickyEventsForRoom,
  getStickyEventsForRooms,
  parseStickyDuration,
  putStickyEvent,
  type StickyEventRecord,
} from '../src/api/account-data';

const NOW = 1_700_000_000_000;
const ROOM = '!r:ex';
const USER = '@a:ex';

type AccountDataRow = { user_id: string; room_id: string; event_type: string; content: string };
type ChangeRow = { user_id: string; room_id: string; event_type: string; stream_position: number };

function createStickyDb() {
  const rows: AccountDataRow[] = [];
  const changes: ChangeRow[] = [];
  const positions = new Map<string, number>([['account_data', 0]]);

  const latestPos = (row: AccountDataRow) =>
    changes
      .filter((c) => c.user_id === row.user_id && c.room_id === row.room_id && c.event_type === row.event_type)
      .reduce((max, c) => Math.max(max, c.stream_position), -Infinity);

  function executor(sql: string, args: unknown[]) {
    const q = sql.replace(/\s+/g, ' ').trim();
    return {
      async run() {
        return { success: true };
      },
      async first<T>(): Promise<T | null> {
        if (q.includes('SELECT position FROM stream_positions')) {
          return { position: positions.get(String(args[0])) ?? 0 } as T;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (q.includes('event_type LIKE ?')) {
          const incremental = q.includes('HAVING MAX(adc.stream_position)');
          const since = incremental ? Number(args[args.length - 1]) : -Infinity;
          const roomIds = args.filter((a) => typeof a === 'string' && String(a).startsWith('!')) as string[];
          return {
            results: rows
              .filter((row) => roomIds.includes(row.room_id) && row.event_type.startsWith(STICKY_EVENT_TYPE_PREFIX))
              .filter((row) => !incremental || latestPos(row) > since)
              .map((row) => ({ ...row, stream_position: latestPos(row) })) as unknown as T[],
          };
        }
        return { results: [] as T[] };
      },
    };
  }

  const db = {
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          if (q.includes('INSERT INTO account_data (user_id, room_id, event_type, content)')) {
            const [userId, roomId, eventType, content] = args as string[];
            const idx = rows.findIndex(
              (row) => row.user_id === userId && row.room_id === roomId && row.event_type === eventType
            );
            const row = { user_id: userId, room_id: roomId, event_type: eventType, content };
            if (idx >= 0) rows[idx] = row;
            else rows.push(row);
          } else if (q.includes('INSERT INTO account_data_changes')) {
            const [userId, roomId, eventType, streamPosition] = args as [string, string, string, number];
            changes.push({ user_id: userId, room_id: roomId, event_type: eventType, stream_position: streamPosition });
          } else if (q.includes('UPDATE stream_positions')) {
            const name = String(args[0]);
            positions.set(name, (positions.get(name) ?? 0) + 1);
          }
          return executor(sql, args);
        },
        ...executor(sql, []),
      };
    },
  };
  return { db: db as unknown as D1Database, rows, changes };
}

function put(db: D1Database, opts: { txnId: string; eventId?: string; receivedTs?: number; body?: string; durationMs?: number }) {
  return putStickyEvent(db, {
    userId: USER,
    roomId: ROOM,
    eventType: 'm.room.message',
    txnId: opts.txnId,
    durationMs: opts.durationMs ?? 10_000,
    content: { body: opts.body ?? opts.txnId },
    eventId: opts.eventId,
    originServerTs: opts.receivedTs ?? NOW,
    receivedTs: opts.receivedTs ?? NOW,
  });
}

describe('parseStickyDuration', () => {
  it('accepts positive integers and digit strings', () => {
    expect(parseStickyDuration(1)).toBe(1);
    expect(parseStickyDuration(300_000)).toBe(300_000);
    expect(parseStickyDuration('42')).toBe(42);
    expect(parseStickyDuration('007')).toBe(7);
  });

  it('rejects zero, negatives, floats, Infinity and malformed strings', () => {
    for (const bad of [0, -1, 1.5, Infinity, NaN, null, undefined, true, {}, []]) {
      expect(parseStickyDuration(bad)).toBeNull();
    }
    for (const bad of ['', '0', '-1', '1.5', ' 5', '5x', '+5']) {
      expect(parseStickyDuration(bad)).toBeNull();
    }
  });
});

describe('putStickyEvent', () => {
  it('prefixes a generated id, stores the record and records one stream change', async () => {
    const { db, rows, changes } = createStickyDb();

    const record = await put(db, { txnId: 't1' });

    expect(record.event_id).toBe('$msc4354_@a:ex_!r:ex_t1');
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe(`${STICKY_EVENT_TYPE_PREFIX}${record.event_id}`);
    expect(JSON.parse(rows[0].content)).toEqual(record);
    expect(changes).toEqual([
      { user_id: USER, room_id: ROOM, event_type: rows[0].event_type, stream_position: 1 },
    ]);
  });

  it('keeps an explicit $ event id and upserts a repeat with a fresh stream position', async () => {
    const { db, rows, changes } = createStickyDb();

    const first = await put(db, { txnId: 'a', eventId: '$custom', body: 'one' });
    const second = await put(db, { txnId: 'b', eventId: '$custom', body: 'two', receivedTs: NOW + 1 });

    expect(first.event_id).toBe('$custom');
    expect(second.event_id).toBe('$custom');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toEqual(second);
    expect(changes.map((change) => change.stream_position)).toEqual([1, 2]);
  });
});

describe('getStickyEventsForRooms', () => {
  it('returns an empty map for no rooms', async () => {
    const { db } = createStickyDb();
    expect(await getStickyEventsForRooms(db, [])).toEqual({});
  });

  it('returns unexpired events oldest-first, clamps the limit and honours since', async () => {
    const { db } = createStickyDb();
    await put(db, { txnId: 'a', receivedTs: NOW - 3_000, body: 'a' });
    await put(db, { txnId: 'b', receivedTs: NOW - 2_000, body: 'b' });
    await put(db, { txnId: 'c', receivedTs: NOW - 1_000, body: 'c' });

    const capped = await getStickyEventsForRooms(db, [ROOM], { now: NOW, limit: 2 });
    expect(capped[ROOM].map((event) => event.content.body)).toEqual(['a', 'b']);

    const floored = await getStickyEventsForRooms(db, [ROOM], { now: NOW, limit: 0 });
    expect(floored[ROOM].map((event) => event.content.body)).toEqual(['a']);

    const incremental = await getStickyEventsForRooms(db, [ROOM], { now: NOW, since: 2 });
    expect(incremental[ROOM].map((event) => event.content.body)).toEqual(['c']);
  });

  it('drops expired events', async () => {
    const { db } = createStickyDb();
    await put(db, { txnId: 'short', durationMs: 1_000 });

    expect(await getStickyEventsForRooms(db, [ROOM], { now: NOW + 1_001 })).toEqual({});
  });

  it('chunks room ids past the D1 bind limit', async () => {
    const { db } = createStickyDb();
    const roomIds = Array.from({ length: 91 }, (_, i) => `!r${i}:ex`);
    await putStickyEvent(db, {
      userId: USER,
      roomId: roomIds[90],
      eventType: 'm.room.message',
      txnId: 'edge',
      durationMs: 10_000,
      content: { body: 'edge' },
      originServerTs: NOW,
      receivedTs: NOW,
    });

    const result = await getStickyEventsForRooms(db, roomIds, { now: NOW });
    expect(result[roomIds[90]]).toHaveLength(1);
  });
});

describe('getStickyEventsForRoom', () => {
  it('returns the room slice or an empty array', async () => {
    const { db } = createStickyDb();
    expect(await getStickyEventsForRoom(db, '!missing:ex', { now: NOW })).toEqual([]);

    await put(db, { txnId: 'only' });
    const events = await getStickyEventsForRoom(db, ROOM, { now: NOW });
    expect(events).toHaveLength(1);
    expect(events[0].content.body).toBe('only');
  });

  it('returns a typed record with both sticky duration shapes', async () => {
    const { db, rows } = createStickyDb();
    await put(db, { txnId: 'typed', durationMs: 5_000 });

    const [event] = await getStickyEventsForRoom(db, ROOM, { now: NOW });
    const record = JSON.parse(rows[0].content) as StickyEventRecord;
    expect(record.duration_ms).toBe(5_000);
    expect(event.sticky).toEqual({ duration_ms: 5_000 });
    expect(event.msc4354_sticky).toEqual({ duration_ms: 5_000 });
    expect(event.unsigned.sticky_duration_remaining_ms).toBe(5_000);
  });
});
