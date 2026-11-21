/**
 * Real-crypto federation integration (#15 of the gap ledger): the full
 * request-authentication path runs for real — a generated Ed25519 key,
 * a genuine X-Matrix header signed with it, requireFederationAuth
 * verifying through the real key-resolution chain (KV-served remote
 * keys) — and then the server-ACL read guards decide.
 *
 * No module mocks: only the D1 rows and the KV key cache are fake.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { generateSigningKeyPair, signJson } from '../src/utils/crypto';
import { buildSignedRequest } from '../src/middleware/federation-auth';

const SERVER = 'example.com';
const ORIGIN = 'remote.example.org';
const KEY_ID = 'ed25519:test';
const ROOM = '!room:example.com';
const ROOM_ENC = encodeURIComponent(ROOM);

/** Remap Cloudflare's NODE-ED25519 algorithm name to Node's Ed25519 for unit tests. */
function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (
    alg: AlgorithmIdentifier | EcKeyGenParams | EcKeyImportParams | EcdsaParams | unknown
  ): AlgorithmIdentifier => {
    if (typeof alg === 'string') {
      return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    }
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') {
      return 'Ed25519';
    }
    return alg as AlgorithmIdentifier;
  };

  subtle.generateKey = ((alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg), extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    alg: AlgorithmIdentifier,
    extractable: boolean,
    usages: KeyUsage[]
  ) =>
    origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;
}

beforeAll(() => {
  installNodeEd25519Shim();
});

import federationApp from '../src/api/federation';

// ---------------------------------------------------------------------------
// Fake storage: D1 rows + a KV pre-seeded with the origin's real key.
// ---------------------------------------------------------------------------

type StateRow = {
  event_id: string;
  event_type: string;
  state_key: string;
  content: Record<string, unknown>;
  auth_events?: string[];
};

