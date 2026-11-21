// Policy Servers — MSC4284, stable since spec v1.18.
//
// A room "uses" a Policy Server when its current state has a valid
// m.room.policy event (empty state key, string `via`, object
// `public_keys` with a string `ed25519`) AND that `via` server has at
// least one joined user. Every event except the m.room.policy state
// event itself must then carry the Policy Server's countersignature
// (always keyed `ed25519:policy_server` under the PS server name);
// sending servers ask for it via POST /_matrix/policy/v1/sign before
// sending, and receiving servers soft-fail events that never present a
// valid one.

import type { Env, PDU } from '../types';
import { getRoom, getStateEvent } from './database';
import { federationPost } from './federation-keys';
import { redactEventForSigning } from '../utils/event-signing';
import { verifySignature, signJson, generateSigningKeyPair } from '../utils/crypto';

// The signature key ID for policy servers is fixed by the spec.
export const POLICY_KEY_ID = 'ed25519:policy_server';

// Bound on asking a policy server: a hung PS must not stall client sends
// indefinitely (the underlying fetch is abandoned, not cancelled).
const ASK_TIMEOUT_MS = 10_000;

export interface PolicyConfig {
  via: string;
  ed25519: string;
}

export function parsePolicyConfig(content: unknown): PolicyConfig | null {
  if (!content || typeof content !== 'object') return null;
  const { via, public_keys: publicKeys } = content as Record<string, unknown>;
  const ed25519 =
    publicKeys && typeof publicKeys === 'object'
      ? (publicKeys as Record<string, unknown>).ed25519
      : undefined;
  if (typeof via !== 'string' || !via) return null;
  if (typeof ed25519 !== 'string' || !ed25519) return null;
  return { via, ed25519 };
}

// The m.room.policy state event itself is never signed by the policy
// server — that is what keeps the room recoverable when the PS is bad.
export function eventExemptFromPolicy(event: {
  type?: unknown;
  state_key?: unknown;
}): boolean {
  return event.type === 'm.room.policy' && (event.state_key ?? '') === '';
}

// Resolve the room's policy server, or null when the room does not use
// one (no/invalid state, or the `via` server has no joined user — the
// spec's consent gate). Pass an already-loaded room state to avoid the
// extra query on the federation receive path.
export async function getRoomPolicyServer(
  db: D1Database,
  roomId: string,
  roomState?: PDU[]
): Promise<PolicyConfig | null> {
  let content: unknown;
  if (Array.isArray(roomState)) {
    const policyEvent = roomState.find(
      (e) => e.type === 'm.room.policy' && (e.state_key ?? '') === ''
    );
    content = policyEvent?.content;
  } else {
    const policyEvent = await getStateEvent(db, roomId, 'm.room.policy', '');
    content = policyEvent?.content;
  }

  const config = parsePolicyConfig(content);
  if (!config) return null;

  // Joined-user gate, LIKE-escaped: the user-ID suffix must equal `via`.
  const likeSuffix = `:${config.via.replace(/([%_\\])/g, '\\$1')}`;
  const member = await db
    .prepare(
      `SELECT 1 FROM room_memberships
       WHERE room_id = ? AND membership = 'join' AND user_id LIKE '%' || ? ESCAPE '\\'
       LIMIT 1`
    )
    .bind(roomId, likeSuffix)
    .first();

  return member ? config : null;
}

// Verify a policy server countersignature on an event. Signatures are
// calculated over the redacted event form, like all event signatures.
export async function verifyPolicySignature(
  event: Record<string, unknown>,
  policyServerName: string,
  policyKeyB64: string,
  roomVersion: string
): Promise<boolean> {
  try {
    const signatures = (event.signatures ?? {}) as Record<string, Record<string, string>>;
    if (typeof signatures[policyServerName]?.[POLICY_KEY_ID] !== 'string') return false;
    const redacted = redactEventForSigning(event as Record<string, unknown>, roomVersion);
    return verifySignature(redacted, policyServerName, POLICY_KEY_ID, policyKeyB64);
  } catch {
    return false;
  }
}

// Attach a policy server signature to an event's signature map (in place).
export function attachPolicySignature(
  event: Record<string, unknown>,
  policyServerName: string,
  signature: string
): void {
  const signatures = (event.signatures ?? {}) as Record<string, Record<string, string>>;
  signatures[policyServerName] = {
    ...(signatures[policyServerName] ?? {}),
    [POLICY_KEY_ID]: signature,
  };
  event.signatures = signatures;
}

export type PolicyAskResult =
  | { signature: string }
  | { errcode: string; error: string; status: number };

