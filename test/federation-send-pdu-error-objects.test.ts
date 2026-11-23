// The 200 response of PUT /_matrix/federation/v1/send/{txnId} maps each event
// ID to `{}` or `{ error: <Matrix error object> }` — a bare reason string is
// not spec-shaped. These tests pin that shape, the M_FORBIDDEN posture for
// ACL denials, and the flat 503 transient-storage path.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.com');
      await next();
    };
  },
}));

// Key resolution and signature verification are irrelevant to the response
// shape; stub them so the fixtures need no real Ed25519 keys.
vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return { ...actual, fetchRemoteServerKeys: async () => [] };
});

const verifyPdu = vi.fn(async () => ({ eventId: '$verified' }));
vi.mock('../src/services/federation-verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-verify')>();
  return { ...actual, verifyPdu: (...args: unknown[]) => verifyPdu(...args) };
});

const getRoomState = vi.fn(async () => [] as unknown[]);
vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return { ...actual, getRoomState: (...args: unknown[]) => getRoomState(...args) };
});

vi.mock('../src/services/event-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/event-auth')>();
  return { ...actual, checkEventAuth: () => ({ allowed: true }) };
});

import federationApp from '../src/api/federation';
import { calculateContentHash } from '../src/utils/crypto';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const SENDER = '@alice:remote.example.com';
const ORIGIN = 'remote.example.com';

type PduResult = Record<string, { error: { errcode: string; error: string } } | Record<string, never>>;
type SendBody = { pdus?: PduResult; errcode?: string; error?: string };

function makeHarness(opts: { failEventInsert?: boolean } = {}) {
  const cacheData = new Map<string, string>();
  const cache = {
    get: async (key: string) => cacheData.get(key) ?? null,
    put: async (key: string, value: string) => {
      cacheData.set(key, value);
    },
    delete: async (key: string) => {
      cacheData.delete(key);
    },
  } as unknown as KVNamespace;

  const processed = new Map<string, { accepted: number; reason: string | null }>();
  const transactions = new Map<string, string>();
  const inserts: Array<{ sql: string; args: unknown[] }> = [];

  function firstWithArgs<T>(sql: string, args: unknown[]): T | null {
    if (sql.includes('SELECT response FROM federation_transactions')) {
      const response = transactions.get(`${args[0]}|${args[1]}`);
      return (response ? { response } : null) as T;
    }
    if (sql.includes('SELECT room_id, room_version FROM rooms')) {
      return { room_id: ROOM, room_version: '10' } as T;
    }
    if (sql.includes('SELECT accepted, rejection_reason FROM processed_pdus')) {
      const row = processed.get(args[0] as string);
      return row ? ({ accepted: row.accepted, rejection_reason: row.reason } as T) : null;
    }
    return null;
  }

  function runWithArgs(sql: string, args: unknown[]) {
    inserts.push({ sql, args });
    if (
      opts.failEventInsert &&
      (sql.includes('INSERT OR IGNORE INTO events') || sql.includes('UPDATE stream_positions'))
    ) {
      throw new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.');
    }
    if (sql.includes('processed_pdus')) {
      const rejected = sql.includes('0, ?');
      processed.set(args[0] as string, {
        accepted: rejected ? 0 : 1,
        reason: rejected ? (args[4] as string) : null,
      });
    }
    if (sql.includes('INSERT OR REPLACE INTO federation_transactions')) {
      transactions.set(`${args[1]}|${args[0]}`, args[3] as string);
    }
    return { success: true, meta: { changes: 1 } };
  }

  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return firstWithArgs<T>(sql, args);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return runWithArgs(sql, args);
            },
          };
        },
        async first<T>() {
          return firstWithArgs<T>(sql, []);
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return runWithArgs(sql, []);
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    CACHE: cache,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
  } as unknown as Env;

  async function send(pdus: Record<string, unknown>[], txnId: string) {
    const response = await federationApp.request(
      `http://localhost/_matrix/federation/v1/send/${txnId}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdus }),
      },
      env
    );
    return { status: response.status, body: (await response.json()) as SendBody };
  }

  return { env, send, processed, transactions, inserts };
}

async function pduFixture(eventId: string): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    event_id: eventId,
    room_id: ROOM,
    sender: SENDER,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'hello' },
    origin_server_ts: 1_700_000_000_000,
    depth: 3,
    auth_events: [],
    prev_events: [],
  };
  return { ...base, hashes: { sha256: await calculateContentHash(base) } };
}

beforeEach(() => {
  getRoomState.mockReset();
  getRoomState.mockResolvedValue([]);
  verifyPdu.mockReset();
  verifyPdu.mockResolvedValue({ eventId: '$verified' });
});

describe('PUT /send per-PDU error objects', () => {
  it('returns a Matrix error object for an invalid sender', async () => {
    const { send } = makeHarness();
    const pdu = await pduFixture('$bad-sender');

    const { status, body } = await send([{ ...pdu, sender: 'noserver' }], 'txn-bad-sender');

    expect(status).toBe(200);
    expect(body.pdus?.['$bad-sender']).toEqual({
      error: { errcode: 'M_UNKNOWN', error: 'Invalid sender format' },
    });
  });

  it('returns a Matrix error object for a content hash mismatch', async () => {
    const { send } = makeHarness();
    const pdu = await pduFixture('$bad-hash');

    const { status, body } = await send(
      [{ ...pdu, content: { msgtype: 'm.text', body: 'tampered' } }],
      'txn-bad-hash'
    );

    expect(status).toBe(200);
    expect(body.pdus?.['$bad-hash']).toEqual({
      error: { errcode: 'M_UNKNOWN', error: 'Content hash mismatch' },
    });
  });

  it('returns M_FORBIDDEN for a caller denied by the room ACL', async () => {
    getRoomState.mockResolvedValue([
      {
        event_id: '$acl',
        room_id: ROOM,
        sender: `@admin:${SERVER}`,
        type: 'm.room.server_acl',
        state_key: '',
        content: { allow: ['*'], deny: [ORIGIN], allow_ip_literals: false },
      },
    ] as never);
    const { send } = makeHarness();

    const { status, body } = await send([await pduFixture('$acl-denied')], 'txn-acl-denied');

    expect(status).toBe(200);
    expect(body.pdus?.['$acl-denied']).toEqual({
      error: {
        errcode: 'M_FORBIDDEN',
        error: `Server ${ORIGIN} is denied by the room's server ACL`,
      },
    });
  });

  it('returns an empty object for an accepted PDU', async () => {
    const { send, transactions } = makeHarness();

    const { status, body } = await send([await pduFixture('$accepted')], 'txn-accepted');

    expect(status).toBe(200);
    expect(body.pdus?.['$accepted']).toEqual({});
    expect(transactions.has(`${ORIGIN}|txn-accepted`)).toBe(true);
  });

  it('returns a flat 503 on a transient storage failure without caching the transaction', async () => {
    const { send, processed, transactions } = makeHarness({ failEventInsert: true });

    const { status, body } = await send([await pduFixture('$storage-fail')], 'txn-storage-fail');

    expect(status).toBe(503);
    expect(body).toEqual({
      errcode: 'M_UNKNOWN',
      error: 'Temporary storage failure; retry this transaction',
    });
    expect(body.pdus).toBeUndefined();
    expect(processed.has('$storage-fail')).toBe(false);
    expect(transactions.has(`${ORIGIN}|txn-storage-fail`)).toBe(false);
  });
});
