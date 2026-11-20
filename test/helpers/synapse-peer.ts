// A mock Synapse federation peer for tests: implements the receive-side rules
// real Synapse applies to inbound PDUs, so tests can assert our outbound
// federation is acceptable to a real resident server without running one.
//
// Ported from Synapse (synapse/events/utils.py prune_event_dict,
// synapse/crypto/event_signing.py, synapse/event_auth.py):
//  - room v3+ PDUs must not carry event_id; IDs are reference hashes
//  - signatures cover the redacted event (version-dependent redaction)
//  - content hash covers the unredacted event minus signatures/unsigned/hashes
//  - auth_events must include the types the auth rules select; membership
//    joins need join_rules + prior membership (or a public join rule)
//  - /send events are auth-checked against current room state; failures are
//    rejected/outliered exactly like Synapse's "accepted but never displayed"
//
// Crypto is real (node ed25519), canonical JSON/redaction/hashing reuse the
// repo utilities which were verified byte-for-byte against Synapse.

import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { sha256 } from '../../src/utils/crypto';
import { verifyPdu as verifyPduProduct, checkAuthRules } from '../../src/services/federation-verify';
import type { PDU } from '../../src/types/matrix';
import { expectedAuthTypes } from '../../src/services/event-auth';

export interface PeerPdu {
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  depth: number;
  auth_events: string[];
  prev_events: string[];
  hashes?: { sha256: string };
  signatures?: Record<string, Record<string, string>>;
  event_id?: string;
  unsigned?: Record<string, unknown>;
}

export interface PeerRoom {
  version: string;
  state: Map<string, PeerPdu>; // "type\0state_key" -> current state event
  events: Map<string, PeerPdu>; // accepted event id -> pdu
  outliers: Map<string, string>; // event id -> rejection reason
  timeline: PeerPdu[];
}

const SEP = String.fromCharCode(0);
const slot = (type: string, stateKey: string | undefined) => type + SEP + (stateKey ?? '');

export class SynapsePeer {
  readonly serverName: string;
  readonly rooms = new Map<string, PeerRoom>();
  readonly verifyKeys: Record<string, string> = {}; // keyId -> unpadded b64 raw public key
  private privateKeys: Record<string, ReturnType<typeof createPublicKey>> = {};
  readonly rejections: Array<{ event_id: string; reason: string }> = [];

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  // Trust an origin server's published verify keys (as /key/v2/server serves).
  trustOrigin(origin: string, keys: Record<string, { key: string }>): void {
    for (const [kid, k] of Object.entries(keys)) {
      this.verifyKeys[`${origin}|${kid}`] = k.key;
    }
  }

