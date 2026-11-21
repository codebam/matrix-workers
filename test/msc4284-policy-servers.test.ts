/**
 * MSC4284 (stable since spec v1.18) — Policy Servers.
 *
 * Unit coverage for the config parsing, the joined-member consent gate,
 * and the sign/verify roundtrip (real Ed25519 keys); route coverage for
 * the send-side ask (signature attached and federated, refusal surfaced
 * verbatim, invalid signature rejected, m.room.policy exempt) and for
 * serving POST /_matrix/policy/v1/sign ourselves.
 */
import { beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';
import { generateSigningKeyPair, signJson } from '../src/utils/crypto';
import { redactEventForSigning } from '../src/utils/event-signing';

const SERVER = 'example.com';
const PS = 'ps.example.org';
const USER = '@alice:example.com';
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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', USER);
      c.set('deviceId', 'D');
      await next();
    };
  },
}));

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
  optionalFederationAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.org');
      await next();
    };
  },
}));

const getMembership = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const getRoom = vi.fn();
const storeEvent = vi.fn();
const storeEventIdempotent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const updateMembership = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...args: unknown[]) => getMembership(...args),
    getStateEvent: (...args: unknown[]) => getStateEvent(...args),
    getRoomEvents: (...args: unknown[]) => getRoomEvents(...args),
    getRoom: (...args: unknown[]) => getRoom(...args),
    storeEvent: (...args: unknown[]) => storeEvent(...args),
    storeEventIdempotent: (...args: unknown[]) => storeEventIdempotent(...args),
    notifyUsersOfEvent: (...args: unknown[]) => notifyUsersOfEvent(...args),
    updateMembership: (...args: unknown[]) => updateMembership(...args),
  };
});

const federationPost = vi.fn();

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return {
    ...actual,
    federationPost: (...args: unknown[]) => federationPost(...args),
    getServerSigningKey: vi.fn(async () => null),
  };
});

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
  invalidateRoomCache: vi.fn(async () => undefined),
}));

import {
  askPolicyServerSignature,
  eventExemptFromPolicy,
  getRoomPolicyServer,
  parsePolicyConfig,
  signEventAsPolicyServer,
  verifyPolicySignature,
  POLICY_KEY_ID,
} from '../src/services/policy-server';
import roomsApp from '../src/api/rooms';
import federationApp from '../src/api/federation';

// ---------------------------------------------------------------------------
// Fake D1
// ---------------------------------------------------------------------------