// POST the event to the policy server's /sign endpoint. Errors are
// returned verbatim (the spec wants them surfaced to clients); transport
// failures become a 502-flavoured M_UNKNOWN.
export async function askPolicyServerSignature(
  env: Env,
  config: PolicyConfig,
  event: Record<string, unknown>
): Promise<PolicyAskResult> {
  // We are the policy server: resolve the ask in-process instead of a
  // network hop. A Cloudflare route-worker cannot fetch its own URL (the
  // edge blocks worker self-invocation), so the network path would always
  // fail — and the in-process result is identical: same key, same policy
  // as POST /_matrix/policy/v1/sign, same signature remote servers verify
  // against the well-known key.
  if (config.via === env.SERVER_NAME) {
    try {
      const room = await getRoom(env.DB, String(event.room_id ?? ''));
      if (!room) {
        return {
          errcode: 'M_NOT_FOUND',
          error: 'The room is not known to this policy server',
          status: 404,
        };
      }
      const signatures = await signEventAsPolicyServer(
        env.DB,
        env.SERVER_NAME,
        event,
        String(room.room_version ?? '10')
      );
      const signature = signatures?.[env.SERVER_NAME]?.[POLICY_KEY_ID];
      if (typeof signature === 'string') {
        return { signature };
      }
      return {
        errcode: 'M_UNKNOWN',
        error: 'The policy server key is unavailable',
        status: 500,
      };
    } catch (err) {
      console.warn('[policy] in-process self-ask failed:', err);
      return {
        errcode: 'M_UNKNOWN',
        error: 'The policy server could not sign the event',
        status: 500,
      };
    }
  }

  let response: Response;
  try {
    response = await Promise.race([
      federationPost(
        config.via,
        '/_matrix/policy/v1/sign',
        event,
        env.SERVER_NAME,
        env.DB,
        env.CACHE
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('policy server ask timed out')), ASK_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.warn('[policy] ask failed:', config.via, err);
    return {
      errcode: 'M_UNKNOWN',
      error: `The policy server (${config.via}) could not be reached`,
      status: 502,
    };
  }

  if (!response.ok) {
    let errcode = 'M_FORBIDDEN';
    let error = 'The policy server refused to sign the event';
    try {
      const body = (await response.json()) as { errcode?: string; error?: string };
      if (typeof body.errcode === 'string') errcode = body.errcode;
      if (typeof body.error === 'string') error = body.error;
    } catch {
      // keep defaults
    }
    return { errcode, error, status: response.status === 429 ? 429 : 403 };
  }

  try {
    const body = (await response.json()) as Record<string, Record<string, string>>;
    const signature =
      body[config.via]?.[POLICY_KEY_ID] ??
      Object.values(body)[0]?.[POLICY_KEY_ID];
    if (typeof signature === 'string') {
      return { signature };
    }
  } catch {
    // fall through
  }
  return {
    errcode: 'M_UNKNOWN',
    error: 'The policy server response was missing its signature',
    status: 502,
  };
}

// ---------------------------------------------------------------
// Acting as a policy server ourselves (optional part of the module).
// The signing key is deliberately NOT the server's federation signing
// key: "can recommend events" stays separate from "can send federation
// traffic", and rooms can rotate us out of the m.room.policy state
// without our cooperation. Stored in server_keys as key_version 4.
// ---------------------------------------------------------------
export async function getPolicyServerKey(
  db: D1Database
): Promise<{ publicKey: string; privateKeyJwk: JsonWebKey } | null> {
  try {
    const existing = await db
      .prepare(
        `SELECT public_key, private_key_jwk FROM server_keys
         WHERE is_current = 1 AND key_version = 4`
      )
      .first<{ public_key: string; private_key_jwk: string }>();
    if (existing?.public_key && existing?.private_key_jwk) {
      return {
        publicKey: existing.public_key,
        privateKeyJwk: JSON.parse(existing.private_key_jwk),
      };
    }
  } catch {
    // fall through to generation
  }

  try {
    const { publicKey, privateKeyJwk, keyId } = await generateSigningKeyPair();
    const now = Date.now();
    await db
      .prepare(
        `INSERT OR IGNORE INTO server_keys
         (key_id, public_key, private_key, private_key_jwk, key_version, valid_from, valid_until, is_current)
         VALUES (?, ?, ?, ?, 4, ?, ?, 1)`
      )
      .bind(
        keyId,
        publicKey,
        JSON.stringify(privateKeyJwk),
        JSON.stringify(privateKeyJwk),
        now,
        now + 10 * 365 * 24 * 60 * 60 * 1000
      )
      .run();
    return { publicKey, privateKeyJwk };
  } catch (err) {
    console.error('[policy] failed to generate policy server key:', err);
    return null;
  }
}

// Sign an event (PDU form) with the policy key. Returns the signature
// map keyed by our server name, per the /sign response shape.
export async function signEventAsPolicyServer(
  db: D1Database,
  serverName: string,
  event: Record<string, unknown>,
  roomVersion: string
): Promise<Record<string, Record<string, string>> | null> {
  const key = await getPolicyServerKey(db);
  if (!key) return null;
  const redacted = redactEventForSigning(event as Record<string, unknown>, roomVersion);
  const signed = (await signJson(
    redacted,
    serverName,
    POLICY_KEY_ID,
    key.privateKeyJwk
  )) as Record<string, unknown> & { signatures: Record<string, Record<string, string>> };
  return signed.signatures;
}
