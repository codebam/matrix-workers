/**
 * Federation key self-check endpoint (/admin/api/federation/key-check).
 * Tester-equivalent validation of our own /_matrix/key/v2/server response —
 * regression guard for the sign-every-published-key fix (federation tester
 * AllEd25519ChecksOK).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const authState = vi.hoisted(() => ({
  userId: '@admin:example.com' as string | undefined,
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', 'ADMINDEVICE');
      await next();
    };
  },
}));

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import adminApp from '../src/api/admin';
import { base64UrlEncode, generateSigningKeyPair } from '../src/utils/crypto';

const ADMIN = '@admin:example.com';
const SERVER = 'example.com';
const NOW = 1_700_000_000_000;

type ServerKeyRow = {
  key_id: string;
  public_key: string;
  private_key?: string | null;
  private_key_jwk: string | null;
  key_version: number | null;
  valid_from: number;
  valid_until: number | null;
  is_current: number;
};

/** Remap Cloudflare NODE-ED25519 → Node Ed25519 for unit tests. */
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

  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}

function seedSecureKey(
  pair: { keyId: string; publicKey: string; privateKeyJwk: JsonWebKey },
  overrides: Partial<ServerKeyRow> = {}
): ServerKeyRow {
  return {
    key_id: pair.keyId,
    public_key: pair.publicKey,
    private_key: JSON.stringify(pair.privateKeyJwk),
    private_key_jwk: JSON.stringify(pair.privateKeyJwk),
    key_version: 2,
    valid_from: NOW - 1000,
    valid_until: NOW + 86_400_000,
    is_current: 1,
    ...overrides,
  };
}

function createDb(opts: { serverKeys?: ServerKeyRow[] } = {}) {
  const serverKeys = opts.serverKeys ? [...opts.serverKeys] : [];

  const db = {
    serverKeys,
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        async first<T>() {
          if (sql.includes('FROM users WHERE user_id = ?')) {
            const uid = args[0] as string;
            return (uid === ADMIN ? { user_id: ADMIN, admin: 1 } : null) as T;
          }
          throw new Error(`Unhandled first() SQL: ${sql.slice(0, 120)}`);
        },
        async all<T>() {
          if (sql.includes('FROM server_keys WHERE is_current = 1')) {
            const rows = serverKeys
              .filter((k) => k.is_current === 1)
              .sort((a, b) => (b.key_version ?? 0) - (a.key_version ?? 0));
            return { results: rows } as unknown as T;
          }
          return { results: [] } as unknown as T;
        },
        async run() {
          if (sql.includes('UPDATE server_keys SET is_current = 0')) {
            for (const k of serverKeys) k.is_current = 0;
            return { success: true, meta: { changes: serverKeys.length } };
          }
          if (sql.includes('INSERT INTO server_keys')) {
            const [
              keyId,
              publicKey,
              privateKey,
              privateKeyJwk,
              validFrom,
              validUntil,
            ] = args as [string, string, string, string, number, number];
            serverKeys.push({
              key_id: keyId,
              public_key: publicKey,
              private_key: privateKey,
              private_key_jwk: privateKeyJwk,
              key_version: 2,
              valid_from: validFrom,
              valid_until: validUntil,
              is_current: 1,
            });
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`Unhandled run() SQL: ${sql.slice(0, 120)}`);
        },
      });
      return {
        bind(...args: unknown[]) {
          return exec(args);
        },
        first: <T>() => exec([]).first<T>(),
        all: <T>() => exec([]).all<T>(),
        run: () => exec([]).run(),
      };
    },
  };
  return db;
}

function mockKv() {
  const data: Record<string, string> = {};
  return {
    get: async (key: string) => data[key] ?? null,
    put: async (key: string, value: string) => {
      data[key] = value;
    },
    delete: async (key: string) => {
      delete data[key];
    },
  };
}

function createEnv(opts: { db?: ReturnType<typeof createDb> } = {}): Env {
  const db = opts.db ?? createDb();
  return {
    DB: db,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    SESSIONS: mockKv(),
    DEVICE_KEYS: mockKv(),
    ONE_TIME_KEYS: mockKv(),
    CROSS_SIGNING_KEYS: mockKv(),
    CACHE: mockKv(),
    ACCOUNT_DATA: mockKv(),
    MEDIA: {},
    USER_KEYS: { idFromName: (name: string) => ({ name }), get: () => ({}) },
    FEDERATION: { idFromName: () => ({}), get: () => ({}) },
    ROOM: { idFromName: () => ({}), get: () => ({}) },
    SYNC: { idFromName: () => ({}), get: () => ({}) },
    ADMIN: { idFromName: () => ({}), get: () => ({}) },
    PUSH: { idFromName: () => ({}), get: () => ({}) },
    RATE_LIMIT: { idFromName: () => ({}), get: () => ({}) },
    CALL_ROOM: { idFromName: () => ({}), get: () => ({}) },
  } as unknown as Env;
}

