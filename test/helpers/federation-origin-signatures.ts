// Test fixtures for inbound /send PDUs: generate a real Ed25519 key once,
// seed it into the fake KV key cache, and sign PDUs with the sender's own
// server key. This mirrors federation-real-crypto.test.ts so that /send
// fixtures exercise the same strict origin-signature path as production
// instead of relying on mocked verifyRemoteSignature booleans.

import { generateSigningKeyPair, signJson } from '../../src/utils/crypto';
import { redactEventForSigning } from '../../src/utils/event-signing';

const SHIM_INSTALLED = Symbol.for('matrix-workers-test.ed25519-shim');

function installEd25519Shim(): void {
  const marker = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (marker[SHIM_INSTALLED]) return;
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);
  const mapAlg = (alg: unknown): AlgorithmIdentifier => {
    if (typeof alg === 'string') return (alg === 'NODE-ED25519' ? 'Ed25519' : alg) as AlgorithmIdentifier;
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
  ) => origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((
    alg: AlgorithmIdentifier,
    key: CryptoKey,
    signature: BufferSource,
    data: BufferSource
  ) => origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;
  marker[SHIM_INSTALLED] = true;
}

installEd25519Shim();

const KEY_ID = 'ed25519:fixture';
let keyPairPromise: Promise<{
  keyId: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
}> | undefined;

function fixtureKeyPair() {
  keyPairPromise ??= generateSigningKeyPair().then((pair) => ({
    keyId: pair.keyId,
    publicKey: pair.publicKey,
    privateKeyJwk: pair.privateKeyJwk,
  }));
  return keyPairPromise;
}

/** Put the fixture verify key where fetchRemoteServerKeys() finds it. */
export async function seedPduVerifyKey(
  cache: { put: (key: string, value: string, options?: unknown) => Promise<unknown> },
  serverName: string
): Promise<void> {
  const pair = await fixtureKeyPair();
  const now = Date.now();
  await cache.put(
    `federation:keys:${serverName}`,
    JSON.stringify([
      {
        server_name: serverName,
        key_id: pair.keyId,
        public_key: pair.publicKey,
        valid_from: now - 60_000,
        valid_until: now + 24 * 60 * 60 * 1000,
        fetched_at: now,
        verified: 1,
      },
    ])
  );
}

/** Sign a PDU with its sender server's key, keeping any existing hashes. */
export async function signPduForOrigin<T extends Record<string, unknown>>(
  pdu: T,
  origin: string,
  version = '10'
): Promise<T> {
  const pair = await fixtureKeyPair();
  // Sign over the room version's redaction rules, matching the /send handler
  // (which no longer keys the version off the presence of an event_id).
  // `hashes` is a retained top-level field and MUST be included: real
  // Synapse signs it, so stripping it only makes self-signed fixtures pass.
  const redacted = redactEventForSigning(pdu, version);
  const signed = await signJson(redacted, origin, pair.keyId, pair.privateKeyJwk);
  const originSigs = (signed.signatures as Record<string, Record<string, string>>)[origin];
  return {
    ...pdu,
    signatures: {
      ...((pdu.signatures as Record<string, Record<string, string>> | undefined) ?? {}),
      [origin]: originSigs,
    },
  } as T;
}

/**
 * Sign an event including its content hash, for endpoints (send_leave) that
 * verify the complete event rather than a hash-free verification view.
 */
export async function signEventForOrigin<T extends Record<string, unknown>>(
  event: T,
  origin: string,
  version = '10'
): Promise<T> {
  const pair = await fixtureKeyPair();
  const redacted = redactEventForSigning(event, version);
  const signed = await signJson(redacted, origin, pair.keyId, pair.privateKeyJwk);
  const originSigs = (signed.signatures as Record<string, Record<string, string>>)[origin];
  return {
    ...event,
    signatures: {
      ...((event.signatures as Record<string, Record<string, string>> | undefined) ?? {}),
      [origin]: originSigs,
    },
  } as T;
}

const EXPLICIT_INVALID_SIGNATURES = new Set(['bad', 'invalid', '__invalid__']);

/**
 * Prepare a /send request body: sign every PDU with its sender server's real
 * key and seed the matching verify key. Fixtures that deliberately exercise
 * signature rejection are left untouched:
 *   - an explicit placeholder of 'bad' / 'invalid';
 *   - signatures by another server only (the foreign-signatory attack).
 */
export async function signSendBodyPdus(
  env: {
    CACHE: { put: (key: string, value: string, options?: unknown) => Promise<unknown> };
    DB?: { prepare: (sql: string) => { bind: (...args: unknown[]) => { first: () => Promise<unknown> } } };
  },
  body: unknown,
  versionOverride?: string
): Promise<unknown> {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { pdus?: unknown }).pdus)) {
    return body;
  }
  const roomVersion = async (roomId: unknown): Promise<string> => {
    if (versionOverride) return versionOverride;
    if (typeof roomId !== 'string' || !env.DB) return '10';
    try {
      const row = await env.DB.prepare('SELECT room_version FROM rooms WHERE room_id = ?')
        .bind(roomId).first() as { room_version?: string } | null;
      return row?.room_version ?? '10';
    } catch {
      return '10';
    }
  };
  const pdus: unknown[] = [];
  for (const raw of (body as { pdus: unknown[] }).pdus) {
    if (!raw || typeof raw !== 'object') {
      pdus.push(raw);
      continue;
    }
    const pdu = raw as Record<string, unknown>;
    const sender = typeof pdu.sender === 'string' ? pdu.sender : '';
    // Match the /send handler's origin derivation (sender.split(':')[1]).
    const origin = sender.includes(':') ? sender.split(':')[1] : '';
    const signatures = pdu.signatures as Record<string, Record<string, string>> | undefined;
    const placeholderInvalid = signatures
      ? Object.values(signatures).some((byKey) =>
          Object.values(byKey).some((sig) => EXPLICIT_INVALID_SIGNATURES.has(sig))
        )
      : false;
    const foreignOnly = !!signatures && Object.keys(signatures).length > 0 && !!origin && !signatures[origin];
    if (!origin || placeholderInvalid || foreignOnly) {
      pdus.push(pdu);
      continue;
    }
    await seedPduVerifyKey(env.CACHE, origin);
    pdus.push(await signPduForOrigin(pdu, origin, await roomVersion(pdu.room_id)));
  }
  return { ...(body as Record<string, unknown>), pdus };
}
