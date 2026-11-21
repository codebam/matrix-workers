/**
 * Regression coverage for the inbound m.presence EDU path.
 *
 * presence.user_id has a FOREIGN KEY to users, but remote federation senders
 * have no local users row. Before the fix every remote presence write failed
 * with SQLITE_CONSTRAINT_FOREIGNKEY, was swallowed by the /send EDU catch, and
 * the presence was never persisted. These tests use a D1 double that actually
 * enforces that FK, so a regression fails loudly instead of being swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'remote.example.com';
const REMOTE_USER = '@bob:remote.example.com';
const LOCAL_USER = '@alice:example.com';
const FK_ERROR = 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('federationOrigin', ORIGIN);
    await next();
  },
  optionalFederationAuth: () => async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('federationOrigin', ORIGIN);
    await next();
  },
}));

import federation from '../src/api/federation';
import { ensurePresenceUserRow, recordPresenceChange } from '../src/api/presence';

type UserRow = {
  user_id: string;
  localpart: string;
  admin: number;
  is_deactivated: number;
  display_name?: string | null;
};
type PresenceRow = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number;
  currently_active: number;
  stream_position: number;
};

function makeDb() {
  const users = new Map<string, UserRow>();
  const presence = new Map<string, PresenceRow>();
  const streamPositions = new Map<string, number>([['presence', 0]]);
  const statements: string[] = [];

  function enforceFk(userId: string) {
    if (!users.has(userId)) throw new Error(FK_ERROR);
  }

  function execute(sql: string, args: unknown[]) {
    statements.push(sql);

    if (sql.includes('INSERT OR IGNORE INTO users')) {
      const [userId, localpart] = args as [string, string];
      if (!users.has(userId)) {
        users.set(userId, { user_id: userId, localpart, admin: 0, is_deactivated: 0 });
      }
      return;
    }
    if (sql.includes('UPDATE stream_positions SET position = position + 1')) {
      const name = args[0] as string | undefined;
      const key = name ?? 'presence';
      streamPositions.set(key, (streamPositions.get(key) ?? 0) + 1);
      return;
    }
    if (sql.includes('INSERT INTO presence')) {
      const userId = args[0] as string;
      enforceFk(userId);
      const stamped = sql.includes('stream_position');
      // The batch form derives its position from the COALESCE subquery; the
      // serialized fallback binds it as the sixth argument.
      const selectForm = sql.includes('SELECT ?, ?, ?, ?, ?, COALESCE');
      const position = selectForm
        ? (streamPositions.get('presence') ?? 0)
        : (args[5] as number);
      const row: PresenceRow = stamped
        ? {
            user_id: userId,
            presence: args[1] as string,
            status_msg: (args[2] as string | null) ?? null,
            last_active_ts: args[3] as number,
            currently_active: args[4] as number,
            stream_position: position,
          }
        : {
            user_id: userId,
            presence: args[1] as string,
            status_msg: (args[2] as string | null) ?? null,
            last_active_ts: args[3] as number,
            currently_active: 0,
            stream_position: 0,
          };
      if (!stamped && sql.includes('currently_active')) {
        row.currently_active = args[4] as number;
      }
      presence.set(userId, row);
      return;
    }
  }

  type Stmt = {
    sql: string;
    args: unknown[];
    bind(...args: unknown[]): Stmt;
    run(): Promise<{ success: boolean; meta: { changes: number } }>;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
  };

  function prepare(sql: string): Stmt {
    const stmt: Stmt = {
      sql,
      args: [],
      bind(...args: unknown[]) {
        stmt.args = args;
        return stmt;
      },
      async run() {
        execute(sql, stmt.args);
        return { success: true, meta: { changes: 1 } };
      },
      async first<T>() {
        statements.push(sql);
        if (sql.includes('SELECT position FROM stream_positions')) {
          return { position: streamPositions.get('presence') ?? 0 } as T;
        }
        return null as T;
      },
      async all<T>() {
        statements.push(sql);
        return { results: [] as T[] };
      },
    };
    return stmt;
  }

  const db = {
    users,
    presence,
    streamPositions,
    statements,
    prepare,
    async batch(stmts: Stmt[]) {
      // D1 batches are transactional: roll back if any statement throws.
      const beforeUsers = new Map(users);
      const beforePresence = new Map(presence);
      const beforeStreams = new Map(streamPositions);
      try {
        for (const s of stmts) execute(s.sql, s.args);
      } catch (err) {
        users.clear(); beforeUsers.forEach((v, k) => users.set(k, v));
        presence.clear(); beforePresence.forEach((v, k) => presence.set(k, v));
        streamPositions.clear(); beforeStreams.forEach((v, k) => streamPositions.set(k, v));
        throw err;
      }
      return [];
    },
  };
  return db;
}

const UPDATE = {
  userId: REMOTE_USER,
  presence: 'online',
  statusMsg: 'at the pub',
  lastActiveTs: 1_700_000_000_000,
  currentlyActive: true,
};

describe('remote-user presence FK regression', () => {
  it('proves the FK double rejects a presence write when no users row exists', async () => {
    const db = makeDb();
    await expect(recordPresenceChange(db as unknown as D1Database, UPDATE)).rejects.toThrow(
      /FOREIGN KEY constraint failed/
    );
    expect(db.presence.has(REMOTE_USER)).toBe(false);
  });

  it('seeds a placeholder users row and persists/stamps remote presence', async () => {
    const db = makeDb();

    await ensurePresenceUserRow(db as unknown as D1Database, REMOTE_USER);
    await recordPresenceChange(db as unknown as D1Database, UPDATE);

    expect(db.users.get(REMOTE_USER)).toMatchObject({
      user_id: REMOTE_USER,
      localpart: 'bob',
      admin: 0,
      is_deactivated: 0,
    });
    const row = db.presence.get(REMOTE_USER);
    expect(row).toMatchObject({
      presence: 'online',
      status_msg: 'at the pub',
      last_active_ts: UPDATE.lastActiveTs,
      currently_active: 1,
      stream_position: 1,
    });
    expect(db.streamPositions.get('presence')).toBe(1);
  });

  it('does not overwrite an existing local users row', async () => {
    const db = makeDb();
    db.users.set(LOCAL_USER, {
      user_id: LOCAL_USER,
      localpart: 'alice',
      admin: 1,
      is_deactivated: 0,
      display_name: 'Alice',
    });

    await ensurePresenceUserRow(db as unknown as D1Database, LOCAL_USER);
    await recordPresenceChange(db as unknown as D1Database, { ...UPDATE, userId: LOCAL_USER });

    expect(db.users.get(LOCAL_USER)).toMatchObject({ admin: 1, display_name: 'Alice' });
    expect(db.presence.get(LOCAL_USER)?.stream_position).toBe(1);
  });
});

describe('inbound m.presence EDU through PUT /send', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('persists a remote user presence without logging an FK failure', async () => {
    const db = makeDb();
    const env = {
      SERVER_NAME: 'example.com',
      SERVER_VERSION: 'test-0.1.0',
      DB: db as unknown as D1Database,
      CACHE: {
        get: async () => null,
        put: async () => {},
      } as unknown as KVNamespace,
    };

    const res = await federation.request(
      'http://localhost/_matrix/federation/v1/send/txn-presence-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdus: [],
          edus: [{
            edu_type: 'm.presence',
            content: {
              push: [{
                user_id: REMOTE_USER,
                presence: 'online',
                status_msg: 'at the pub',
                last_active_ago: 1000,
                currently_active: true,
              }],
            },
          }],
        }),
      },
      env as never
    );

    expect(res.status).toBe(200);
    expect(
      warnSpy.mock.calls.filter((call) => String(call[0]).includes('Failed to update presence'))
    ).toEqual([]);
    expect(db.users.has(REMOTE_USER)).toBe(true);
    expect(db.presence.get(REMOTE_USER)).toMatchObject({
      presence: 'online',
      status_msg: 'at the pub',
      currently_active: 1,
      stream_position: 1,
    });
  });
});
