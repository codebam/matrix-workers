// send_leave v1/v2 must verify the leaving server's signature, countersign,
// persist into the room graph, update membership, and return the correct
// response envelope. Real Ed25519 keys run through the production key chain.
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
import { calculateContentHash, generateSigningKeyPair } from '../src/utils/crypto';
import {
  seedPduVerifyKey,
  signEventForOrigin,
} from './helpers/federation-origin-signatures';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const USER = '@alice:remote.example.com';
const ORIGIN = 'remote.example.com';
const FOREIGN = 'evil.example.org';
const EVENT = '$leave:remote.example.com';

async function buildHarness() {
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
  await seedPduVerifyKey(cache, ORIGIN);

  const localKey = await generateSigningKeyPair();
  const inserts: Array<{ sql: string; args: unknown[] }> = [];
  const memberships = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT room_id, room_version FROM rooms')) {
                return { room_id: ROOM, room_version: '10' } as T;
              }
              if (sql.includes('SELECT key_id, private_key_jwk FROM server_keys')) {
                return {
                  key_id: localKey.keyId,
                  private_key_jwk: JSON.stringify(localKey.privateKeyJwk),
                } as T;
              }
              if (sql.includes('SELECT membership FROM room_memberships')) {
                const membership = memberships.get(args[1] as string);
                return membership ? ({ membership } as T) : (null as T);
              }
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              inserts.push({ sql, args });
              if (sql.includes('INTO room_memberships')) {
                memberships.set(args[1] as string, args[2] as string);
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
        async first<T>() {
          if (sql.includes('UPDATE stream_positions')) return { position: 1 } as T;
          if (sql.includes('SELECT key_id, private_key_jwk FROM server_keys')) {
            return {
              key_id: localKey.keyId,
              private_key_jwk: JSON.stringify(localKey.privateKeyJwk),
            } as T;
          }
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
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    CACHE: cache,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
  } as unknown as Env;

  const unsigned: Record<string, unknown> = {
    event_id: EVENT,
    room_id: ROOM,
    sender: USER,
    state_key: USER,
    type: 'm.room.member',
    content: { membership: 'leave' },
    origin_server_ts: 1_700_000_000_000,
    depth: 7,
    auth_events: [],
    prev_events: [],
  };
  const event = {
    ...unsigned,
    hashes: { sha256: await calculateContentHash(unsigned) },
  };

  async function send(version: 1 | 2, body: Record<string, unknown>) {
    const response = await federationApp.request(
      `http://localhost/_matrix/federation/v${version}/send_leave/${encodeURIComponent(ROOM)}/${encodeURIComponent(EVENT)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );
    return { status: response.status, body: (await response.json()) as any };
  }

  return {
    env,
    cache,
    event,
    send,
    inserts,
    memberships,
    storedEvents: () => inserts.filter((i) => i.sql.includes('INTO events')),
  };
}

describe('send_leave verification, countersigning and persistence', () => {
  it('v1 rejects a leave signed only by a foreign server', async () => {
    const h = await buildHarness();
    await seedPduVerifyKey(h.cache, FOREIGN);
    const foreignSigned = await signEventForOrigin(h.event, FOREIGN);

    const res = await h.send(1, foreignSigned);

    expect(res.status).toBe(403);
    expect(h.storedEvents()).toHaveLength(0);
    expect(h.memberships.size).toBe(0);
  });

  it('v1 verifies, countersigns, persists and returns {}', async () => {
    const h = await buildHarness();
    const signed = await signEventForOrigin(h.event, ORIGIN);

    const res = await h.send(1, signed);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(h.storedEvents()).toHaveLength(1);
    expect(h.memberships.get(USER)).toBe('leave');
    expect(JSON.parse(h.storedEvents()[0].args[12] as string)[SERVER]).toBeDefined();
  });

  it('v2 returns the countersigned event', async () => {
    const h = await buildHarness();
    const signed = await signEventForOrigin(h.event, ORIGIN);

    const res = await h.send(2, signed);

    expect(res.status).toBe(200);
    expect(res.body.event).toBeDefined();
    expect(res.body.event.signatures[ORIGIN]).toBeDefined();
    expect(res.body.event.signatures[SERVER]).toBeDefined();
    expect(h.storedEvents()).toHaveLength(1);
    expect(h.memberships.get(USER)).toBe('leave');
  });
});
