// MSC3856 (v1 unstable) threads pagination: `from` is an origin_server_ts
// cursor in the same decimal-string token format as the sibling relations
// endpoints' `next_batch`. Threads are always newest-first, so `from` is an
// exclusive upper bound and the token comes from the last returned root.
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICE');
      await next();
    };
  },
}));

import relations from '../src/api/relations';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);
const THREADS = `/_matrix/client/v1/rooms/${ROOM_ENC}/threads`;

type Membership = { room_id: string; user_id: string; membership: string };

type EventRow = {
  event_id: string;
  room_id: string;
  event_type: string;
  sender: string;
  origin_server_ts: number;
  content: string;
  relates_to_event_id: string | null;
  relation_type: string | null;
};

type SqlCall = { sql: string; args: unknown[] };

/**
 * Minimal D1 stand-in for the threads query. It deliberately mirrors SQLite's
 * `LIMIT (? + 1)` semantics: the bound value is the requested page size and
 * one extra row is fetched to detect the next page.
 */
function createThreadsDb(opts: {
  memberships?: Membership[];
  events?: EventRow[];
} = {}) {
  const memberships = opts.memberships ?? [];
  const events = opts.events ?? [];
  const selects: SqlCall[] = [];

  const db = {
    selects,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              selects.push({ sql, args });
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find(
                  (m) => m.room_id === roomId && m.user_id === userId
                );
                return (row ? { membership: row.membership } : null) as T;
              }
              return null as T;
            },

            async all<T>() {
              selects.push({ sql, args });

              if (
                sql.includes('event_id IN') &&
                sql.includes("relation_type = 'm.thread'")
              ) {
                const roomId = args[0] as string;
                let idx = 2; // [roomId, roomId] from the IN subquery
                const participated = sql.includes('e.sender = ?');
                if (participated) idx += 2; // the two userId binds
                const from = sql.includes('e.origin_server_ts < ?')
                  ? (args[idx] as number)
                  : null;
                const limit = args[args.length - 1] as number;

                const roots = events.filter(
                  (e) =>
                    e.room_id === roomId &&
                    events.some(
                      (child) =>
                        child.room_id === roomId &&
                        child.relation_type === 'm.thread' &&
                        child.relates_to_event_id === e.event_id
                    )
                );

                let filtered = roots;
                if (participated) {
                  const userId = args[2] as string;
                  filtered = filtered.filter(
                    (e) =>
                      e.sender === userId ||
                      events.some(
                        (r) =>
                          r.relates_to_event_id === e.event_id &&
                          r.sender === userId
                      )
                  );
                }
                if (from !== null) {
                  filtered = filtered.filter((e) => e.origin_server_ts < from);
                }

                const ordered = [...filtered].sort(
                  (a, b) => b.origin_server_ts - a.origin_server_ts
                );
                // SQLite executes LIMIT (? + 1): one extra probe row.
                return {
                  results: ordered.slice(0, limit + 1).map((e) => ({
                    event_id: e.event_id,
                    event_type: e.event_type,
                    sender: e.sender,
                    origin_server_ts: e.origin_server_ts,
                    content: e.content,
                  })) as T[],
                };
              }

              return { results: [] as T[] };
            },

            async run() {
              throw new Error(`Unexpected run(): ${sql.slice(0, 100)}`);
            },
          };
        },
      };
    },
  };

  return db;
}

type ThreadsDb = ReturnType<typeof createThreadsDb>;

function envFor(db: ThreadsDb): Env {
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: 'example.com',
  } as unknown as Env;
}

