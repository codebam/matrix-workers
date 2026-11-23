import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  generateSigningKeyPair,
  signJson,
  verifySignature,
} from '../src/utils/crypto';

/** Remap Cloudflare's NODE-ED25519 algorithm name to Node's Ed25519 for unit tests. */
function installNodeEd25519Shim() {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);

  const mapAlg = (alg: unknown): unknown => {
    if (typeof alg === 'string') {
      return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    }
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') {
      return { ...(alg as object), name: 'Ed25519' };
    }
    return alg;
  };

  subtle.generateKey = ((alg: unknown, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg) as AlgorithmIdentifier, extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((
    format: KeyFormat,
    keyData: BufferSource | JsonWebKey,
    alg: unknown,
    extractable: boolean,
    usages: KeyUsage[]
  ) => origImportKey(format, keyData, mapAlg(alg) as AlgorithmIdentifier, extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: unknown, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg) as AlgorithmIdentifier, key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: unknown,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg) as AlgorithmIdentifier, key, signature, data)) as typeof subtle.verify;

  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}

describe('multi-signature survival of countersignature merge', () => {
  let restore: (() => void) | undefined;

  beforeAll(() => {
    restore = installNodeEd25519Shim();
  });

  afterAll(() => {
    restore?.();
  });

  it('preserves each server signature when countersigning sequentially (2 servers)', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();

    const baseEvent = {
      type: 'm.room.member',
      room_id: '!room:example.com',
      state_key: '@alice:example.com',
      content: { membership: 'join' },
      sender: '@bob:example.com',
      origin_server_ts: 1234567890,
    };

    const first = await signJson(baseEvent, 'server-a.example.com', a.keyId, a.privateKeyJwk);
    const firstSig = (first.signatures as Record<string, Record<string, string>>)['server-a.example.com'][a.keyId];

    const second = await signJson(first, 'server-b.example.com', b.keyId, b.privateKeyJwk);
    const sigs = second.signatures as Record<string, Record<string, string>>;

    // First server's signature survives the second countersignature.
    expect(sigs['server-a.example.com'][a.keyId]).toBe(firstSig);
    // Second server's signature is present.
    expect(sigs['server-b.example.com'][b.keyId]).toBeDefined();
    expect(typeof sigs['server-b.example.com'][b.keyId]).toBe('string');

    // Both verify against the final merged object.
    expect(await verifySignature(second, 'server-a.example.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(second, 'server-b.example.com', b.keyId, b.publicKey)).toBe(true);
  });

  it('preserves each server signature when countersigning sequentially (3 servers)', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();
    const c = await generateSigningKeyPair();

    const baseEvent = {
      type: 'm.room.member',
      room_id: '!room:example.com',
      content: { membership: 'invite' },
    };

    const signedA = await signJson(baseEvent, 'server-a.example.com', a.keyId, a.privateKeyJwk);
    const sigA = (signedA.signatures as Record<string, Record<string, string>>)['server-a.example.com'][a.keyId];

    const signedB = await signJson(signedA, 'server-b.example.com', b.keyId, b.privateKeyJwk);
    const sigB = (signedB.signatures as Record<string, Record<string, string>>)['server-b.example.com'][b.keyId];
    // A survives B.
    expect((signedB.signatures as Record<string, Record<string, string>>)['server-a.example.com'][a.keyId]).toBe(sigA);

    const signedC = await signJson(signedB, 'server-c.example.com', c.keyId, c.privateKeyJwk);
    const sigs = signedC.signatures as Record<string, Record<string, string>>;

    expect(sigs['server-a.example.com'][a.keyId]).toBe(sigA);
    expect(sigs['server-b.example.com'][b.keyId]).toBe(sigB);
    expect(typeof sigs['server-c.example.com'][c.keyId]).toBe('string');

    expect(await verifySignature(signedC, 'server-a.example.com', a.keyId, a.publicKey)).toBe(true);
    expect(await verifySignature(signedC, 'server-b.example.com', b.keyId, b.publicKey)).toBe(true);
    expect(await verifySignature(signedC, 'server-c.example.com', c.keyId, c.publicKey)).toBe(true);
  });

  it('does not replace other servers keys when merging (server-level isolation)', async () => {
    const a = await generateSigningKeyPair();
    const b = await generateSigningKeyPair();

    const baseEvent = { type: 'm.test', content: { n: 1 } };

    const signedA = await signJson(baseEvent, 'server-a.example.com', a.keyId, a.privateKeyJwk);
    const signedB = await signJson(signedA, 'server-b.example.com', b.keyId, b.privateKeyJwk);

    const sigs = signedB.signatures as Record<string, Record<string, string>>;
    expect(Object.keys(sigs).sort()).toEqual(['server-a.example.com', 'server-b.example.com'].sort());
    // Ensure no cross-contamination: each server only carries its own keyId.
    expect(Object.keys(sigs['server-a.example.com'])).toEqual([a.keyId]);
    expect(Object.keys(sigs['server-b.example.com'])).toEqual([b.keyId]);
  });
});

// Path-level note:
// policy-server.ts attachPolicySignature and federation.ts invite v2 path preserve the
// event-origin signature by merging into the existing signatures object (never replacing
// other servers' keys), mirroring signJson above. A full unit test of those paths would
// require heavy HTTP/DB mocking (policy server /sign round-trips, D1, KV, Hono context),
// so it is skipped here; the crypto-level merge semantics they rely on are covered above.
