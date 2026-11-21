/**
 * MSC4323 (stable since spec v1.18) — account moderation ENFORCEMENT via
 * the real requireAuth middleware against a fake D1:
 *
 *  - locked accounts: 401 M_USER_LOCKED + soft_logout on everything but
 *    POST /logout and /logout/all (sessions are kept, so an unlock restores
 *    access without a fresh login).
 *  - suspended accounts: 403 M_USER_SUSPENDED on the spec's forbidden set
 *    (join/knock/invite incl. by-alias, sending messages, state writes
 *    except self-membership, profile changes, kick/ban/unban) while reads
 *    and the permitted set flow through untouched.
 *
 * No module mocks: the middleware, getUserByTokenHash and the appservice
 * fallback all run for real; only the D1 rows are fake.
 */
import { describe, expect, it, vi } from 'vitest';
import { requireAuth } from '../src/middleware/auth';
import { hashToken } from '../src/utils/crypto';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const REMOTE = '@bob:remote.example.org';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);

// ---------------------------------------------------------------------------
// Fake D1 serving the (single, joined) token lookup
// ---------------------------------------------------------------------------

function tokenDb(
  user: { locked?: number; suspended?: number }
) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                if (args[0] === null) return null as T;
                return {
                  user_id: USER,
                  device_id: 'D',
                  locked: user.locked ?? 0,
                  suspended: user.suspended ?? 0,
                } as T;
              }
              if (sql.includes('FROM appservice_registrations')) {
                return null as T;
              }
              return null as T;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Minimal Hono-ish context + invocation helper
// ---------------------------------------------------------------------------

async function authResult(
  db: D1Database,
  path: string,
  method = 'GET',
  token?: string
) {
  const next = vi.fn(async () => 'next-ok');
  const raw = new Request(`https://${SERVER}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const store = new Map<string, unknown>();
  const ctx = {
    req: { raw, url: raw.url, header: (name: string) => raw.headers.get(name) },
    env: { DB: db, SERVER_NAME: SERVER },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as never;
  const res = (await requireAuth()(ctx, next)) as Response | string;
  if (res instanceof Response) {
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body, nextCalled: next.mock.calls.length };
  }
  return { status: null, body: null, nextCalled: next.mock.calls.length };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MSC4323 requireAuth enforcement', () => {
  const TOKEN = 'moderation-test-token';
  let tokenHash: string;

  async function dbFor(user: { locked?: number; suspended?: number }) {
    if (!tokenHash) tokenHash = await hashToken(TOKEN);
    return tokenDb(user);
  }

  it('locked accounts get 401 M_USER_LOCKED with soft_logout everywhere but logout', async () => {
    const db = await dbFor({ locked: 1 });
    const sync = await authResult(db, '/_matrix/client/v3/sync', 'GET', TOKEN);
    expect(sync.status).toBe(401);
    expect(sync.body).toMatchObject({ errcode: 'M_USER_LOCKED', soft_logout: true });
    expect(sync.nextCalled).toBe(0);

    const logout = await authResult(db, '/_matrix/client/v3/logout', 'POST', TOKEN);
    expect(logout.nextCalled).toBe(1);
    const logoutAll = await authResult(db, '/_matrix/client/v3/logout/all', 'POST', TOKEN);
    expect(logoutAll.nextCalled).toBe(1);
  });

  it('suspended accounts can read but not act', async () => {
    const db = await dbFor({ suspended: 1 });

    const sync = await authResult(db, '/_matrix/client/v3/sync', 'GET', TOKEN);
    expect(sync.nextCalled).toBe(1);

    const join = await authResult(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/join`, 'POST', TOKEN);
    expect(join.status).toBe(403);
    expect(join.body).toMatchObject({ errcode: 'M_USER_SUSPENDED' });

    const knock = await authResult(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/knock`, 'POST', TOKEN);
    expect(knock.status).toBe(403);

    const invite = await authResult(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/invite`, 'POST', TOKEN);
    expect(invite.status).toBe(403);

    const send = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx1`,
      'PUT',
      TOKEN
    );
    expect(send.status).toBe(403);
    expect(send.body).toMatchObject({ errcode: 'M_USER_SUSPENDED' });

    const joinByAlias = await authResult(
      db,
      `/_matrix/client/v3/join/${encodeURIComponent('#general:example.com')}`,
      'POST',
      TOKEN
    );
    expect(joinByAlias.status).toBe(403);

    const profile = await authResult(
      db,
      `/_matrix/client/v3/profile/${encodeURIComponent(USER)}/displayname`,
      'PUT',
      TOKEN
    );
    expect(profile.status).toBe(403);
  });

  it('suspended accounts keep the permitted action set', async () => {
    const db = await dbFor({ suspended: 1 });

    const redactSend = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.redaction/tx2`,
      'PUT',
      TOKEN
    );
    expect(redactSend.nextCalled).toBe(1);

    const redactRoute = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/redact/${encodeURIComponent('$e:example.com')}/tx3`,
      'PUT',
      TOKEN
    );
    expect(redactRoute.nextCalled).toBe(1);

    const leave = await authResult(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/leave`, 'POST', TOKEN);
    expect(leave.nextCalled).toBe(1);

    const selfMemberState = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(USER)}`,
      'PUT',
      TOKEN
    );
    expect(selfMemberState.nextCalled).toBe(1);

    const nameState = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.name`,
      'PUT',
      TOKEN
    );
    expect(nameState.status).toBe(403);

    const inviteState = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.member/${encodeURIComponent(REMOTE)}`,
      'PUT',
      TOKEN
    );
    expect(inviteState.status).toBe(403);

    const kick = await authResult(db, `/_matrix/client/v3/rooms/${ROOM_ENC}/kick`, 'POST', TOKEN);
    expect(kick.status).toBe(403);
  });

  it('unmoderated accounts are completely unaffected', async () => {
    const db = await dbFor({});
    const send = await authResult(
      db,
      `/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx1`,
      'PUT',
      TOKEN
    );
    expect(send.nextCalled).toBe(1);
  });
});