async function request(
  db: ThreadsDb,
  path: string
): Promise<{ status: number; body: any }> {
  const res = await relations.request(
    `http://localhost${path}`,
    { headers: { Authorization: 'Bearer t' } },
    envFor(db)
  );
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

function joinMember(membership = 'join'): Membership {
  return { room_id: ROOM, user_id: USER, membership };
}

function root(id: string, ts: number, sender = USER): EventRow {
  return {
    event_id: id,
    room_id: ROOM,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({ body: `root-${id}` }),
    relates_to_event_id: null,
    relation_type: null,
  };
}

function reply(id: string, rootId: string, ts: number, sender = USER): EventRow {
  return {
    event_id: id,
    room_id: ROOM,
    event_type: 'm.room.message',
    sender,
    origin_server_ts: ts,
    content: JSON.stringify({ body: `reply-${id}` }),
    relates_to_event_id: rootId,
    relation_type: 'm.thread',
  };
}

/** Five thread roots at ts 100..500, each with one m.thread reply. */
function fiveThreads(): EventRow[] {
  const events: EventRow[] = [];
  for (let i = 1; i <= 5; i++) {
    events.push(root(`$r${i}`, i * 100));
    events.push(reply(`$t${i}`, `$r${i}`, i * 100 + 1));
  }
  return events;
}

type Page = {
  chunk: Array<{ event_id: string; origin_server_ts: number }>;
  next_batch?: string;
};

describe('GET /v1/rooms/:roomId/threads pagination', () => {
  it('walks every thread across pages using next_batch as the from cursor', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: fiveThreads(),
    });

    const page1 = (await request(db, `${THREADS}?limit=2`)).body as Page;
    expect(page1.chunk.map((e) => e.event_id)).toEqual(['$r5', '$r4']);
    // Token is the LAST RETURNED root's ts, never the extra probe row ($r3=300).
    expect(page1.next_batch).toBe('400');

    const page2 = (
      await request(db, `${THREADS}?limit=2&from=${page1.next_batch}`)
    ).body as Page;
    expect(page2.chunk.map((e) => e.event_id)).toEqual(['$r3', '$r2']);
    expect(page2.next_batch).toBe('200');

    const page3 = (
      await request(db, `${THREADS}?limit=2&from=${page2.next_batch}`)
    ).body as Page;
    expect(page3.chunk.map((e) => e.event_id)).toEqual(['$r1']);
    expect(page3.next_batch).toBeUndefined();

    const page4 = (
      await request(db, `${THREADS}?limit=2&from=100`)
    ).body as Page;
    expect(page4).toEqual({ chunk: [] });

    const seen = [page1, page2, page3, page4].flatMap((p) =>
      p.chunk.map((e) => e.event_id)
    );
    expect(seen.sort()).toEqual(['$r1', '$r2', '$r3', '$r4', '$r5']);
  });

  it('from is a strict, exclusive origin_server_ts upper bound', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: fiveThreads(),
    });
    const body = (await request(db, `${THREADS}?from=300`)).body as Page;
    // $r3 (ts 300) itself is excluded; only strictly older roots remain.
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$r2', '$r1']);
    expect(body.next_batch).toBeUndefined();
  });

  it('from=0 and non-numeric from are handled as parseInt (documented)', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: fiveThreads(),
    });
    const zero = (await request(db, `${THREADS}?from=0`)).body as Page;
    expect(zero).toEqual({ chunk: [] });
    const nan = (await request(db, `${THREADS}?from=nope`)).body as Page;
    expect(nan).toEqual({ chunk: [] });
    expect(
      db.selects.at(-1)?.args.some(
        (arg) => typeof arg === 'number' && Number.isNaN(arg)
      )
    ).toBe(true);
  });

  it('fetches limit+1 rows but binds the page size as the limit', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: fiveThreads(),
    });
    await request(db, `${THREADS}?limit=2&from=500`);
    const query = db.selects.at(-1)!;
    expect(query.sql).toMatch(/e\.origin_server_ts < \?/);
    expect(query.sql).toMatch(/LIMIT \(\? \+ 1\)/);
    expect(query.args).toEqual([ROOM, ROOM, 500, 2]);
  });

  it('omits next_batch when the result fits in one page', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: [root('$only', 10), reply('$t', '$only', 11)],
    });
    const body = await request(db, THREADS);
    expect(body.status).toBe(200);
    expect(body.body).toEqual({
      chunk: [
        {
          event_id: '$only',
          type: 'm.room.message',
          sender: USER,
          origin_server_ts: 10,
          content: { body: 'root-$only' },
          room_id: ROOM,
        },
      ],
    });
  });

  it('include=participated still filters roots and paginates the filtered set', async () => {
    const db = createThreadsDb({
      memberships: [joinMember()],
      events: [
        root('$theirs', 100, BOB), // no participation by USER
        root('$mine', 200, USER),
        root('$alsoTheirs', 300, BOB),
        root('$joined', 400, BOB),
        reply('$r1', '$theirs', 101, BOB),
        reply('$r2', '$mine', 201, BOB),
        reply('$r3', '$alsoTheirs', 301, BOB),
        reply('$r4', '$joined', 401, USER), // USER replied → participated
      ],
    });

    const page1 = (
      await request(db, `${THREADS}?include=participated&limit=1`)
    ).body as Page;
    expect(page1.chunk.map((e) => e.event_id)).toEqual(['$joined']);
    expect(page1.next_batch).toBe('400');

    const page2 = (
      await request(
        db,
        `${THREADS}?include=participated&limit=1&from=${page1.next_batch}`
      )
    ).body as Page;
    expect(page2.chunk.map((e) => e.event_id)).toEqual(['$mine']);
    expect(page2.next_batch).toBeUndefined();

    const seen = [page1, page2].flatMap((p) => p.chunk.map((e) => e.event_id));
    expect(seen.sort()).toEqual(['$joined', '$mine']);
    expect(db.selects.at(-1)?.args).toEqual([ROOM, ROOM, USER, USER, 400, 1]);
  });

  it.each([
    ['missing', undefined],
    ['invite', 'invite'],
    ['ban', 'ban'],
    ['knock', 'knock'],
  ])('membership=%s is still rejected with 403', async (_label, membership) => {
    const db = createThreadsDb({
      memberships: membership ? [joinMember(membership)] : [],
      events: fiveThreads(),
    });
    const res = await request(db, `${THREADS}?limit=2`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.selects.some((s) => s.sql.includes('event_id IN'))).toBe(false);
  });

  it('leave membership can still page through threads', async () => {
    const db = createThreadsDb({
      memberships: [joinMember('leave')],
      events: fiveThreads(),
    });
    const body = (await request(db, `${THREADS}?limit=2`)).body as Page;
    expect(body.chunk.map((e) => e.event_id)).toEqual(['$r5', '$r4']);
    expect(body.next_batch).toBe('400');
  });
});