async function buildHarness(stateRows: StateRow[]) {
  const pair = await generateSigningKeyPair();
  const now = Date.now();

  const kvData = new Map<string, string>();
  kvData.set(
    `federation:keys:${ORIGIN}`,
    JSON.stringify([
      {
        server_name: ORIGIN,
        key_id: KEY_ID,
        public_key: pair.publicKey,
        valid_from: now - 1000,
        valid_until: now + 24 * 60 * 60 * 1000,
        fetched_at: now,
        verified: 1,
      },
    ])
  );
  const cache = {
    async get(key: string, type?: string) {
      const raw = kvData.get(key);
      if (raw == null) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      kvData.set(key, value);
    },
    async delete(key: string) {
      kvData.delete(key);
    },
  } as unknown as KVNamespace;

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT room_id, room_version FROM rooms')) {
                return { room_id: ROOM, room_version: '10' } as T;
              }
              if (
                sql.includes('FROM room_state rs') &&
                sql.includes('JOIN events e') &&
                sql.includes('rs.event_type = ?') &&
                sql.includes('rs.state_key = ?')
              ) {
                // getStateEvent: args are (roomId, eventType, stateKey).
                const row = stateRows.find(
                  (r) => r.event_type === args[1] && (r.state_key ?? '') === args[2]
                );
                return row
                  ? ({
                      event_id: row.event_id,
                      room_id: ROOM,
                      sender: '@remote:remote.example.org',
                      event_type: row.event_type,
                      state_key: row.state_key,
                      content: JSON.stringify(row.content),
                      origin_server_ts: now,
                      unsigned: null,
                      depth: 1,
                      auth_events: JSON.stringify(row.auth_events ?? []),
                      prev_events: JSON.stringify([]),
                    } as T)
                  : (null as T);
              }
              if (sql.includes('FROM events WHERE event_id = ?')) {
                return null as T;
              }
              if (sql.includes('SELECT room_id FROM rooms')) {
                return { room_id: ROOM } as T;
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes('FROM room_state rs') && sql.includes('rs.room_id = ?')) {
                return {
                  results: stateRows.map((r) => ({
                    event_id: r.event_id,
                    auth_events: JSON.stringify(r.auth_events ?? []),
                    event_type: r.event_type,
                    state_key: r.state_key,
                    room_id: ROOM,
                    sender: '@remote:remote.example.org',
                    content: JSON.stringify(r.content),
                    origin_server_ts: now,
                    depth: 1,
                    prev_events: JSON.stringify([]),
                    hashes: null,
                    signatures: null,
                  })) as T[],
                };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO servers')) {
                // peer bookkeeping from the auth middleware
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;

  const env = {
    DB: db,
    SERVER_NAME: SERVER,
    CACHE: cache,
  } as unknown as Env;

  async function signedHeaders(
    method: string,
    path: string,
    content?: unknown
  ): Promise<Record<string, string>> {
    const signed = (await signJson(
      buildSignedRequest(method, path, ORIGIN, SERVER, content),
      ORIGIN,
      KEY_ID,
      pair.privateKeyJwk
    )) as { signatures: Record<string, Record<string, string>> };
    const sig = signed.signatures[ORIGIN][KEY_ID];
    return {
      Authorization: `X-Matrix origin="${ORIGIN}",destination="${SERVER}",key="${KEY_ID}",sig="${sig}"`,
      'Content-Type': 'application/json',
    };
  }

  return { env, signedHeaders };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('real-crypto federation auth + ACL read guards', () => {
  it('a genuinely signed request from an ACL-denied server gets 403 on state_ids', async () => {
    const { env, signedHeaders } = await buildHarness([
      {
        event_id: '$create:remote.example.org',
        event_type: 'm.room.create',
        state_key: '',
        content: { creator: '@remote:remote.example.org', room_version: '10' },
        auth_events: [],
      },
      {
        event_id: '$acl:remote.example.org',
        event_type: 'm.room.server_acl',
        state_key: '',
        content: { allow: ['*'], deny: [ORIGIN], allow_ip_literals: false },
        auth_events: [],
      },
    ]);

    const res = await federationApp.request(
      `http://localhost/_matrix/federation/v1/state_ids/${ROOM_ENC}`,
      { method: 'GET', headers: await signedHeaders('GET', `/_matrix/federation/v1/state_ids/${ROOM_ENC}`) },
      env
    );
    // 403 (not 401): the signature verified for real; the ACL is what refused.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errcode: string; error: string };
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toContain("room's server ACL");
  });

  it('the same signed request is served when the ACL allows the caller', async () => {
    const { env, signedHeaders } = await buildHarness([
      {
        event_id: '$create:remote.example.org',
        event_type: 'm.room.create',
        state_key: '',
        content: { creator: '@remote:remote.example.org', room_version: '10' },
        auth_events: [],
      },
      {
        event_id: '$acl:remote.example.org',
        event_type: 'm.room.server_acl',
        state_key: '',
        content: { allow: ['*'], deny: ['evil.example.org'], allow_ip_literals: false },
        auth_events: [],
      },
      {
        event_id: '$jr:remote.example.org',
        event_type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'public' },
        auth_events: [],
      },
    ]);

    const path = `/_matrix/federation/v1/state_ids/${ROOM_ENC}`;
    const res = await federationApp.request(`http://localhost${path}`, {
      method: 'GET',
      headers: await signedHeaders('GET', path),
    }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pdu_ids?: string[]; auth_chain_ids?: string[] };
    expect(Array.isArray(body.pdu_ids)).toBe(true);
    expect(body.pdu_ids!.length).toBeGreaterThan(0);
  });

  it('a tampered signature is rejected before any handler logic', async () => {
    const { env } = await buildHarness([]);

    const res = await federationApp.request(
      `http://localhost/_matrix/federation/v1/state_ids/${ROOM_ENC}`,
      {
        method: 'GET',
        headers: {
          Authorization: `X-Matrix origin="${ORIGIN}",destination="${SERVER}",key="${KEY_ID}",sig="tamperedsignature"`,
        },
      },
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { errcode: string };
    expect(body.errcode).toBe('M_UNAUTHORIZED');
  });
});
