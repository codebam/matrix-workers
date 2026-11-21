import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getPresenceEventsForSync } from '../src/api/sync';

/**
 * Pins the presence projection used by legacy /sync. `toPresenceEvent` is
 * intentionally private, so it is exercised through the exported helper with
 * a stub D1. The activity cutoff mirrors PRESENCE_TIMEOUT_MS in sync.ts.
 */
const NOW = 1_700_000_000_000;
const TIMEOUT_MS = 5 * 60 * 1000;

interface PresenceRow {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number | null;
  currently_active?: number | boolean | null;
}

interface StubOptions {
  roomMembers?: Record<string, string[]>;
  presence?: PresenceRow[];
}

function createSyncPresenceDb(options: StubOptions = {}) {
  const roomMembers = options.roomMembers ?? {};
  const presence = options.presence ?? [];
  const queries: string[] = [];
  const binds: unknown[][] = [];

  const db = {
    queries,
    binds,
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(...args: unknown[]) {
          binds.push(args);
          return {
            async all<T>() {
              if (sql.includes('FROM presence')) {
                if (sql.includes('user_id IN (')) {
                  const ids = args as string[];
                  return { results: presence.filter((row) => ids.includes(row.user_id)) as T[] };
                }
                return { results: presence as T[] };
              }
              if (sql.includes('FROM room_memberships')) {
                const [roomId] = args as [string];
                return {
                  results: (roomMembers[roomId] ?? []).map((user_id) => ({ user_id })) as T[],
                };
              }
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  return db as unknown as D1Database & { queries: string[]; binds: unknown[][] };
}

describe('getPresenceEventsForSync — initial presence slice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes the caller and joined members, deduped, with mapped presence content', async () => {
    const db = createSyncPresenceDb({
      roomMembers: {
        '!a:example.com': ['@alice:example.com', '@bob:example.com'],
        '!b:example.com': ['@alice:example.com', '@carol:example.com'],
      },
      presence: [
        {
          user_id: '@me:example.com',
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - 1000,
        },
        {
          user_id: '@alice:example.com',
          presence: 'online',
          status_msg: 'hi',
          last_active_ts: NOW - 2000,
        },
        {
          user_id: '@bob:example.com',
          presence: 'unavailable',
          status_msg: null,
          last_active_ts: null,
        },
      ],
    });

    const events = await getPresenceEventsForSync(
      db,
      '@me:example.com',
      ['!a:example.com', '!b:example.com']
    );

    expect(events).toEqual([
      {
        type: 'm.presence',
        sender: '@me:example.com',
        content: {
          presence: 'online',
          last_active_ago: 1000,
          currently_active: true,
        },
      },
      {
        type: 'm.presence',
        sender: '@alice:example.com',
        content: {
          presence: 'online',
          status_msg: 'hi',
          last_active_ago: 2000,
          currently_active: true,
        },
      },
      {
        type: 'm.presence',
        sender: '@bob:example.com',
        content: {
          presence: 'unavailable',
          last_active_ago: NOW,
          currently_active: false,
        },
      },
    ]);

    // Alice appears in two rooms but must only be queried once (deduped Set).
    const presenceQuery = db.queries.find((q) => q.includes('FROM presence'));
    const ids = db.binds[db.queries.indexOf(presenceQuery!)] as string[];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('@carol:example.com');
    expect(events.some((event) => event.sender === '@carol:example.com')).toBe(false);
  });

  it('degrades a stale "online" row to unavailable at the activity cutoff', async () => {
    const db = createSyncPresenceDb({
      presence: [
        {
          user_id: '@me:example.com',
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - TIMEOUT_MS,
          currently_active: 1,
        },
      ],
    });

    expect(await getPresenceEventsForSync(db, '@me:example.com', [])).toEqual([
      {
        type: 'm.presence',
        sender: '@me:example.com',
        content: {
          presence: 'unavailable',
          last_active_ago: TIMEOUT_MS,
          currently_active: false,
        },
      },
    ]);
  });

  it('honors a stored currently_active=0 over the recent-activity heuristic', async () => {
    const db = createSyncPresenceDb({
      presence: [
        {
          user_id: '@me:example.com',
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - 1000,
          currently_active: 0,
        },
      ],
    });

    const [event] = await getPresenceEventsForSync(db, '@me:example.com', []);
    expect(event.content).toMatchObject({ presence: 'online', currently_active: false });
  });

  it('incremental sync replays cursor-newer rows in stream order', async () => {
    const db = createSyncPresenceDb({
      presence: [
        {
          user_id: '@alice:example.com',
          presence: 'online',
          status_msg: null,
          last_active_ts: NOW - 500,
        },
        {
          user_id: '@bob:example.com',
          presence: 'offline',
          status_msg: 'away',
          last_active_ts: NOW - 10_000,
        },
      ],
    });

    const events = await getPresenceEventsForSync(db, '@me:example.com', [], 42);

    expect(events.map((event) => event.sender)).toEqual([
      '@alice:example.com',
      '@bob:example.com',
    ]);
    expect(events[0].content.currently_active).toBe(true);
    expect(events[1].content).toMatchObject({ presence: 'offline', status_msg: 'away' });
    const incrementalQuery = db.queries.find((q) => q.includes('stream_position > ?'));
    expect(incrementalQuery).toBeDefined();
    expect(db.binds[db.queries.indexOf(incrementalQuery!)]).toEqual([42, '@me:example.com', '@me:example.com']);
  });

  it('returns no events when no presence rows exist', async () => {
    const db = createSyncPresenceDb();
    expect(await getPresenceEventsForSync(db, '@me:example.com', [])).toEqual([]);
  });
});