function policyDb(opts: { joinedServers?: string[]; serverKeys?: Record<string, string> } = {}) {
  const joinedServers = opts.joinedServers ?? [];
  function stmt(sql: string, args: unknown[] = []) {
    return {
      bind(...bindArgs: unknown[]) {
        return stmt(sql, bindArgs);
      },
      async first<T>() {
        if (sql.includes('FROM room_memberships') && sql.includes("membership = 'join'")) {
          // The joined-member consent gate for the `via` server.
          const suffix = String(args[1] ?? '');
          return (joinedServers.some((s) => suffix.endsWith(`:${s}`)) ? { 1: 1 } : null) as T;
        }
        if (sql.includes('FROM server_keys') && sql.includes('key_version = 4')) {
          const publicKey = opts.serverKeys?.publicKey;
          const privateKeyJwk = opts.serverKeys?.privateKeyJwk;
          return publicKey && privateKeyJwk
            ? ({ public_key: publicKey, private_key_jwk: privateKeyJwk } as T)
            : (null as T);
        }
        return null as T;
      },
      async all<T>() {
        return { results: [] as T[] };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql: string) {
      return stmt(sql);
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Unit: config parsing and the consent gate
// ---------------------------------------------------------------------------

describe('parsePolicyConfig', () => {
  it('accepts valid content', () => {
    expect(
      parsePolicyConfig({ via: PS, public_keys: { ed25519: 'KEY' } })
    ).toEqual({ via: PS, ed25519: 'KEY' });
  });

  it('rejects missing or malformed pieces', () => {
    expect(parsePolicyConfig(null)).toBeNull();
    expect(parsePolicyConfig({})).toBeNull();
    expect(parsePolicyConfig({ via: '' })).toBeNull();
    expect(parsePolicyConfig({ via: PS })).toBeNull();
    expect(parsePolicyConfig({ via: PS, public_keys: {} })).toBeNull();
    expect(parsePolicyConfig({ via: 42, public_keys: { ed25519: 'KEY' } })).toBeNull();
    expect(parsePolicyConfig({ via: PS, public_keys: { ed25519: 7 } })).toBeNull();
  });

  it('extra key algorithms do not break parsing', () => {
    expect(
      parsePolicyConfig({ via: PS, public_keys: { ed25519: 'KEY', 'custom:algo': 'OTHER' } })
    ).toEqual({ via: PS, ed25519: 'KEY' });
  });
});

describe('eventExemptFromPolicy', () => {
  it('only the m.room.policy state event with empty state key is exempt', () => {
    expect(eventExemptFromPolicy({ type: 'm.room.policy', state_key: '' })).toBe(true);
    expect(eventExemptFromPolicy({ type: 'm.room.policy', state_key: 'x' })).toBe(false);
    expect(eventExemptFromPolicy({ type: 'm.room.policy' })).toBe(true); // absent state_key = ''
    expect(eventExemptFromPolicy({ type: 'm.room.message', state_key: '' })).toBe(false);
  });
});

describe('getRoomPolicyServer', () => {
  const state = [
    {
      type: 'm.room.policy',
      state_key: '',
      event_id: '$policy:example.com',
      content: { via: PS, public_keys: { ed25519: 'KEY' } },
    },
  ] as unknown as PDU[];

  it('requires a joined user of the via server (consent gate)', async () => {
    const withMember = await getRoomPolicyServer(policyDb({ joinedServers: [PS] }), ROOM, state);
    expect(withMember).toEqual({ via: PS, ed25519: 'KEY' });

    const withoutMember = await getRoomPolicyServer(policyDb({ joinedServers: ['other.org'] }), ROOM, state);
    expect(withoutMember).toBeNull();
  });

  it('no policy state means no policy server', async () => {
    expect(await getRoomPolicyServer(policyDb({ joinedServers: [PS] }), ROOM, [])).toBeNull();
  });

  it('non-empty state keys are ignored (not the room config)', async () => {
    const stray = [
      {
        type: 'm.room.policy',
        state_key: 'stray',
        content: { via: PS, public_keys: { ed25519: 'KEY' } },
      },
    ] as unknown as PDU[];
    expect(await getRoomPolicyServer(policyDb({ joinedServers: [PS] }), ROOM, stray)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sign/verify roundtrip with real keys
// ---------------------------------------------------------------------------

describe('policy signature roundtrip', () => {
  it('signEventAsPolicyServer output verifies via verifyPolicySignature', async () => {
    const key = await generateSigningKeyPair();
    const db = policyDb({
      joinedServers: [PS],
      serverKeys: { publicKey: key.publicKey, privateKeyJwk: JSON.stringify(key.privateKeyJwk) },
    });

    const event: Record<string, unknown> = {
      event_id: '$x:example.com',
      room_id: ROOM,
      sender: USER,
      type: 'm.room.message',
      content: { body: 'hello', msgtype: 'm.text' },
      origin_server_ts: 1_700_000_000_000,
      depth: 3,
      auth_events: [],
      prev_events: [],
      unsigned: { transaction_id: 't1' },
    };

    const signatures = await signEventAsPolicyServer(db, SERVER, event, '10');
    expect(signatures).toBeTruthy();
    expect(typeof signatures![SERVER][POLICY_KEY_ID]).toBe('string');

    const withSig = { ...event, signatures };
    expect(await verifyPolicySignature(withSig, SERVER, key.publicKey, '10')).toBe(true);

    // Tampering a kept field (sender) invalidates; redactable fields are
    // signature-invisible by design.
    const tampered = { ...withSig, sender: '@evil:evil.example.org' };
    expect(await verifyPolicySignature(tampered, SERVER, key.publicKey, '10')).toBe(false);

    // Wrong key does not verify.
    const otherKey = await generateSigningKeyPair();
    expect(await verifyPolicySignature(withSig, SERVER, otherKey.publicKey, '10')).toBe(false);

    // Missing signature map.
    expect(await verifyPolicySignature(event, SERVER, key.publicKey, '10')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Send-side: rooms with a policy server ask before storing
// ---------------------------------------------------------------------------

describe('MSC4284 send-side ask', () => {
  const key = { publicKey: '', privateKeyJwk: {} as JsonWebKey };

  async function psState() {
    // Generated lazily so the Ed25519 key exists before the state event.
    return [
      {
        type: 'm.room.policy',
        state_key: '',
        event_id: '$policy:example.com',
        content: { via: PS, public_keys: { ed25519: key.publicKey } },
      },
    ] as unknown as PDU[];
  }

  // Signs whatever the server POSTs — a well-behaved policy server.
  function mockAgreeingPS() {
    federationPost.mockImplementation(async (via: string, _path: string, event: Record<string, unknown>) => {
      const signed = (await signJson(
        redactEventForSigning(event as Record<string, unknown>, '10'),
        via,
        POLICY_KEY_ID,
        key.privateKeyJwk as JsonWebKey
      )) as { signatures: Record<string, Record<string, string>> };
      return new Response(JSON.stringify(signed.signatures), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const generated = await generateSigningKeyPair();
    key.publicKey = generated.publicKey;
    key.privateKeyJwk = generated.privateKeyJwk;

    getMembership.mockResolvedValue({ membership: 'join', eventId: '$m' });
    getStateEvent.mockImplementation(async (_db: unknown, _room: unknown, type: string) => {
      if (type === 'm.room.policy') {
        return (await psState())[0];
      }
      if (type === 'm.room.power_levels') {
        return {
          type: 'm.room.power_levels',
          state_key: '',
          event_id: '$pl',
          content: { users_default: 100, state_default: 0, events_default: 0 },
        };
      }
      return null;
    });
    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    getRoomEvents.mockResolvedValue({ events: [], end: 0 });
    storeEvent.mockResolvedValue(undefined);
    storeEventIdempotent.mockResolvedValue('$stored:example.com');
    notifyUsersOfEvent.mockResolvedValue(undefined);
  });

  function envFor(db: D1Database): Env {
    return {
      DB: db,
      SERVER_NAME: SERVER,
      CACHE: {} as KVNamespace,
      PUSH_NOTIFICATION_WORKFLOW: { create: async () => ({ id: 'wf' }) },
    } as unknown as Env;
  }

  const stubExecCtx = { waitUntil: () => {} } as never;

  it('attaches the policy signature to the stored event', async () => {
    mockAgreeingPS();
    const env = envFor(policyDb({ joinedServers: [PS] }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx1`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello' }),
      },
      env, stubExecCtx
    );
    expect(res.status).toBe(200);

    expect(federationPost).toHaveBeenCalledTimes(1);
    const [via, path] = federationPost.mock.calls[0];
    expect(via).toBe(PS);
    expect(path).toBe('/_matrix/policy/v1/sign');

    const stored = storeEvent.mock.calls.at(-1)![1] as PDU;
    const signatures = (stored as unknown as Record<string, unknown>).signatures as Record<
      string,
      Record<string, string>
    >;
    expect(typeof signatures?.[PS]?.[POLICY_KEY_ID]).toBe('string');
  });

  it('refusals surface verbatim to the client', async () => {
    federationPost.mockResolvedValue(
      new Response(JSON.stringify({ errcode: 'M_FORBIDDEN', error: 'The message appears to contain possible spam' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const env = envFor(policyDb({ joinedServers: [PS] }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx2`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'spam' }),
      },
      env, stubExecCtx
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { errcode: string; error: string };
    expect(body.errcode).toBe('M_FORBIDDEN');
    expect(body.error).toBe('The message appears to contain possible spam');
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('the in-process self-ask short-circuits when we are the policy server', async () => {
    const key = await generateSigningKeyPair();
    const db = policyDb({
      joinedServers: [PS],
      serverKeys: { publicKey: key.publicKey, privateKeyJwk: JSON.stringify(key.privateKeyJwk) },
    });
    const env = {
      DB: db,
      SERVER_NAME: SERVER,
      CACHE: {} as KVNamespace,
    } as unknown as Env;

    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });

    const event = {
      room_id: ROOM,
      sender: USER,
      type: 'm.room.message',
      content: { body: 'self-ask', msgtype: 'm.text' },
      origin_server_ts: 1_700_000_000_000,
      depth: 1,
      auth_events: [],
      prev_events: [],
    } as Record<string, unknown>;

    const asked = await askPolicyServerSignature(env, { via: SERVER, ed25519: key.publicKey }, event);
    expect('signature' in asked).toBe(true);
    if ('signature' in asked) {
      const withSig = { ...event, signatures: { [SERVER]: { [POLICY_KEY_ID]: asked.signature } } };
      expect(await verifyPolicySignature(withSig, SERVER, key.publicKey, '10')).toBe(true);
    }
    expect(federationPost).not.toHaveBeenCalled();

    // Unknown rooms refuse with M_NOT_FOUND, matching the endpoint.
    getRoom.mockResolvedValue(null);
    const refused = await askPolicyServerSignature(env, { via: SERVER, ed25519: key.publicKey }, event);
    expect(refused).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('an invalid returned signature is rejected', async () => {
    const other = await generateSigningKeyPair();
    federationPost.mockImplementation(async (via: string, _path: string, event: Record<string, unknown>) => {
      const signed = (await signJson(
        redactEventForSigning(event as Record<string, unknown>, '10'),
        via,
        POLICY_KEY_ID,
        other.privateKeyJwk
      )) as { signatures: Record<string, Record<string, string>> };
      return new Response(JSON.stringify(signed.signatures), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const env = envFor(policyDb({ joinedServers: [PS] }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx3`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello' }),
      },
      env, stubExecCtx
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errcode: string };
    expect(body.errcode).toBe('M_UNKNOWN');
    expect(storeEvent).not.toHaveBeenCalled();
  });

  it('m.room.policy state events are exempt from the ask', async () => {
    mockAgreeingPS();
    const env = envFor(policyDb({ joinedServers: [PS] }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.policy`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ via: PS, public_keys: { ed25519: key.publicKey } }),
      },
      env, stubExecCtx
    );
    expect(res.status).toBe(200);
    expect(federationPost).not.toHaveBeenCalled();
  });

  it('rooms without a joined policy server member send normally', async () => {
    mockAgreeingPS();
    const env = envFor(policyDb({ joinedServers: ['other.org'] }));
    const res = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${ROOM_ENC}/send/m.room.message/tx4`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'no ps here' }),
      },
      env, stubExecCtx
    );
    expect(res.status).toBe(200);
    expect(federationPost).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Serving POST /_matrix/policy/v1/sign ourselves
// ---------------------------------------------------------------------------

describe('MSC4284 policy server endpoint', () => {
  it('signs well-formed events in known rooms', async () => {
    const key = await generateSigningKeyPair();
    const db = policyDb({
      serverKeys: { publicKey: key.publicKey, privateKeyJwk: JSON.stringify(key.privateKeyJwk) },
    });
    const env = { DB: db, SERVER_NAME: SERVER, CACHE: {} as KVNamespace } as unknown as Env;

    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    getStateEvent.mockResolvedValue(null);

    const event = {
      event_id: '$e:remote.example.org',
      room_id: ROOM,
      sender: '@bob:remote.example.org',
      type: 'm.room.message',
      content: { body: 'x', msgtype: 'm.text' },
      origin_server_ts: 1_700_000_000_000,
      depth: 4,
      auth_events: [],
      prev_events: [],
    };

    const res = await federationApp.request('http://localhost/_matrix/policy/v1/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }, env);
    expect(res.status).toBe(200);
    const signatures = (await res.json()) as Record<string, Record<string, string>>;
    expect(typeof signatures[SERVER]?.[POLICY_KEY_ID]).toBe('string');

    // The signature we hand out verifies against the published key.
    const verified = await verifyPolicySignature(
      { ...event, signatures },
      SERVER,
      key.publicKey,
      '10'
    );
    expect(verified).toBe(true);
  });

  it('refuses unknown rooms, malformed events and the exempt type', async () => {
    const key = await generateSigningKeyPair();
    const db = policyDb({
      serverKeys: { publicKey: key.publicKey, privateKeyJwk: JSON.stringify(key.privateKeyJwk) },
    });
    const env = { DB: db, SERVER_NAME: SERVER, CACHE: {} as KVNamespace } as unknown as Env;

    getRoom.mockResolvedValue(null);
    const unknown = await federationApp.request('http://localhost/_matrix/policy/v1/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: '!ghost:example.com',
        type: 'm.room.message',
        sender: '@a:remote.example.org',
        content: {},
      }),
    }, env);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { errcode: string }).errcode).toBe('M_NOT_FOUND');

    const malformed = await federationApp.request('http://localhost/_matrix/policy/v1/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'm.room.message' }),
    }, env);
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { errcode: string }).errcode).toBe('M_BAD_JSON');

    getRoom.mockResolvedValue({ room_id: ROOM, room_version: '10' });
    const exempt = await federationApp.request('http://localhost/_matrix/policy/v1/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: ROOM,
        type: 'm.room.policy',
        state_key: '',
        sender: '@a:remote.example.org',
        content: {},
      }),
    }, env);
    expect(exempt.status).toBe(400);
  });
});
