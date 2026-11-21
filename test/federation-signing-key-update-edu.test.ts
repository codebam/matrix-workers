// Inbound m.signing_key_update EDUs: cache a peer's cross-signing keys in the
// same D1/KV shape as local uploads, and mark a key change for /keys/query.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const ORIGIN = 'remote.example.org';
const OTHER = 'other.example.org';
const REMOTE_USER = `@alice:${ORIGIN}`;
const SERVER = 'example.com';

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

type SqlCall = { sql: string; args: unknown[] };

function mockKv(initial: Record<string, string> = {}) {
  const data = { ...initial };
  const puts: Array<{ key: string; value: string }> = [];
  return {
    data,
    puts,
    async get(key: string) { return data[key] ?? null; },
    async put(key: string, value: string) { data[key] = value; puts.push({ key, value }); },
    async delete(key: string) { delete data[key]; },
  };
}

function createEnv(opts: { kv?: ReturnType<typeof mockKv> } = {}) {
  const crossSigning: Array<{ userId: string; keyType: string; keyId: string; data: string }> = [];
  const keyChanges: Array<{ userId: string; deviceId: string | null; changeType: string }> = [];
  const runs: SqlCall[] = [];
  const kv = opts.kv ?? mockKv();

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM federation_transactions')) return null as T;
              if (sql.includes('FROM stream_positions')) return { position: 7 } as T;
              return null as T;
            },
            async all<T>() { return { results: [] as T[] }; },
            async run() {
              runs.push({ sql, args });
              if (sql.includes('INSERT INTO cross_signing_keys')) {
                const [userId, keyType, keyId, data] = args as [string, string, string, string];
                crossSigning.push({ userId, keyType, keyId, data });
              }
              if (sql.includes('INSERT INTO device_key_changes')) {
                const [userId, deviceId, changeType] = args as [string, string | null, string];
                keyChanges.push({ userId, deviceId, changeType });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  const env = {
    DB: db as unknown as D1Database,
    CROSS_SIGNING_KEYS: kv as unknown as KVNamespace,
    CACHE: {} as KVNamespace,
    SERVER_NAME: SERVER,
    SERVER_VERSION: 'test',
  };
  return { env: env as unknown as Env, crossSigning, keyChanges, runs, kv };
}

function masterKey() {
  return {
    user_id: REMOTE_USER,
    usage: ['master'],
    keys: { 'ed25519:masterkey': 'masterkey' },
  };
}

function selfSigningKey() {
  return {
    user_id: REMOTE_USER,
    usage: ['self_signing'],
    keys: { 'ed25519:selfkey': 'selfkey' },
    signatures: { [REMOTE_USER]: { 'ed25519:masterkey': 'sig' } },
  };
}

async function sendEdu(env: Env, txn: string, content: unknown) {
  return federation.request(
    `http://localhost/_matrix/federation/v1/send/${txn}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdus: [], edus: [{ edu_type: 'm.signing_key_update', content }] }),
    },
    env
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('inbound m.signing_key_update EDUs', () => {
  it('stores published master/self-signing keys and notifies key-query clients', async () => {
    const { env, crossSigning, keyChanges, kv } = createEnv();
    const res = await sendEdu(env, 'txn-signing-keys', {
      user_id: REMOTE_USER,
      master_key: masterKey(),
      self_signing_key: selfSigningKey(),
    });
    expect(res.status).toBe(200);

    expect(crossSigning).toEqual([
      { userId: REMOTE_USER, keyType: 'master', keyId: 'ed25519:masterkey', data: JSON.stringify(masterKey()) },
      { userId: REMOTE_USER, keyType: 'self_signing', keyId: 'ed25519:selfkey', data: JSON.stringify(selfSigningKey()) },
    ]);
    expect(keyChanges).toEqual([{ userId: REMOTE_USER, deviceId: null, changeType: 'update' }]);
    expect(JSON.parse(kv.data[`user:${REMOTE_USER}`])).toEqual({
      master: masterKey(),
      self_signing: selfSigningKey(),
    });
  });

  it('merges an update into previously cached keys', async () => {
    const kv = mockKv({ [`user:${REMOTE_USER}`]: JSON.stringify({ user_signing: { keys: { 'ed25519:old': 'old' } } }) });
    const { env, crossSigning } = createEnv({ kv });
    const res = await sendEdu(env, 'txn-signing-merge', {
      user_id: REMOTE_USER,
      master_key: masterKey(),
    });
    expect(res.status).toBe(200);

    expect(crossSigning).toHaveLength(1);
    expect(JSON.parse(kv.data[`user:${REMOTE_USER}`])).toEqual({
      user_signing: { keys: { 'ed25519:old': 'old' } },
      master: masterKey(),
    });
  });

  it('ignores keys published for another server and malformed payloads', async () => {
    const { env, crossSigning, keyChanges, runs } = createEnv();
    const res = await sendEdu(env, 'txn-signing-foreign', {
      user_id: `@bob:${OTHER}`,
      master_key: masterKey(),
    });
    expect(res.status).toBe(200);
    const malformed = await sendEdu(env, 'txn-signing-malformed', {
      user_id: REMOTE_USER,
      master_key: { keys: {} },
      self_signing_key: { user_id: REMOTE_USER },
    });
    expect(malformed.status).toBe(200);

    expect(crossSigning).toEqual([]);
    expect(keyChanges).toEqual([]);
    // Only the processed_edus / transaction bookkeeping rows remain.
    expect(runs.every((r) => r.sql.includes('processed_edus') || r.sql.includes('federation_transactions'))).toBe(true);
  });
});
