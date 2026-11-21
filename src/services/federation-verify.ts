// Receive-side federation verification, mirroring Synapse's inbound checks
// (synapse/federation/federation_client.py _check_sigs_and_hash_and_fetch_one,
// synapse/event_auth.py). A resident server that accepts PDUs without these
// checks diverges from the federation contract: invalid events must be
// rejected (per-PDU error in /send responses), not stored and displayed.
//
// Rules:
//  - room v3+ PDUs must not carry event_id; IDs are reference hashes
//  - signatures cover the redacted event (room-version-dependent redaction)
//  - content hash covers the event minus signatures/unsigned/hashes
//  - auth_events must include the types the auth rules select, whenever such
//    events exist at or before the event's depth (state at event time)
//  - membership joins need join_rules in auth_events and an invite unless the
//    join rule is public; non-membership events need a joined sender in state

import type { PDU } from '../types/matrix';
import { calculateContentHash, canonicalJson } from '../utils/crypto';
import { computeEventReferenceHash, redactEventForSigning } from '../utils/event-signing';
import { expectedAuthTypes } from './event-auth';

interface Ed25519Params {
  name: 'NODE-ED25519';
  namedCurve: 'NODE-ED25519';
}

const SEP = String.fromCharCode(0);
const slot = (type: string, stateKey: string | undefined): string => type + SEP + (stateKey ?? '');

export interface VerifyKey {
  keyId: string;
  publicKey: string; // unpadded base64 raw ed25519 public key
}

export interface AuthEventSource {
  // All events the receiver holds for the room (state + timeline + outliers),
  // used to resolve auth references and to know what existed at event time.
  byId: Map<string, PDU>;
  // Current state slots.
  state: Map<string, PDU>;
}

// Parse-level checks: wire event_id rules, reference-hash ID, signatures and
// content hash. Returns the derived event ID or an error string.
export async function verifyPdu(
  pdu: PDU,
  origin: string,
  roomVersion: string,
  keys: VerifyKey[]
): Promise<{ eventId: string } | { error: string }> {
  const num = parseInt(roomVersion, 10);
  const modern = !Number.isFinite(num) || num >= 3;
  const wire = pdu as unknown as Record<string, unknown>;
  // Modern room versions derive the event ID from the reference hash, and
  // redaction already excludes event_id from that hash and from the signed
  // canonical JSON. Real peers (Synapse) sometimes still include the field,
  // so ignore it rather than rejecting an otherwise-valid PDU — the ID below
  // is computed from the wire, never taken from the field.
  if (!modern && wire['event_id'] === undefined) {
    return { error: 'missing event_id for legacy room version' };
  }
  const eventId = modern
    ? `$${await computeEventReferenceHash(wire, roomVersion)}`
    : (wire['event_id'] as string);

  const canonicalForms: string[] = [];
  const canonicalFor = (version: string): string => {
    const redacted = redactEventForSigning(wire, version);
    delete redacted['signatures'];
    delete redacted['unsigned'];
    return canonicalJson(redacted);
  };
  canonicalForms.push(canonicalFor(roomVersion));
  // Pre-2023 Synapse events in v3-v10 rooms were signed with the legacy
  // keep-list (origin/prev_state retained). Accept that shape as a fallback
  // so old federated history still verifies without breaking modern peers.
  if (modern && num >= 3 && num <= 10) canonicalForms.push(canonicalFor('2'));
  const sigs = (wire['signatures'] as Record<string, Record<string, string>> | undefined)?.[origin];
  if (!sigs || Object.keys(sigs).length === 0) {
    return { error: `no signature from ${origin}` };
  }
  let sigOk = false;
  for (const [kid, sig] of Object.entries(sigs)) {
    const key = keys.find((k) => k.keyId === kid);
    if (!key) continue;
    const pub = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(key.publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.publicKey.length % 4)) % 4)), (c) => c.charCodeAt(0)),
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as Ed25519Params,
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (sig.length % 4)) % 4)), (c) => c.charCodeAt(0));
    for (const canonical of canonicalForms) {
      if (await crypto.subtle.verify({ name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as Ed25519Params, pub, sigBytes, new TextEncoder().encode(canonical))) {
        sigOk = true;
      }
    }
  }
  if (!sigOk) return { error: `invalid signature from ${origin}` };

  const hashes = wire['hashes'] as { sha256?: string } | undefined;
  if (hashes?.sha256) {
    const expect = await calculateContentHash(wire);
    if (expect.replace(/=+$/, '') !== hashes.sha256.replace(/=+$/, '')) {
      return { error: 'content hash mismatch' };
    }
  }
  return { eventId };
}