  room(roomId: string, version: string): PeerRoom {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { version, state: new Map(), events: new Map(), outliers: new Map(), timeline: [] };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  // Delegate to the product's Synapse-rules port (single source of truth).
  async verifyPdu(pdu: PeerPdu, origin: string, version: string): Promise<string | null> {
    const keys = Object.entries(this.verifyKeys)
      .filter(([k]) => k.startsWith(`${origin}|`))
      .map(([k, key]) => ({ keyId: k.split('|')[1], publicKey: key }));
    const res = await verifyPduProduct(pdu as unknown as PDU, origin, version, keys);
    if ('error' in res) return res.error;
    pdu.event_id = res.eventId;
    return null;
  }

  checkAuth(pdu: PeerPdu, room: PeerRoom): string | null {
    const byId = new Map<string, PDU>();
    for (const e of room.events.values()) byId.set(e.event_id!, e as unknown as PDU);
    for (const e of room.state.values()) byId.set(e.event_id!, e as unknown as PDU);
    const state = new Map<string, PDU>();
    for (const [k, e] of room.state) state.set(k, e as unknown as PDU);
    return checkAuthRules(pdu as unknown as PDU, room.version, { byId, state });
  }

  // Inbound state (send_join / state fetch): verify then auth-check; failures
  // become outliers, exactly like Synapse state resolution rejecting them.
  async receiveState(roomId: string, pdus: PeerPdu[], origin: string): Promise<void> {
    const room = this.room(roomId, '10');
    for (const pdu of pdus) {
      const err = await this.verifyPdu(pdu, origin, room.version);
      if (err) {
        room.outliers.set(pdu.event_id ?? JSON.stringify(pdu).slice(0, 40), err);
        this.rejections.push({ event_id: pdu.event_id ?? '?', reason: err });
        continue;
      }
      const authErr = this.checkAuth(pdu, room);
      if (authErr) {
        room.outliers.set(pdu.event_id!, authErr);
        this.rejections.push({ event_id: pdu.event_id!, reason: authErr });
        continue;
      }
      room.events.set(pdu.event_id!, pdu);
      if (pdu.state_key !== undefined) room.state.set(slot(pdu.type, pdu.state_key), pdu);
    }
  }

  // Ingest state without auth-checking each state event (models a resident
  // that already holds the room state); signatures/hashes still verified.
  async ingestStateUnchecked(roomId: string, pdus: PeerPdu[], origin: string): Promise<void> {
    const room = this.room(roomId, '10');
    for (const pdu of pdus) {
      const err = await this.verifyPdu(pdu, origin, room.version);
      if (err) {
        this.rejections.push({ event_id: pdu.event_id ?? '?', reason: err });
        continue;
      }
      room.events.set(pdu.event_id!, pdu);
      if (pdu.state_key !== undefined) room.state.set(slot(pdu.type, pdu.state_key), pdu);
    }
  }

  // Inbound /send transaction PDU: verify, then auth-check against current
  // state. Rejected events are recorded (Synapse: 200 OK but never displayed).
  async receiveSend(roomId: string, pdu: PeerPdu, origin: string): Promise<string | null> {
    const room = this.room(roomId, '10');
    const err = await this.verifyPdu(pdu, origin, room.version);
    if (err) {
      this.rejections.push({ event_id: pdu.event_id ?? '?', reason: err });
      return err;
    }
    // Non-membership events require the sender to be joined in CURRENT state.
    if (pdu.type !== 'm.room.member') {
      const member = room.state.get(slot('m.room.member', pdu.sender));
      if (!member || member.content.membership !== 'join') {
        const reason = 'sender not in room (state membership missing or outliered)';
        this.rejections.push({ event_id: pdu.event_id!, reason });
        return reason;
      }
    }
    const authErr = this.checkAuth(pdu, room);
    if (authErr) {
      room.outliers.set(pdu.event_id!, authErr);
      this.rejections.push({ event_id: pdu.event_id!, reason: authErr });
      return authErr;
    }
    room.events.set(pdu.event_id!, pdu);
    if (pdu.state_key !== undefined) room.state.set(slot(pdu.type, pdu.state_key), pdu);
    else room.timeline.push(pdu);
    return null;
  }
}

// Generate an ed25519 signing keypair in the JWK shape the repo stores.
export function peerSigningKey(): { keyId: string; privateKeyJwk: JsonWebKey; verifyKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  const pub = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const keyId = 'ed25519:peer1';
  return { keyId, privateKeyJwk: priv, verifyKeyB64: (pub.x as string).replace(/=+$/, '') };
}

export { sha256 };

// node's webcrypto lacks workerd's NODE-ED25519 algorithm name; map it to
// Ed25519 for the duration of a test (same shim as the federation suites).
export function installNodeEd25519Shim(): () => void {
  const subtle = crypto.subtle;
  const origGenerateKey = subtle.generateKey.bind(subtle);
  const origImportKey = subtle.importKey.bind(subtle);
  const origSign = subtle.sign.bind(subtle);
  const origVerify = subtle.verify.bind(subtle);
  const mapAlg = (alg: unknown): AlgorithmIdentifier => {
    if (typeof alg === 'string') return alg === 'NODE-ED25519' ? 'Ed25519' : alg;
    if (alg && typeof alg === 'object' && (alg as { name?: string }).name === 'NODE-ED25519') return 'Ed25519';
    return alg as AlgorithmIdentifier;
  };
  subtle.generateKey = ((alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origGenerateKey(mapAlg(alg), extractable, usages)) as typeof subtle.generateKey;
  subtle.importKey = ((format: KeyFormat, keyData: BufferSource | JsonWebKey, alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) =>
    origImportKey(format, keyData, mapAlg(alg), extractable, usages)) as typeof subtle.importKey;
  subtle.sign = ((alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) =>
    origSign(mapAlg(alg), key, data)) as typeof subtle.sign;
  subtle.verify = ((alg: AlgorithmIdentifier, key: CryptoKey, signature: BufferSource, data: BufferSource) =>
    origVerify(mapAlg(alg), key, signature, data)) as typeof subtle.verify;
  return () => {
    subtle.generateKey = origGenerateKey;
    subtle.importKey = origImportKey;
    subtle.sign = origSign;
    subtle.verify = origVerify;
  };
}
