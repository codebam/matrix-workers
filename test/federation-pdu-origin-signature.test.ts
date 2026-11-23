// Inbound /send must enforce a signature from the PDU sender's own server.
// Real Ed25519 keys run through the real fetchRemoteServerKeys() chain; only
// request-level X-Matrix auth and DAG auth are stubbed so these tests isolate
// the per-PDU signature gate.
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.com');
      await next();
    };
  },
}));

vi.mock('../src/services/event-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/event-auth')>();
  return { ...actual, checkEventAuth: () => ({ allowed: true }) };
});

import federationApp from '../src/api/federation';
import { calculateContentHash } from '../src/utils/crypto';
import {
  seedPduVerifyKey,
  signPduForOrigin,
} from './helpers/federation-origin-signatures';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const SENDER = '@alice:remote.example.com';
const ORIGIN = 'remote.example.com';
const OTHER = 'other.example.org';

function makeHarness() {
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

  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const processed = new Map<string, { accepted: number; reason: string | null }>();
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT room_id, room_version FROM rooms')) {
                return { room_id: ROOM, room_version: '10' } as T;
              }
              if (sql.includes('SELECT accepted, rejection_reason FROM processed_pdus')) {
                const row = processed.get(args[0] as string);
                return row
                  ? ({ accepted: row.accepted, rejection_reason: row.reason } as T)
                  : (null as T);
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              inserts.push({ sql, args });
              if (sql.includes('processed_pdus')) {
                const rejected = sql.includes('0, ?');
                processed.set(args[0] as string, {
                  accepted: rejected ? 0 : 1,
                  reason: rejected ? (args[4] as string) : null,
                });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
        async first<T>() {
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          inserts.push({ sql, args: [] });
          return { success: true, meta: { changes: 1 } };
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

  async function send(pdu: Record<string, unknown>) {
    const response = await federationApp.request(
      `http://localhost/_matrix/federation/v1/send/txn-${Math.random()}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdus: [pdu] }),
      },
      env
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        pdus: Record<string, { error?: { errcode: string; error: string } }>;
      },
    };
  }

  const storedEvents = () => inserts.filter((i) => i.sql.includes('INSERT OR IGNORE INTO events'));
  return { env, cache, send, storedEvents, processed };
}

async function pduFixture(nonce: string): Promise<Record<string, unknown>> {
  const base: Record<string, unknown> = {
    event_id: `$${nonce}`,
    room_id: ROOM,
    sender: SENDER,
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: nonce },
    origin_server_ts: 1_700_000_000_000,
    depth: 3,
    auth_events: [],
    prev_events: [],
  };
  return { ...base, hashes: { sha256: await calculateContentHash(base) } };
}

describe('inbound PDU origin signature enforcement', () => {
  it('rejects an unsigned PDU with a per-PDU error and does not store it', async () => {
    const { cache, send, storedEvents, processed } = makeHarness();
    await seedPduVerifyKey(cache, ORIGIN);
    const pdu = await pduFixture('unsigned');

    const { status, body } = await send(pdu);

    expect(status).toBe(200);
    expect(body.pdus['$unsigned'].error).toMatchObject({ errcode: 'M_UNKNOWN', error: expect.stringMatching(/without valid signature/) });
    expect(body.pdus['$unsigned'].error).toMatchObject({ errcode: 'M_UNKNOWN', error: expect.stringMatching(/no signature/) });
    expect(storedEvents()).toHaveLength(0);
    expect(processed.get('$unsigned')?.accepted).toBe(0);
  });

  it('rejects a PDU signed only by a foreign server', async () => {
    const { cache, send, storedEvents } = makeHarness();
    await seedPduVerifyKey(cache, ORIGIN);
    await seedPduVerifyKey(cache, OTHER);
    const pdu = await signPduForOrigin(await pduFixture('foreign'), OTHER);

    const { body } = await send(pdu);

    expect(body.pdus['$foreign'].error).toMatchObject({ errcode: 'M_UNKNOWN', error: expect.stringMatching(/without valid signature/) });
    expect(body.pdus['$foreign'].error).toMatchObject({ errcode: 'M_UNKNOWN', error: expect.stringMatching(/no signature from remote.example.com/) });
    expect(storedEvents()).toHaveLength(0);
  });

  it('accepts and stores a PDU signed by the sender server', async () => {
    const { cache, send, storedEvents, processed } = makeHarness();
    await seedPduVerifyKey(cache, ORIGIN);
    const pdu = await signPduForOrigin(await pduFixture('origin-signed'), ORIGIN);

    const { body } = await send(pdu);

    expect(body.pdus['$origin-signed']).toEqual({});
    expect(storedEvents()).toHaveLength(1);
    expect(processed.get('$origin-signed')?.accepted).toBe(1);
  });
});