// Auth-rules check against the auth events the PDU references plus current
// state. Returns a rejection reason or null.
export function checkAuthRules(
  pdu: PDU,
  _roomVersion: string,
  source: AuthEventSource
): string | null {
  if (pdu.type === 'm.room.create') return null;
  const authMap = new Map<string, PDU>();
  for (const ref of pdu.auth_events ?? []) {
    const e = source.byId.get(ref);
    if (e) authMap.set(slot(e.type, e.state_key), e);
  }
  const expected = expectedAuthTypes(pdu.type, pdu.sender, pdu.state_key, (pdu.content ?? {}) as Record<string, unknown>);
  for (const key of expected) {
    if (authMap.has(key)) continue;
    const [type, stateKey] = key.split(SEP);
    // Prior target membership / old power_levels / sender membership may
    // legitimately not exist yet at the event's depth (e.g. power_levels
    // precedes the creator's join). Only require what existed by then.
    let existed = false;
    for (const e of source.byId.values()) {
      if (e.type === type && (e.state_key ?? '') === stateKey && (e.depth ?? 0) <= (pdu.depth ?? 0)) {
        existed = true;
        break;
      }
    }
    if (existed) return `missing auth event type ${type} ${stateKey}`;
  }

  const pl = (authMap.get(slot('m.room.power_levels', ''))?.content ?? {}) as Record<string, any>;
  const senderMember = authMap.get(slot('m.room.member', pdu.sender));
  const powerOf = (user: string): number => pl.users?.[user] ?? pl.users_default ?? 0;
  const required = pl.events?.[pdu.type] ?? pl.state_default ?? 50;

  if (pdu.type === 'm.room.member') {
    const membership = (pdu.content as Record<string, any>)?.membership;
    const jr = (authMap.get(slot('m.room.join_rules', ''))?.content ??
      source.state.get(slot('m.room.join_rules', ''))?.content ?? {}) as Record<string, any>;
    const prev = authMap.get(slot('m.room.member', pdu.state_key!));
    if (membership === 'join') {
      // join_rules is only required in auth_events once it exists at the
      // event's depth (the creator's first join precedes it).
      if (!authMap.has(slot('m.room.join_rules', ''))) {
        for (const e of source.byId.values()) {
          if (e.type === 'm.room.join_rules' && (e.depth ?? 0) <= (pdu.depth ?? 0)) {
            return 'join without join_rules in auth_events';
          }
        }
      }
      if (jr.join_rule === 'invite' && prev?.content?.membership !== 'invite') return 'not invited';
      if (senderMember?.content?.membership === 'ban') return 'banned';
    } else if (membership === 'invite') {
      if (senderMember?.content?.membership !== 'join') return 'inviter not in room';
      if (powerOf(pdu.sender) < (pl.invite ?? 0)) return 'insufficient power to invite';
    } else if (membership === 'ban' || membership === 'leave') {
      if (senderMember?.content?.membership !== 'join' && pdu.sender !== pdu.state_key) {
        return 'sender not in room';
      }
    }
    return null;
  }
  if (senderMember?.content?.membership !== 'join') return 'sender not in room (membership)';
  if (pdu.state_key !== undefined && powerOf(pdu.sender) < required) return 'insufficient power level';
  return null;
}