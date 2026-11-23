/**
 * MSC4183 (Matrix v1.18): a wrong or expired email-validation token must
 * return 400 M_TOKEN_INCORRECT on both the Identity Service submitToken
 * endpoint and the client-server 3pid submit_token endpoint. Unknown
 * sessions keep their pre-existing error codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const emailMocks = vi.hoisted(() => ({
  validateEmailToken: vi.fn(),
  sendVerificationEmail: vi.fn(),
  createVerificationSession: vi.fn(),
  getValidatedSession: vi.fn(),
}));

vi.mock('../src/services/email', () => ({
  validateEmailToken: emailMocks.validateEmailToken,
  sendVerificationEmail: emailMocks.sendVerificationEmail,
  createVerificationSession: emailMocks.createVerificationSession,
  getValidatedSession: emailMocks.getValidatedSession,
}));

import account from '../src/api/account';
import identity from '../src/api/identity';

const NOW = 1_700_000_000_000;
const SID = 'sid-msc4183-aaaa';
const SECRET = 'client-secret';
const TOKEN = '654321';
const SERVER = 'example.com';

type Session = {
  session_id: string;
  email: string;
  client_secret: string;
  token: string;
  validated: number;
  expires_at: number;
  validated_at?: number | null;
};

type SqlCall = { sql: string; args: unknown[] };

function createDb(session?: Session) {
  const sessions = new Map<string, Session>();
  if (session) sessions.set(session.session_id, { ...session });
  const updates: SqlCall[] = [];

  const db = {
    sessions,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (
                sql.includes('FROM email_verification_sessions') &&
                sql.includes('WHERE session_id = ?')
              ) {
                const [sid, secret] = args as [string, string];
                const row = sessions.get(sid);
                if (!row || row.client_secret !== secret) return null as T;
                return { ...row } as T;
              }
              return null as T;
            },
            async run() {
              if (sql.includes('UPDATE email_verification_sessions SET validated = 1')) {
                updates.push({ sql, args });
                const [validatedAt, sid] = args as [number, string];
                const row = sessions.get(sid);
                if (row) {
                  row.validated = 1;
                  row.validated_at = validatedAt;
                }
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database & { sessions: Map<string, Session>; updates: SqlCall[] };
}

function makeEnv(db: D1Database): Env {
  return {
    SERVER_NAME: SERVER,
    DB: db,
    CACHE: { get: async () => null, put: async () => {} },
    EMAIL: { send: async () => ({ messageId: 'msg-1' }) },
  } as unknown as Env;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function seedSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: SID,
    email: 'verify@example.com',
    client_secret: SECRET,
    token: TOKEN,
    validated: 0,
    expires_at: NOW + 60_000,
    validated_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  for (const mock of Object.values(emailMocks)) mock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MSC4183 — identity submitToken', () => {
  const path = 'http://localhost/_matrix/identity/v2/validate/email/submitToken';

  async function post(db: D1Database, token: string) {
    const res = await identity.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: SID, client_secret: SECRET, token }),
      },
      makeEnv(db)
    );
    return { status: res.status, body: await jsonBody(res) };
  }

  it('returns 400 M_TOKEN_INCORRECT for a wrong token', async () => {
    const db = createDb(seedSession());
    const { status, body } = await post(db, '000000');
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_TOKEN_INCORRECT', error: 'Invalid token' });
    expect(db.updates).toHaveLength(0);
  });

  it('returns 400 M_TOKEN_INCORRECT for an expired session', async () => {
    const db = createDb(seedSession({ expires_at: NOW - 1 }));
    const { status, body } = await post(db, TOKEN);
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_TOKEN_INCORRECT', error: 'Session expired' });
    expect(db.updates).toHaveLength(0);
  });

  it('keeps M_NO_VALID_SESSION for an unknown session', async () => {
    const db = createDb();
    const { status, body } = await post(db, TOKEN);
    expect(status).toBe(400);
    expect(body).toEqual({ errcode: 'M_NO_VALID_SESSION', error: 'Session not found' });
  });

  it('still returns { success: true } and validates on the happy path', async () => {
    const db = createDb(seedSession());
    const { status, body } = await post(db, TOKEN);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(db.updates).toHaveLength(1);
    expect(db.sessions.get(SID)?.validated).toBe(1);
  });
});

describe('MSC4183 — client-server 3pid submit_token', () => {
  const base = 'http://localhost/_matrix/client/v3/account/3pid/submit_token';
  const wrongToken = { success: false, error: 'Invalid token' };

  it('POST returns 400 M_TOKEN_INCORRECT for a wrong token', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce(wrongToken);
    const res = await account.request(
      base,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: SID, client_secret: SECRET, token: '000000' }),
      },
      makeEnv(createDb())
    );
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({
      errcode: 'M_TOKEN_INCORRECT',
      error: 'Invalid token',
    });
  });

  it('GET returns 400 M_TOKEN_INCORRECT for a wrong token', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce(wrongToken);
    const res = await account.request(
      `${base}?sid=${SID}&client_secret=${SECRET}&token=000000`,
      {},
      makeEnv(createDb())
    );
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({
      errcode: 'M_TOKEN_INCORRECT',
      error: 'Invalid token',
    });
  });

  it('keeps the legacy code for an unknown session', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({
      success: false,
      error: 'Session not found',
    });
    const res = await account.request(
      base,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: SID, client_secret: SECRET, token: TOKEN }),
      },
      makeEnv(createDb())
    );
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({
      errcode: 'M_THREEPID_AUTH_FAILED',
      error: 'Session not found',
    });
  });

  it('still returns { success: true } on the happy path', async () => {
    emailMocks.validateEmailToken.mockResolvedValueOnce({ success: true });
    const res = await account.request(
      base,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: SID, client_secret: SECRET, token: TOKEN }),
      },
      makeEnv(createDb())
    );
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ success: true });
  });
});