async function request(env: Env, path: string) {
  const res = await adminApp.request(`http://localhost${path}`, {}, env);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let restoreEd25519: (() => void) | undefined;
let securePair: Awaited<ReturnType<typeof generateSigningKeyPair>>;

beforeAll(async () => {
  restoreEd25519 = installNodeEd25519Shim();
  securePair = await generateSigningKeyPair();
});

afterAll(() => {
  restoreEd25519?.();
});

beforeEach(() => {
  authState.userId = ADMIN;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /admin/api/federation/key-check', () => {
  it('reports all tester-equivalent checks OK for a healthy key set', async () => {
    const db = createDb({
      serverKeys: [
        // Legacy current row without a JWK: the handler must not advertise it
        // (publishing it unsigned is the AllEd25519ChecksOK failure mode).
        {
          key_id: 'ed25519:legacy',
          public_key: 'legacyPub',
          private_key: null,
          private_key_jwk: null,
          key_version: 1,
          valid_from: NOW - 1000,
          valid_until: NOW + 86_400_000,
          is_current: 1,
        },
        seedSecureKey(securePair),
      ],
    });
    const res = await request(createEnv({ db }), '/admin/api/federation/key-check');
    expect(res.status).toBe(200);
    expect(res.body.AllChecksOK).toBe(true);
    expect(res.body.MatchingServerName).toBe(true);
    expect(res.body.FutureValidUntilTS).toBe(true);
    expect(res.body.HasEd25519Key).toBe(true);
    expect(res.body.AllEd25519ChecksOK).toBe(true);
    expect(Object.keys(res.body.Ed25519Checks)).toEqual([securePair.keyId]);
    expect(res.body.Ed25519Checks[securePair.keyId]).toEqual({
      ValidEd25519: true,
      MatchingSignature: true,
    });
  });

  it('generates and validates a key when none exist (fresh install)', async () => {
    const db = createDb({ serverKeys: [] });
    const res = await request(createEnv({ db }), '/admin/api/federation/key-check');
    expect(res.status).toBe(200);
    expect(res.body.AllChecksOK).toBe(true);
    expect(db.serverKeys).toHaveLength(1);
    expect(db.serverKeys[0].key_version).toBe(2);
  });

  it('detects a published key whose signature does not match (regression guard)', async () => {
    const other = await generateSigningKeyPair();
    // The response is signed with securePair's JWK but `other`'s public key is
    // published — the mismatch class that fails the federation tester with
    // AllEd25519ChecksOK=false.
    const db = createDb({
      serverKeys: [
        seedSecureKey(securePair, { key_id: 'ed25519:broken', public_key: other.publicKey }),
      ],
    });
    const res = await request(createEnv({ db }), '/admin/api/federation/key-check');
    expect(res.status).toBe(200);
    expect(res.body.AllChecksOK).toBe(false);
    expect(res.body.AllEd25519ChecksOK).toBe(false);
    expect(res.body.Ed25519Checks['ed25519:broken']).toEqual({
      ValidEd25519: true,
      MatchingSignature: false,
    });
  });

  it('flags key material that is not a valid 32-byte ed25519 key', async () => {
    const pub16 = base64UrlEncode(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
    const db = createDb({
      serverKeys: [seedSecureKey(securePair, { key_id: 'ed25519:short', public_key: pub16 })],
    });
    const res = await request(createEnv({ db }), '/admin/api/federation/key-check');
    expect(res.status).toBe(200);
    expect(res.body.AllChecksOK).toBe(false);
    expect(res.body.AllEd25519ChecksOK).toBe(false);
    expect(res.body.Ed25519Checks['ed25519:short']).toEqual({
      ValidEd25519: false,
      MatchingSignature: false,
    });
  });

  it('requires an admin principal', async () => {
    const env = createEnv({ db: createDb({ serverKeys: [seedSecureKey(securePair)] }) });

    authState.userId = '@bob:example.com';
    const forbidden = await request(env, '/admin/api/federation/key-check');
    expect(forbidden.status).toBe(403);

    authState.userId = undefined;
    const unauthorized = await request(env, '/admin/api/federation/key-check');
    expect(unauthorized.status).toBe(401);
  });
});
