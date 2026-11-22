// Matrix Server-Server (Federation) API endpoints

import { Hono } from 'hono';
import type { AppEnv, Env, PDU } from '../types';
import { Errors } from '../utils/errors';
import { generateSigningKeyPair, signJson, sha256, verifySignature, verifyContentHash } from '../utils/crypto';
import { computeWireEventId, inboundWireEventIdCandidates, isMsc4291RoomVersion, redactEventForSigning, toWireEventObject, omitWireEventId } from '../utils/event-signing';
import { requireFederationAuth } from '../middleware/federation-auth';
import { federationOriginRateLimit } from '../middleware/rate-limit';
import {
  fetchRemoteServerKeys,
  getRemoteKeysWithNotarySignature,
  getServerSigningKey,
  type ServerKeyResponse,
} from '../services/federation-keys';
import { validateUrl } from '../utils/url-validator';
import { checkEventAuth } from '../services/event-auth';
import { getRoom, getRoomState, createRoom, getEvent, storeEvent, storeEventIdempotent, updateMembership, notifyUserSync, getInvitePermission } from '../services/database';
import { findServerAcl, isServerAllowedByAcl, isServerAllowedInRoom, serverNameFromId } from '../services/server-acl';
import { getRoomVersion } from '../services/room-versions';
import { MSC4583_ROOM_VERSION } from './msc4583';
import { evaluateRestrictedJoin, refreshRestrictedRoomState } from '../services/restricted-joins';
import { applyEventRedaction } from '../services/event-redaction';
import {
  getActivePolicyRules,
  isServerBannedByPolicy,
  isUserBannedByPolicy,
} from '../services/moderation-policy';
import {
  askPolicyServerSignature,
  attachPolicySignature,
  eventExemptFromPolicy,
  getRoomPolicyServer,
  signEventAsPolicyServer,
  verifyPolicySignature,
} from '../services/policy-server';

// Spec module "Server ACLs" (MSC4436): denied servers get no room content
// from any federation surface. The transaction, make_join, send_join and
// invite paths enforce this at their auth points; this guard covers the
// read endpoints. Lookup failures fall open (read posture).
async function callerDeniedByRoomAcl(
  c: { env: Env; get: (key: string) => unknown },
  roomId: string
): Promise<boolean> {
  const origin = c.get('federationOrigin') as string | undefined;
  if (!origin || !roomId) return false;
  try {
    return !(await isServerAllowedInRoom(c.env.DB, roomId, origin));
  } catch {
    return false;
  }
}

// Wire derivation rebuilds a whole room's IDs from stored rows. That is only
// sound for rooms WE created: a remote-created room's stored IDs are the
// residents' real IDs (their events can carry fields we never stored, e.g.
// pre-2023 `origin`), so re-deriving them produces phantom references no peer
// resolves. Callers that use deriveRoomWireEvents directly must gate here.
async function roomWireDerivationAllowed(env: Env, roomId: string): Promise<boolean> {
  try {
    const create = await env.DB.prepare(
      `SELECT e.event_id, e.sender FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
    ).bind(roomId).first<{ event_id: string; sender?: string }>();
    if (!create) return false;
    if (create.sender) return create.sender.endsWith(`:${env.SERVER_NAME}`);
    // Some D1 wrappers return only the projected event_id; resolve the
    // sender from the event row before deciding.
    const eventRow = await env.DB.prepare(
      `SELECT sender FROM events WHERE event_id = ?`
    ).bind(create.event_id).first<{ sender: string }>();
    return Boolean(eventRow?.sender?.endsWith(`:${env.SERVER_NAME}`));
  } catch {
    return false;
  }
}

// MSC4284: membership events (invites, joins) in policy-server rooms must
// carry a valid PS countersignature. Timeline events without one are
// soft-failed; membership is refused outright instead — soft-failing a
// join/invite would corrupt local membership views. A fresh signature is
// requested first (the PS key may have rotated between send and receipt).
// Resolution failures fall open: membership must not wedge on our bugs.
async function policySignatureMissing(
  c: { env: Env; get: (key: string) => unknown },
  event: Record<string, unknown>,
  roomVersion: string
): Promise<boolean> {
  try {
    const roomId = typeof event.room_id === 'string' ? event.room_id : '';
    if (!roomId) return false;
    const config = await getRoomPolicyServer(c.env.DB, roomId);
    if (!config || eventExemptFromPolicy(event)) return false;

    if (await verifyPolicySignature(event, config.via, config.ed25519, roomVersion)) {
      return false;
    }
    const asked = await askPolicyServerSignature(c.env, config, event);
    if ('signature' in asked) {
      const candidate = {
        ...((event.signatures as Record<string, unknown> | undefined) ?? {}),
      };
      attachPolicySignature(candidate, config.via, asked.signature);
      if (
        await verifyPolicySignature(
          { ...event, signatures: candidate },
          config.via,
          config.ed25519,
          roomVersion
        )
      ) {
        // Redeemed: keep the fresh countersignature on the event.
        event.signatures = candidate;
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn('[policy] membership countersignature check failed:', err);
    return false;
  }
}
import { recordKeyChange } from './keys';
import { ensurePresenceUserRow, recordPresenceChange } from './presence';
import { fanoutEventToAppServices } from '../services/appservice-fanout';
import { deliverInboundToDevice } from './to-device';
import { buildWireJoinState, deriveRoomWireEvents, wireForRoom } from '../services/event-wire';
import { checkAuthRules, verifyPdu, type VerifyKey } from '../services/federation-verify';
import { resolveState } from '../services/state-resolution';

// Supported room versions (v1-v12 per Matrix Spec v1.17) plus MSC4583's
// unstable room version.
const SUPPORTED_ROOM_VERSIONS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', MSC4583_ROOM_VERSION,
];

// "Modern" room versions for the purpose of content-hash enforcement.
// Matrix room versions 3 and later require event integrity via hashes.sha256;
// versions 1 and 2 are legacy where hashes are optional.
// Issue 006.6 — see docs/issues/006-federation-event-validation-state-resolution.md
/** Exported for unit tests. */
export function isModernRoomVersion(version: string): boolean {
  // Numeric room versions: anything >= 3 counts as modern. Non-numeric custom
  // versions are treated as modern by default (fail-closed).
  const n = parseInt(version, 10);
  if (Number.isFinite(n)) return n >= 3;
  return true;
}

/**
 * Get the request body from either the federation auth middleware buffer
 * (which already consumed it for signature verification) or from c.req.json()
 * as a fallback for endpoints not behind federation auth.
 */
async function getFederationBody<T = any>(c: any): Promise<T> {
  // The federation auth middleware stores the parsed body on the context
  const buffered = c.get('federationBody');
  if (buffered !== undefined) {
    return buffered as T;
  }
  // Fallback: body wasn't consumed by middleware (e.g., unauthenticated endpoint)
  return await c.req.json() as T;
}

const app = new Hono<AppEnv>();

// Resolve a remote server's signing keys through the same KV/D1/network key
// chain the rest of federation uses (verifyRemoteSignature -> fetchRemoteServerKeys).
// verifyPdu needs the raw verify keys so it can enforce that the PDU was
// signed by the sender's own server, not merely by *some* signatory.
async function resolvePduVerifyKeys(env: Env, serverName: string): Promise<VerifyKey[]> {
  try {
    const keys = await fetchRemoteServerKeys(serverName, env.DB, env.CACHE);
    return keys.map((key) => ({ keyId: key.key_id, publicKey: key.public_key }));
  } catch (err) {
    console.warn(`[federation] Cannot resolve signing keys for ${serverName}:`, err);
    return [];
  }
}

// GET /_matrix/federation/v1/version - Server version info (unauthenticated)
// This must be defined BEFORE the auth middleware is applied
app.get('/_matrix/federation/v1/version', async (c) => {
  return c.json({
    server: {
      name: 'matrix-worker',
      version: c.env.SERVER_VERSION || '0.1.0',
    },
  });
});

// Apply federation authentication to all other federation v1 endpoints
// Key endpoints (/_matrix/key/*) remain unauthenticated as they are used to establish trust
// Version endpoint is also unauthenticated as it's used for initial contact
app.use('/_matrix/federation/v1/*', requireFederationAuth());

// The v2 endpoints (send_join / send_leave / invite) take the same signed
// X-Matrix requests. Without this the request bodies were trusted verbatim,
// so anyone could inject joins, leaves or invites into a room.
app.use('/_matrix/federation/v2/*', requireFederationAuth());

// MSC4284 (spec v1.18): the policy server signing endpoint lives under its
// own federation-authenticated prefix.
app.use('/_matrix/policy/v1/*', requireFederationAuth());

// Matrix publishes Ed25519 verify keys as standard (non-URL-safe) unpadded
// base64. Keys generated here are stored URL-safe, so normalize on publish --
// strict decoders like Synapse's treat '_'/'-' as invalid alphabet and fail
// authentication for every signed request from us.
function toStandardBase64Key(value: string): string {
  return value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
}

// GET /_matrix/key/v2/server - Get server signing keys
app.get('/_matrix/key/v2/server', async (c) => {
  const serverName = c.env.SERVER_NAME;

  // Get or create server signing keys (prefer v2 keys with proper Ed25519)
  let keys = await c.env.DB.prepare(
    `SELECT key_id, public_key, private_key_jwk, key_version, valid_from, valid_until
     FROM server_keys WHERE is_current = 1 ORDER BY key_version DESC`
  ).all<{
    key_id: string;
    public_key: string;
    private_key_jwk: string | null;
    key_version: number | null;
    valid_from: number;
    valid_until: number | null;
  }>();

  // Check if we need to generate a new secure key
  const hasSecureKey = keys.results.some((k) => k.key_version === 2 && k.private_key_jwk);

  if (keys.results.length === 0 || !hasSecureKey) {
    // Generate new secure signing key with proper Ed25519
    const keyPair = await generateSigningKeyPair();
    const validFrom = Date.now();
    const validUntil = validFrom + 365 * 24 * 60 * 60 * 1000; // 1 year

    // Mark old keys as not current
    await c.env.DB.prepare(`UPDATE server_keys SET is_current = 0`).run();

    // Insert new secure key
    await c.env.DB.prepare(
      `INSERT INTO server_keys (key_id, public_key, private_key, private_key_jwk, key_version, valid_from, valid_until, is_current)
       VALUES (?, ?, ?, ?, 2, ?, ?, 1)`
    )
      .bind(
        keyPair.keyId,
        keyPair.publicKey,
        JSON.stringify(keyPair.privateKeyJwk), // Store JWK as string in legacy column too
        JSON.stringify(keyPair.privateKeyJwk),
        validFrom,
        validUntil
      )
      .run();

    keys = {
      results: [
        {
          key_id: keyPair.keyId,
          public_key: keyPair.publicKey,
          private_key_jwk: JSON.stringify(keyPair.privateKeyJwk),
          key_version: 2,
          valid_from: validFrom,
          valid_until: validUntil,
        },
      ],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  // Publish only keys we can actually sign with. Legacy v1 placeholder rows and
  // duplicates from a concurrent first-request generation can linger as
  // is_current = 1; advertising them without a matching signature fails strict
  // consumers like the Matrix Federation Tester (AllEd25519ChecksOK).
  const signableKeys = keys.results.filter((k) => k.key_version === 2 && k.private_key_jwk);

  const verifyKeys: Record<string, { key: string }> = {};
  for (const key of signableKeys) {
    verifyKeys[key.key_id] = { key: toStandardBase64Key(key.public_key) };
  }

  const validUntilTs = keys.results[0]?.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000;

  const response = {
    server_name: serverName,
    valid_until_ts: validUntilTs,
    verify_keys: verifyKeys,
    old_verify_keys: {},
  };

  // Sign with every published key: signJson merges signatures, so each
  // verify_key above gets a matching entry under `signatures`.
  let signed: Record<string, unknown> = response;
  for (const key of signableKeys) {
    if (!key.private_key_jwk) continue;
    signed = await signJson(signed, serverName, key.key_id, JSON.parse(key.private_key_jwk));
  }

  return c.json(signed);
});

// GET /_matrix/key/v2/server/:keyId - Get specific key
app.get('/_matrix/key/v2/server/:keyId', async (c) => {
  const keyId = c.req.param('keyId');
  const serverName = c.env.SERVER_NAME;

  const key = await c.env.DB.prepare(
    `SELECT key_id, public_key, private_key_jwk, key_version, valid_from, valid_until FROM server_keys WHERE key_id = ?`
  ).bind(keyId).first<{
    key_id: string;
    public_key: string;
    private_key_jwk: string | null;
    key_version: number | null;
    valid_from: number;
    valid_until: number | null;
  }>();

  if (!key) {
    return Errors.notFound('Key not found').toResponse();
  }

  const response = {
    server_name: serverName,
    valid_until_ts: key.valid_until || (Date.now() + 365 * 24 * 60 * 60 * 1000),
    verify_keys: {
      [key.key_id]: { key: toStandardBase64Key(key.public_key) },
    },
    old_verify_keys: {},
  };

  // Conduwuit-family servers fetch THIS parameterized form when they hold a
  // specific key id from an Authorization header, and strictly require the
  // key response to be self-signed — an unsigned body reads as "unable to
  // acquire the signing key" and 401s every federation call. Synapse uses
  // the unparameterized form, which is why only these servers failed.
  if (key.key_version === 2 && key.private_key_jwk) {
    const signed = await signJson(
      response,
      serverName,
      key.key_id,
      JSON.parse(key.private_key_jwk)
    );
    return c.json(signed);
  }

  // Legacy v1 placeholder rows cannot be signed; serve them as before.
  return c.json(response);
});

// Helper function to get our server's notary signing key
async function getNotarySigningKey(db: D1Database): Promise<{
  keyId: string;
  privateKeyJwk: JsonWebKey;
} | null> {
  const key = await db.prepare(
    `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`
  ).first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return null;
  }

  return {
    keyId: key.key_id,
    privateKeyJwk: JSON.parse(key.private_key_jwk),
  };
}

// Helper function to validate server name
/** Exported for unit tests. */
export function isValidServerName(serverName: string): boolean {
  // Basic server name validation
  // Server names should be hostname:port or just hostname
  // Must not contain SSRF-vulnerable patterns

  // Check for empty or too long
  if (!serverName || serverName.length > 255) {
    return false;
  }

  // Check using URL validation (construct a fake URL to validate the hostname)
  const testUrl = `https://${serverName}/`;
  const validation = validateUrl(testUrl);

  return validation.valid;
}

// Maximum number of servers in a batch query
const MAX_BATCH_SERVERS = 100;

// POST /_matrix/key/v2/query - Batch query for server keys (notary endpoint)
app.post('/_matrix/key/v2/query', async (c) => {
  let body: {
    server_keys?: Record<string, Record<string, { minimum_valid_until_ts?: number }>>;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const serverKeys = body.server_keys;
  if (!serverKeys || typeof serverKeys !== 'object') {
    return Errors.missingParam('server_keys').toResponse();
  }

  // Check batch size limit
  const serverCount = Object.keys(serverKeys).length;
  if (serverCount > MAX_BATCH_SERVERS) {
    return c.json(
      {
        errcode: 'M_LIMIT_EXCEEDED',
        error: `Too many servers in batch request (max ${MAX_BATCH_SERVERS})`,
      },
      400
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        error: 'Server signing key not configured',
      },
      500
    );
  }

  const results: ServerKeyResponse[] = [];

  // Process each server in the request
  for (const [serverName, keyRequests] of Object.entries(serverKeys)) {
    // Validate server name to prevent SSRF
    if (!isValidServerName(serverName)) {
      console.warn(`Invalid server name in key query: ${serverName}`);
      continue;
    }

    // If querying our own server, return our keys directly
    if (serverName === c.env.SERVER_NAME) {
      const ownKeys = await c.env.DB.prepare(
        `SELECT key_id, public_key, valid_until FROM server_keys WHERE is_current = 1`
      ).all<{ key_id: string; public_key: string; valid_until: number | null }>();

      if (ownKeys.results.length > 0) {
        const verifyKeys: Record<string, { key: string }> = {};
        let maxValidUntil = 0;

        for (const key of ownKeys.results) {
          verifyKeys[key.key_id] = { key: toStandardBase64Key(key.public_key) };
          if (key.valid_until && key.valid_until > maxValidUntil) {
            maxValidUntil = key.valid_until;
          }
        }

        const ownResponse: ServerKeyResponse = {
          server_name: serverName,
          valid_until_ts: maxValidUntil || Date.now() + 365 * 24 * 60 * 60 * 1000,
          verify_keys: verifyKeys,
          old_verify_keys: {},
        };

        // Sign with our own key
        const signed = (await signJson(
          ownResponse,
          c.env.SERVER_NAME,
          notaryKey.keyId,
          notaryKey.privateKeyJwk
        )) as ServerKeyResponse;

        results.push(signed);
      }
      continue;
    }

    // Process each key request for this server
    for (const [keyId, keyRequest] of Object.entries(keyRequests)) {
      const minimumValidUntilTs = keyRequest.minimum_valid_until_ts || 0;

      // Fetch keys with notary signature
      const keyResponses = await getRemoteKeysWithNotarySignature(
        serverName,
        keyId === '' ? null : keyId, // Empty key ID means all keys
        minimumValidUntilTs,
        c.env.DB,
        c.env.CACHE,
        c.env.SERVER_NAME,
        notaryKey.keyId,
        notaryKey.privateKeyJwk
      );

      results.push(...keyResponses);
    }
  }

  return c.json({ server_keys: results });
});

// GET /_matrix/key/v2/query/:serverName - Query all keys for a server
app.get('/_matrix/key/v2/query/:serverName', async (c) => {
  const serverName = c.req.param('serverName');
  const minimumValidUntilTs = parseInt(c.req.query('minimum_valid_until_ts') || '0', 10);

  // Validate server name to prevent SSRF
  if (!isValidServerName(serverName)) {
    return c.json(
      {
        errcode: 'M_INVALID_PARAM',
        error: 'Invalid server name',
      },
      400
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        error: 'Server signing key not configured',
      },
      500
    );
  }

  // If querying our own server, return our keys directly
  if (serverName === c.env.SERVER_NAME) {
    const ownKeys = await c.env.DB.prepare(
      `SELECT key_id, public_key, valid_until FROM server_keys WHERE is_current = 1`
    ).all<{ key_id: string; public_key: string; valid_until: number | null }>();

    if (ownKeys.results.length === 0) {
      return Errors.notFound('No keys found').toResponse();
    }

    const verifyKeys: Record<string, { key: string }> = {};
    let maxValidUntil = 0;

    for (const key of ownKeys.results) {
      verifyKeys[key.key_id] = { key: toStandardBase64Key(key.public_key) };
      if (key.valid_until && key.valid_until > maxValidUntil) {
        maxValidUntil = key.valid_until;
      }
    }

    const ownResponse: ServerKeyResponse = {
      server_name: serverName,
      valid_until_ts: maxValidUntil || Date.now() + 365 * 24 * 60 * 60 * 1000,
      verify_keys: verifyKeys,
      old_verify_keys: {},
    };

    // Sign with our own key
    const signed = (await signJson(
      ownResponse,
      c.env.SERVER_NAME,
      notaryKey.keyId,
      notaryKey.privateKeyJwk
    )) as ServerKeyResponse;

    return c.json({ server_keys: [signed] });
  }

  // Fetch keys from remote server with notary signature
  const keyResponses = await getRemoteKeysWithNotarySignature(
    serverName,
    null, // All keys
    minimumValidUntilTs,
    c.env.DB,
    c.env.CACHE,
    c.env.SERVER_NAME,
    notaryKey.keyId,
    notaryKey.privateKeyJwk
  );

  if (keyResponses.length === 0) {
    return Errors.notFound('No keys found for server').toResponse();
  }

  return c.json({ server_keys: keyResponses });
});

// GET /_matrix/key/v2/query/:serverName/:keyId - Query specific key for a server
app.get('/_matrix/key/v2/query/:serverName/:keyId', async (c) => {
  const serverName = c.req.param('serverName');
  const keyId = c.req.param('keyId');
  const minimumValidUntilTs = parseInt(c.req.query('minimum_valid_until_ts') || '0', 10);

  // Validate server name to prevent SSRF
  if (!isValidServerName(serverName)) {
    return c.json(
      {
        errcode: 'M_INVALID_PARAM',
        error: 'Invalid server name',
      },
      400
    );
  }

  // Get our notary signing key
  const notaryKey = await getNotarySigningKey(c.env.DB);
  if (!notaryKey) {
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        error: 'Server signing key not configured',
      },
      500
    );
  }

  // If querying our own server, return the specific key
  if (serverName === c.env.SERVER_NAME) {
    const ownKey = await c.env.DB.prepare(
      `SELECT key_id, public_key, valid_until FROM server_keys WHERE key_id = ?`
    ).bind(keyId).first<{ key_id: string; public_key: string; valid_until: number | null }>();

    if (!ownKey) {
      return Errors.notFound('Key not found').toResponse();
    }

    const ownResponse: ServerKeyResponse = {
      server_name: serverName,
      valid_until_ts: ownKey.valid_until || Date.now() + 365 * 24 * 60 * 60 * 1000,
      verify_keys: {
        [ownKey.key_id]: { key: toStandardBase64Key(ownKey.public_key) },
      },
      old_verify_keys: {},
    };

    // Sign with our own key
    const signed = (await signJson(
      ownResponse,
      c.env.SERVER_NAME,
      notaryKey.keyId,
      notaryKey.privateKeyJwk
    )) as ServerKeyResponse;

    return c.json({ server_keys: [signed] });
  }

  // Fetch specific key from remote server with notary signature
  const keyResponses = await getRemoteKeysWithNotarySignature(
    serverName,
    keyId,
    minimumValidUntilTs,
    c.env.DB,
    c.env.CACHE,
    c.env.SERVER_NAME,
    notaryKey.keyId,
    notaryKey.privateKeyJwk
  );

  if (keyResponses.length === 0) {
    return Errors.notFound('Key not found').toResponse();
  }

  return c.json({ server_keys: keyResponses });
});

// Inbound ephemeral EDUs go straight to the Room DO — the same storage path
// local clients use. No outbound queueing here, so remote typing/read state
// can never bounce back to its sender as an echo.
async function inboundEduRoomExists(db: D1Database, roomId: string): Promise<boolean> {
  try {
    return (await getRoom(db, roomId)) !== null;
  } catch (err) {
    console.warn('[federation] EDU room lookup failed:', err);
    return false;
  }
}

async function deliverInboundTypingEdu(env: Env, content: unknown): Promise<void> {
  const edu = (content ?? {}) as Record<string, unknown>;
  const { room_id: roomId, user_id: userId, typing } = edu;
  if (typeof roomId !== 'string' || !roomId ||
      typeof userId !== 'string' || !userId ||
      typeof typing !== 'boolean') {
    console.warn('[federation] Ignoring malformed m.typing EDU');
    return;
  }
  if (!await inboundEduRoomExists(env.DB, roomId)) {
    console.warn('[federation] Ignoring m.typing EDU for unknown room', roomId);
    return;
  }

  const roomDO = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  await roomDO.fetch(new Request('https://room/typing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    // The DO applies its own default timeout.
    body: JSON.stringify({ user_id: userId, typing }),
  }));
}

// A server publishes cross-signing key changes for its OWN users with an
// m.signing_key_update EDU. Cache the keys in the same D1 table + KV shape the
// upload path uses, and mark a key change so clients re-query /keys/query.
// The sender is authenticated by transaction origin: never let one server
// overwrite another server's users' cross-signing keys.
async function storeInboundSigningKeyUpdate(
  env: Env,
  content: unknown,
  origin: string
): Promise<void> {
  const edu = (content ?? {}) as Record<string, unknown>;
  const userId = edu.user_id;
  if (typeof userId !== 'string' || !userId.includes(':')) {
    console.warn('[federation] Ignoring m.signing_key_update without user_id');
    return;
  }
  if (!userId.endsWith(`:${origin}`)) {
    console.warn(`[federation] Ignoring m.signing_key_update for foreign user ${userId} from ${origin}`);
    return;
  }

  const merged: Record<string, unknown> = {};
  const updates: Array<{ type: string; key: Record<string, unknown> }> = [];
  for (const [type, field] of [
    ['master', 'master_key'],
    ['self_signing', 'self_signing_key'],
    ['user_signing', 'user_signing_key'],
  ]) {
    const key = edu[field];
    if (key && typeof key === 'object' && !Array.isArray(key)) {
      updates.push({ type, key: key as Record<string, unknown> });
    }
  }

  for (const { type, key } of updates) {
    const keys = key.keys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) continue;
    const keyId = Object.keys(keys as Record<string, unknown>)[0];
    if (!keyId) continue;
    await env.DB.prepare(`
      INSERT INTO cross_signing_keys (user_id, key_type, key_id, key_data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, key_type) DO UPDATE SET
        key_id = excluded.key_id,
        key_data = excluded.key_data
    `).bind(userId, type, keyId, JSON.stringify(key)).run();
    merged[type] = key;
  }
  if (Object.keys(merged).length === 0) return;

  try {
    const raw = await env.CROSS_SIGNING_KEYS.get(`user:${userId}`);
    const existing = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    await env.CROSS_SIGNING_KEYS.put(`user:${userId}`, JSON.stringify({ ...existing, ...merged }));
  } catch (kvErr) {
    console.warn('[federation] Cross-signing EDU KV cache update failed:', kvErr);
  }

  try {
    // device_key_changes is what /sync uses for device_lists.changed; a
    // remote user's next /keys/query then refreshes the client's verification
    // state from the freshly cached cross-signing keys.
    await recordKeyChange(env.DB, userId, null, 'update');
  } catch (changeErr) {
    console.warn('[federation] Cross-signing EDU key-change record failed:', changeErr);
  }
}

// Spec v1.19 wire shape: room_id plus content keyed by event ID, receipt type,
// then user ID. Only m.read is a public ephemeral receipt: m.read.private is
// never accepted from a remote server, and m.fully_read is local account data.
async function deliverInboundReceiptEdu(env: Env, content: unknown): Promise<void> {
  const edu = (content ?? {}) as Record<string, unknown>;
  const roomId = edu.room_id;
  const byEventId = edu.content;
  if (typeof roomId !== 'string' || !roomId ||
      !byEventId || typeof byEventId !== 'object' || Array.isArray(byEventId)) {
    console.warn('[federation] Ignoring malformed m.receipt EDU');
    return;
  }
  if (!await inboundEduRoomExists(env.DB, roomId)) {
    console.warn('[federation] Ignoring m.receipt EDU for unknown room', roomId);
    return;
  }

  const roomDO = env.ROOMS.get(env.ROOMS.idFromName(roomId));
  for (const [eventId, byReceiptType] of Object.entries(byEventId as Record<string, unknown>)) {
    if (!eventId || !byReceiptType || typeof byReceiptType !== 'object' || Array.isArray(byReceiptType)) continue;
    for (const [receiptType, byUserId] of Object.entries(byReceiptType as Record<string, unknown>)) {
      if (receiptType !== 'm.read') continue;
      if (!byUserId || typeof byUserId !== 'object' || Array.isArray(byUserId)) continue;
      for (const [userId, data] of Object.entries(byUserId as Record<string, unknown>)) {
        if (!userId) continue;
        const threadId = (data as { thread_id?: unknown } | null)?.thread_id;
        const remoteTs = (data as { ts?: unknown } | null)?.ts;
        const receipt: {
          user_id: string;
          event_id: string;
          receipt_type: string;
          ts?: number;
          thread_id?: string;
        } = {
          user_id: userId,
          event_id: eventId,
          receipt_type: receiptType,
        };
        // Forward the resident's read time; the Room DO stamps Date.now()
        // only when ts is absent (local receipts still use their own clock).
        if (typeof remoteTs === 'number' && Number.isFinite(remoteTs)) receipt.ts = remoteTs;
        if (typeof threadId === 'string') receipt.thread_id = threadId;
        try {
          await roomDO.fetch(new Request('https://room/receipt', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(receipt),
          }));
        } catch (err) {
          // One bad receipt must not prevent the rest of the EDU being stored.
          console.warn('[federation] Failed to store inbound receipt:', err);
        }
      }
    }
  }
}

// PUT /_matrix/federation/v1/send/:txnId - Receive events from remote server
// This endpoint is now protected by requireFederationAuth middleware
app.put('/_matrix/federation/v1/send/:txnId', async (c) => {
  const txnId = c.req.param('txnId');

  // Origin is now authenticated via the federation auth middleware
  const origin = c.get('federationOrigin' as any) as string | undefined;
  if (!origin) {
    return Errors.unauthorized('Federation authentication required').toResponse();
  }

  // Check for duplicate transaction (idempotency)
  const existingTxn = await c.env.DB.prepare(
    `SELECT response FROM federation_transactions WHERE origin = ? AND txn_id = ?`
  ).bind(origin, txnId).first<{ response: string | null }>();

  if (existingTxn?.response) {
    // Return cached response for duplicate transaction
    return c.json(JSON.parse(existingTxn.response));
  }

  let body: any;
  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const { pdus, edus } = body;
  const pduResults: Record<string, any> = {};
  let transientStorageFailure = false;

  // Moderation policy lists (spec module): m.ban server rules deny the
  // sending server's PDUs with the same posture as ACL denial. Fetched
  // once per transaction; no subscriptions means no-op.
  const moderationRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);

  // Process incoming PDUs (Persistent Data Units - events)
  for (const pdu of pdus || []) {
    try {
      // The room must be known before deriving the event ID: room versions
      // 1-10 hash create/power_levels under different redaction rules than
      // v11+, so a version-blind derivation stores the event under a
      // phantom ID that neither the sender nor other residents use, and
      // every later reference to it fails to resolve.
      const roomId = pdu.room_id;
      const room = roomId
        ? await c.env.DB.prepare(
            `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
          ).bind(roomId).first<{ room_id: string; room_version: string }>()
        : null;
      // v4+ wire events (room versions 3 and up) omit `event_id`; the
      // receiving server derives it as the event's reference hash. Use the
      // resident's redaction form when the wire carries pre-2023 `origin` /
      // `prev_state`, and keep an ID we already stored under authoritative —
      // re-deriving a stored remote ID can produce a phantom no peer knows.
      const candidates = typeof pdu.event_id === 'string' && pdu.event_id
        ? [pdu.event_id as string]
        : await inboundWireEventIdCandidates(pdu as Record<string, unknown>, room?.room_version);
      let eventId = candidates[0];
      let existingPdu: { accepted: number; rejection_reason: string | null } | null = null;
      for (const candidate of candidates) {
        const found = await c.env.DB.prepare(
          `SELECT accepted, rejection_reason FROM processed_pdus WHERE event_id = ?`
        ).bind(candidate).first<{ accepted: number; rejection_reason: string | null }>();
        if (found) {
          eventId = candidate;
          existingPdu = found;
          break;
        }
      }
      if (!existingPdu && candidates.length > 1) {
        for (const candidate of candidates) {
          const stored = await c.env.DB.prepare(
            `SELECT 1 FROM events WHERE event_id = ?`
          ).bind(candidate).first();
          if (stored) {
            eventId = candidate;
            break;
          }
        }
      }

      if (existingPdu) {
        // Already processed
        if (existingPdu.accepted) {
          pduResults[eventId] = {};
        } else {
          pduResults[eventId] = {
            error: existingPdu.rejection_reason || 'Previously rejected',
          };
        }
        continue;
      }

      // Validate basic PDU structure
      if (!eventId || !roomId || !pdu.sender || !pdu.type || !pdu.content) {
        pduResults[eventId || 'unknown'] = {
          error: 'Invalid PDU structure',
        };
        continue;
      }

      // Get the origin server from the sender
      const pduOrigin = (pdu.sender as string).split(':')[1];
      if (!pduOrigin) {
        pduResults[eventId] = { error: 'Invalid sender format' };
        continue;
      }

      // Content hash enforcement.
      //   - Room versions 1-2: hashes optional (legacy clients may omit).
      //   - Room versions 3+: hashes.sha256 is REQUIRED — modern room versions
      //     mandate content integrity. An attacker can otherwise omit `hashes`
      //     entirely to skip integrity verification.
      // If the room is unknown locally, default to the strict (modern) rule —
      // we won't accept unverifiable events for rooms we know nothing about.
      // (`room` was resolved at the top of the loop so the event ID could be
      // derived with the room version's redaction rules.)
      const roomVersion = room?.room_version;
      const requiresHash = !roomVersion || isModernRoomVersion(roomVersion);
      const hasSha256 = typeof pdu.hashes?.sha256 === 'string' && pdu.hashes.sha256.length > 0;

      if (requiresHash && !hasSha256) {
        const reason = `Missing required hashes.sha256 (room_version=${roomVersion ?? 'unknown'})`;
        pduResults[eventId] = { error: reason };
        await c.env.DB.prepare(
          `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
           VALUES (?, ?, ?, ?, 0, ?)`
        ).bind(eventId, pduOrigin, roomId, Date.now(), reason).run();
        continue;
      }

      if (!hasSha256 && roomVersion) {
        // Room versions 1-2: legacy, hashes optional but log so we notice.
        console.warn(
          `[federation] PDU ${eventId} from ${pduOrigin} in legacy room_version=${roomVersion} ` +
          `has no content hash`
        );
      }

      // Verify content hash if present (always — even for legacy room versions
      // when the sender did supply one).
      if (hasSha256) {
        try {
          const hashValid = await verifyContentHash(pdu as Record<string, unknown>, pdu.hashes.sha256);
          if (!hashValid) {
            pduResults[eventId] = { error: 'Content hash mismatch' };
            await c.env.DB.prepare(
              `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
               VALUES (?, ?, ?, ?, 0, ?)`
            ).bind(eventId, pduOrigin, roomId, Date.now(), 'Content hash mismatch').run();
            continue;
          }
        } catch (hashErr) {
          console.warn(`[federation] Content hash check failed for ${eventId}:`, hashErr);
          // For modern room versions, refuse to accept an event whose hash we
          // could not verify — silent fall-through here would defeat the
          // requirement above.
          if (requiresHash) {
            const reason = 'Content hash verification error';
            pduResults[eventId] = { error: reason };
            await c.env.DB.prepare(
              `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
               VALUES (?, ?, ?, ?, 0, ?)`
            ).bind(eventId, pduOrigin, roomId, Date.now(), reason).run();
            continue;
          }
        }
      }

      // Signature enforcement: every inbound PDU must carry a valid signature
      // from the sender's OWN server. Accepting any signatory lets a relay
      // forge events for users it does not host; accepting none lets anyone
      // inject arbitrary events.
      //
      // Redaction rules come from the ROOM VERSION, not from the presence of
      // an explicit event_id: real Synapse PDUs in modern rooms carry
      // event_id and are signed over the room version's redacted shape, so
      // forcing v1-2 rules rejects legitimate peers. Unknown rooms default
      // to a modern version.
      //
      // Keep `hashes` in the verification view: the signature covers the
      // redacted event INCLUDING hashes (it is a retained top-level field).
      // Stripping it here made every real Synapse signature fail while
      // self-signed fixtures that also stripped it stayed green.
      const verificationVersion = room?.room_version ?? '10';
      const verificationView = pdu as Record<string, unknown>;
      const verifyKeys = await resolvePduVerifyKeys(c.env, pduOrigin);
      const verification = await verifyPdu(
        verificationView as unknown as PDU,
        pduOrigin,
        verificationVersion,
        verifyKeys,
        // The /send handler already enforced hashes.sha256 above; don't
        // duplicate that check here (it would compare against a different
        // wire view for legacy/soft-accepted fixtures).
        true
      );
      if ('error' in verification) {
        const reason = `PDU from origin server ${pduOrigin} without valid signature: ${verification.error}`;
        pduResults[eventId] = { error: reason };
        await c.env.DB.prepare(
          `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
           VALUES (?, ?, ?, ?, 0, ?)`
        ).bind(eventId, pduOrigin, roomId, Date.now(), reason).run();
        continue;
      }

      // Synapse-style auth_events selection check (dev instances only):
      // rejects events whose auth_events omit types the auth rules select,
      // which is what makes resident servers outlier our memberships.
      if (c.env.FEDERATION_STRICT_AUTH === 'true' && room) {
        const allRows = await c.env.DB.prepare(
          `SELECT event_id, room_id, sender, event_type, state_key, content,
           origin_server_ts, depth, auth_events, prev_events, hashes, signatures
           FROM events WHERE room_id = ?`
        ).bind(roomId).all<any>();
        const byId = new Map<string, PDU>();
        for (const r of allRows.results ?? []) {
          byId.set(r.event_id, {
            event_id: r.event_id, room_id: r.room_id, sender: r.sender, type: r.event_type,
            state_key: r.state_key ?? undefined, content: JSON.parse(r.content),
            origin_server_ts: r.origin_server_ts, depth: r.depth,
            auth_events: JSON.parse(r.auth_events), prev_events: JSON.parse(r.prev_events),
            hashes: r.hashes ? JSON.parse(r.hashes) : undefined,
            signatures: r.signatures ? JSON.parse(r.signatures) : undefined,
          } as PDU);
        }
        const stateMap = new Map<string, PDU>();
        for (const e of await getRoomState(c.env.DB, roomId)) {
          stateMap.set(`${e.type}\0${e.state_key ?? ''}`, e);
        }
        const strictReason = checkAuthRules(pdu as PDU, room.room_version, { byId, state: stateMap });
        if (strictReason) {
          pduResults[eventId] = { error: strictReason };
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
             VALUES (?, ?, ?, ?, 0, ?)`
          ).bind(eventId, pduOrigin, roomId, Date.now(), strictReason).run();
          continue;
        }
      }

      // MSC4284 soft-fail flag: events lacking a valid policy server
      // countersignature are stored (DAG integrity) but never delivered
      // to clients.
      let policySoftFail = false;

      // Run event authorization check if we have room state
      if (room) {
        try {
          const roomState = await getRoomState(c.env.DB, roomId);

          // Server ACL (spec module; MSC4436 case-insensitive): deny
          // non-compliant servers' events outright. The ACL acts at the
          // network layer, before the DAG auth rules — a banned server gets
          // no participation at all, including ACL edits of its own.
          const acl = findServerAcl(roomState);
          if (acl && typeof (pdu as { sender?: unknown }).sender === 'string') {
            const senderServer = serverNameFromId((pdu as { sender: string }).sender);
            if (!isServerAllowedByAcl(acl, senderServer)) {
              const reason = `Server ${senderServer} is denied by the room's server ACL`;
              pduResults[eventId] = { error: reason };
              await c.env.DB.prepare(
                `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
                 VALUES (?, ?, ?, ?, 0, ?)`
              ).bind(eventId, pduOrigin, roomId, Date.now(), reason).run();
              continue;
            }
          }

          // Moderation policy lists (spec module): m.ban server rules deny
          // the sending server's traffic with ACL posture.
          if (moderationRules.subscriptions > 0 && typeof (pdu as { sender?: unknown }).sender === 'string') {
            const modBan = isServerBannedByPolicy(
              moderationRules,
              serverNameFromId((pdu as { sender: string }).sender)
            );
            if (modBan) {
              const modReason = `Server is banned by a moderation policy list (${modBan.reason || modBan.entity})`;
              pduResults[eventId] = { error: modReason };
              await c.env.DB.prepare(
                `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
                 VALUES (?, ?, ?, ?, 0, ?)`
              ).bind(eventId, pduOrigin, roomId, Date.now(), modReason).run();
              continue;
            }
          }

          const authResult = checkEventAuth(pdu as PDU, roomState, room.room_version);
          if (!authResult.allowed) {
            pduResults[eventId] = { error: authResult.error || 'Event authorization failed' };
            await c.env.DB.prepare(
              `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
               VALUES (?, ?, ?, ?, 0, ?)`
            ).bind(eventId, pduOrigin, roomId, Date.now(), authResult.error || 'Auth failed').run();
            continue;
          }

          // MSC4284 (spec v1.18, PDU check #7): when the room uses a
          // policy server, every event except m.room.policy itself must
          // carry a valid PS countersignature. Missing/invalid ones are
          // re-requested from the PS (keys can rotate between send and
          // receipt); events that still fail are soft-failed — stored,
          // never shown to clients.
          const policy = await getRoomPolicyServer(c.env.DB, roomId, roomState);
          if (policy && !eventExemptFromPolicy(pdu as unknown as { type?: unknown; state_key?: unknown })) {
            const pduRecord = pdu as unknown as Record<string, unknown>;
            let policyOk = await verifyPolicySignature(
              pduRecord, policy.via, policy.ed25519, room.room_version
            );
            if (!policyOk) {
              const asked = await askPolicyServerSignature(
                c.env, policy, { ...pduRecord, event_id: eventId }
              );
              if ('signature' in asked) {
                const candidate = { ...(pduRecord.signatures as Record<string, unknown> | undefined ?? {}) };
                attachPolicySignature(candidate, policy.via, asked.signature);
                if (
                  await verifyPolicySignature(
                    { ...pduRecord, signatures: candidate },
                    policy.via, policy.ed25519, room.room_version
                  )
                ) {
                  // Redeemed: persist the fresh countersignature so
                  // backfill/outbound serves carry it too.
                  (pdu as unknown as Record<string, unknown>).signatures = candidate;
                  policyOk = true;
                }
              }
            }
            if (!policyOk) {
              policySoftFail = true;
              console.warn(
                '[federation] soft-failing event without valid policy server signature',
                { eventId, roomId, policyServer: policy.via }
              );
            }
          }
        } catch (authErr) {
          console.warn(`[federation] Auth check failed for ${eventId}, accepting anyway:`, authErr);
        }
      }

      // Accept the PDU only AFTER it is actually stored (see end of this
      // block). Marking processed_pdus first made a D1 failure during storage
      // permanent: the peer's retry was skipped as "already processed".
      // If room exists, store the event
      if (room) {
        try {
          // Replay guard: Conduwuit-family servers replay historical events
          // to newly joined servers through ordinary transactions. A
          // membership event arriving out of chronology (older than
          // everything we already hold) is stored outside the live timeline
          // (negated stream ordering) so a replay burst cannot bury fresh
          // conversation under hundreds of old joins. room_state and
          // room_memberships still update; only timeline visibility changes.
          let replayedOldMember = false;
          if (pdu.type === 'm.room.member') {
            const newest = await c.env.DB.prepare(
              `SELECT origin_server_ts FROM events WHERE room_id = ? AND stream_ordering > 0 ORDER BY stream_ordering DESC LIMIT 1`
            ).bind(roomId).first<{ origin_server_ts: number }>();
            if (newest && pdu.origin_server_ts < newest.origin_server_ts) {
              replayedOldMember = true;
            }
          }
          // Allocate a stream position first: /sync delivers events by
          // stream_ordering, and a NULL ordering makes an event invisible to
          // every client even though it is stored.
          const positionResult = await c.env.DB.prepare(
            `UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'events' RETURNING position`
          ).first<{ position: number }>();
          const streamOrdering = replayedOldMember
            ? -(positionResult?.position ?? 1)
            : positionResult?.position ?? 1;

          const insertResult = await c.env.DB.prepare(
            `INSERT OR IGNORE INTO events
             (event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth, auth_events, prev_events, hashes, signatures, stream_ordering)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            eventId,
            roomId,
            pdu.sender,
            pdu.type,
            pdu.state_key ?? null,
            JSON.stringify(pdu.content),
            pdu.origin_server_ts,
            pdu.depth || 0,
            JSON.stringify(pdu.auth_events || []),
            JSON.stringify(pdu.prev_events || []),
            pdu.hashes ? JSON.stringify(pdu.hashes) : null,
            pdu.signatures ? JSON.stringify(pdu.signatures) : null,
            streamOrdering
          ).run();

          // Update room state
          if (pdu.state_key !== undefined) {
            // If the PDU has multiple prev_events, we may need state resolution
            const prevEvents = pdu.prev_events || [];
            if (prevEvents.length > 1 && room) {
              try {
                // Fetch current room state and resolve with new event
                const currentState = await getRoomState(c.env.DB, roomId);
                const newEvent: PDU = {
                  event_id: eventId,
                  room_id: roomId,
                  sender: pdu.sender,
                  type: pdu.type,
                  state_key: pdu.state_key,
                  content: pdu.content,
                  origin_server_ts: pdu.origin_server_ts,
                  depth: pdu.depth || 0,
                  auth_events: pdu.auth_events || [],
                  prev_events: prevEvents,
                };
                const resolved = resolveState(room.room_version, [currentState, [newEvent]]);
                // Apply resolved state
                for (const stateEvent of resolved) {
                  if (stateEvent.state_key !== undefined) {
                    await c.env.DB.prepare(
                      `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
                       VALUES (?, ?, ?, ?)`
                    ).bind(roomId, stateEvent.type, stateEvent.state_key, stateEvent.event_id).run();
                  }
                }
              } catch (resolveErr) {
                console.warn(`[federation] State resolution failed for ${eventId}, falling back:`, resolveErr);
                await c.env.DB.prepare(
                  `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
                   VALUES (?, ?, ?, ?)`
                ).bind(roomId, pdu.type, pdu.state_key, eventId).run();
              }
            } else {
              await c.env.DB.prepare(
                `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
                 VALUES (?, ?, ?, ?)`
              ).bind(roomId, pdu.type, pdu.state_key, eventId).run();
            }
          }
        // Track membership changes from incoming member events so the
          // memberships table stays in sync with remote state (federation
          // fan-out picks destinations from this table).
          if (pdu.type === 'm.room.member' && typeof pdu.state_key === 'string') {
            const membership = (pdu.content as { membership?: string } | null)?.membership;
            if (
              membership === 'join' ||
              membership === 'invite' ||
              membership === 'leave' ||
              membership === 'ban' ||
              membership === 'knock'
            ) {
              await updateMembership(c.env.DB, roomId, pdu.state_key, membership, eventId);

              // MSC4267 (m.forget_forced_upon_leave): a FRESH leave/ban for a
              // local user forgets the room locally. Replayed historical
              // member events and duplicate redeliveries are skipped so an
              // old leave can never erase a newer membership row.
              if (
                (membership === 'leave' || membership === 'ban') &&
                !replayedOldMember &&
                (insertResult.meta?.changes ?? 0) > 0
              ) {
                const targetDomain = pdu.state_key.includes(':')
                  ? pdu.state_key.slice(pdu.state_key.indexOf(':') + 1)
                  : '';
                if (targetDomain && targetDomain === c.env.SERVER_NAME) {
                  await c.env.DB.prepare(
                    `DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?`
                  ).bind(roomId, pdu.state_key).run();
                }
              }
            }
          }

          // Inbound redactions prune the target's client view, mirroring the
          // local redaction pipeline (events.redacted_content +
          // unsigned.redacted_because). Versions with the updated redaction
          // rules (v11+) carry the target in content.redacts; older
          // versions use the top-level `redacts` field.
          if (pdu.type === 'm.room.redaction') {
            const behavior = getRoomVersion(room.room_version);
            const targetId = behavior?.updatedRedactionRules
              ? ((pdu.content as { redacts?: unknown } | null)?.redacts)
              : (pdu as { redacts?: unknown }).redacts;
            if (typeof targetId === 'string' && targetId) {
              try {
                await applyEventRedaction(
                  c.env.DB,
                  roomId,
                  room.room_version,
                  {
                    eventId,
                    sender: pdu.sender as string,
                    originServerTs: pdu.origin_server_ts,
                    content: (pdu.content ?? {}) as Record<string, unknown>,
                  },
                  targetId
                );
              } catch (redactionErr) {
                console.warn('[federation] inbound redaction prune failed:', redactionErr);
              }
            }
          }

          // Wake local members' sync loops so the new event is delivered
          // promptly instead of waiting out a long-poll timeout. Policy
          // soft-failed events stay invisible to clients by design.
          if ((insertResult.meta?.changes ?? 0) > 0 && !policySoftFail) {
            const localMembers = await c.env.DB.prepare(
              `SELECT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join' AND user_id LIKE ?`
            ).bind(roomId, `%:${c.env.SERVER_NAME}`).all<{ user_id: string }>();
            for (const member of localMembers.results ?? []) {
              await notifyUserSync(c.env, member.user_id, 'events');
            }
            await fanoutEventToAppServices(c.env, { ...pdu, event_id: eventId } as PDU);

            // Bridges (e.g. Telegram) relay accepted federated messages out
            // of the room. Best-effort; never fails the transaction.
            if (pdu.type === 'm.room.message') {
              try {
                const { handleRoomMessage } = await import('../services/room-integrations');
                await handleRoomMessage(c.env, roomId, pdu.sender as string, pdu.content as Record<string, unknown>, 'federated');
              } catch (err) {
                console.warn('[federation] integrations hook failed:', err);
              }
            }
          }

          // Storage completed: only now is it safe to mark the PDU processed.
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
             VALUES (?, ?, ?, ?, 1, NULL)`
          ).bind(eventId, pduOrigin, roomId, Date.now()).run();
          pduResults[eventId] = {};
        } catch (e) {
          console.error(`Failed to store event ${eventId}:`, e);
          pduResults[eventId] = {
            error: e instanceof Error ? e.message : 'Transient storage failure',
          };
          transientStorageFailure = true;
        }
      } else {
        // Unknown room: nothing to store, but acknowledge so peers stop
        // retrying a PDU we can never place locally.
        await c.env.DB.prepare(
          `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
           VALUES (?, ?, ?, ?, 1, NULL)`
        ).bind(eventId, pduOrigin, roomId, Date.now()).run();
        pduResults[eventId] = {};
      }
    } catch (e: any) {
      const eventId = pdu?.event_id || 'unknown';
      pduResults[eventId] = {
        error: e.message || 'Unknown error',
      };

      // Record rejection
      if (pdu?.event_id && pdu?.room_id) {
        const pduOrigin = (pdu.sender as string)?.split(':')[1] || origin;
        await c.env.DB.prepare(
          `INSERT OR REPLACE INTO processed_pdus (event_id, origin, room_id, processed_at, accepted, rejection_reason)
           VALUES (?, ?, ?, ?, 0, ?)`
        ).bind(pdu.event_id, pduOrigin, pdu.room_id, Date.now(), e.message || 'Unknown error').run();
      }
    }
  }

  // Process EDUs (Ephemeral Data Units)
  for (const edu of edus || []) {
    try {
      const eduType = edu.edu_type;
      const content = edu.content;

      switch (eduType) {
        case 'm.typing':
          try {
            await deliverInboundTypingEdu(c.env, content);
          } catch (typingErr) {
            console.warn('[federation] Failed to deliver inbound m.typing EDU:', typingErr);
          }
          break;

        case 'm.presence': {
          // Process inbound presence EDUs from federated servers
          const presencePush = content?.push as Array<{
            user_id: string;
            presence: string;
            status_msg?: string;
            last_active_ago?: number;
            currently_active?: boolean;
          }> | undefined;
          if (presencePush) {
            for (const update of presencePush) {
              if (update.user_id && update.presence) {
                const now = Date.now();
                const lastActive = update.last_active_ago
                  ? now - update.last_active_ago
                  : now;
                try {
                  // Remote senders have no local users row, but presence has a
                  // FK to users. Seed a placeholder first or the upsert fails
                  // and presence is silently lost (the /send still returns 200).
                  await ensurePresenceUserRow(c.env.DB, update.user_id);

                  // Stamp the row with a new presence stream position in the
                  // same D1 batch/transaction, so local /sync clients see this
                  // EDU exactly once. recordPresenceChange degrades to the
                  // legacy write if the stream is unavailable; any error stays
                  // contained here and never rejects the federation transaction.
                  await recordPresenceChange(c.env.DB, {
                    userId: update.user_id,
                    presence: update.presence,
                    statusMsg: update.status_msg || null,
                    lastActiveTs: lastActive,
                    currentlyActive: Boolean(update.currently_active),
                  });
                } catch (presErr) {
                  console.warn(`[federation] Failed to update presence for ${update.user_id}:`, presErr);
                }
              }
            }
          }
          break;
        }

        case 'm.device_list_update': {
          // Process inbound device list update EDUs from federated servers
          const deviceUserId = content?.user_id as string;
          const deviceId = content?.device_id as string;
          const streamId = (content?.stream_id as number) || 0;
          const deviceKeys = content?.keys;
          const deviceDisplayName = content?.device_display_name as string | undefined;
          const deleted = content?.deleted as boolean;

          if (deviceUserId && deviceId) {
            try {
              if (deleted) {
                await c.env.DB.prepare(
                  `DELETE FROM remote_device_lists WHERE user_id = ? AND device_id = ?`
                ).bind(deviceUserId, deviceId).run();
              } else {
                await c.env.DB.prepare(`
                  INSERT INTO remote_device_lists (user_id, device_id, device_display_name, keys, stream_id, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (user_id, device_id) DO UPDATE SET
                    device_display_name = excluded.device_display_name,
                    keys = excluded.keys,
                    stream_id = excluded.stream_id,
                    updated_at = excluded.updated_at
                `).bind(
                  deviceUserId,
                  deviceId,
                  deviceDisplayName || null,
                  deviceKeys ? JSON.stringify(deviceKeys) : null,
                  streamId,
                  Date.now()
                ).run();
              }

              // Update stream tracking
              await c.env.DB.prepare(`
                INSERT INTO remote_device_list_streams (user_id, stream_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO UPDATE SET
                  stream_id = MAX(remote_device_list_streams.stream_id, excluded.stream_id),
                  updated_at = excluded.updated_at
              `).bind(deviceUserId, streamId, Date.now()).run();

              // /sync derives device_lists.changed from device_key_changes.
              // Without a row here, clients never refresh a federated
              // user's device keys even though our remote cache updated.
              await recordKeyChange(
                c.env.DB,
                deviceUserId,
                deviceId,
                deleted ? 'delete' : 'update'
              );
            } catch (devErr) {
              console.warn(`[federation] Failed to update device list for ${deviceUserId}:`, devErr);
            }
          }
          break;
        }

        case 'm.receipt':
          try {
            await deliverInboundReceiptEdu(c.env, content);
          } catch (receiptErr) {
            console.warn('[federation] Failed to deliver inbound m.receipt EDU:', receiptErr);
          }
          break;

        case 'm.direct_to_device':
          // Deliver federated to-device messages (Olm/Megolm key exchange,
          // encrypted payloads) to the target users' local devices.
          {
            const delivered = await deliverInboundToDevice(c.env, content);
            if (delivered > 0) {
              console.log('[federation] Delivered', delivered, 'to-device messages from EDU');
            }
          }
          break;

        case 'm.signing_key_update':
          try {
            await storeInboundSigningKeyUpdate(c.env, content, origin);
          } catch (keyErr) {
            console.warn('[federation] Failed to store inbound signing key update:', keyErr);
          }
          break;

        default:
          // Unknown EDU type - log and continue
          console.log(`Received unknown EDU type: ${eduType}`);
      }

      // Store EDU for record keeping
      const eduId = await sha256(`${origin}:${eduType}:${Date.now()}:${Math.random()}`);
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO processed_edus (edu_id, edu_type, origin, processed_at, content)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(eduId, eduType, origin, Date.now(), JSON.stringify(content)).run();
    } catch (e) {
      console.error(`Failed to process EDU:`, e);
    }
  }

  if (transientStorageFailure) {
    // Do not cache this transaction: peers must retry it after D1 recovers.
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'Temporary storage failure; retry this transaction' },
      503
    );
  }

  const response = { pdus: pduResults };

  // Store transaction for idempotency
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO federation_transactions (txn_id, origin, received_at, response)
     VALUES (?, ?, ?, ?)`
  ).bind(txnId, origin, Date.now(), JSON.stringify(response)).run();

  return c.json(response);
});

// GET /_matrix/federation/v1/event/:eventId - Get a single event
app.get('/_matrix/federation/v1/event/:eventId', async (c) => {
  const eventId = c.req.param('eventId');

  let event = await c.env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, depth, auth_events, prev_events, hashes, signatures
     FROM events WHERE event_id = ?`
  ).bind(eventId).first<{
    event_id: string;
    room_id: string;
    sender: string;
    event_type: string;
    state_key: string | null;
    content: string;
    origin_server_ts: number;
    depth: number;
    auth_events: string;
    prev_events: string;
    hashes: string | null;
    signatures: string | null;
  }>();

  if (!event) {
    // The requested ID may be a derived wire ID of a legacy locally-created
    // room; resolve it through that room's derivation.
    const legacyRooms = await c.env.DB.prepare(
      `SELECT r.room_id, r.room_version FROM rooms r
       JOIN room_state rs ON rs.room_id = r.room_id AND rs.event_type = 'm.room.create'
       JOIN events ce ON ce.event_id = rs.event_id
       WHERE CAST(r.room_version AS INTEGER) BETWEEN 3 AND 10 AND ce.sender LIKE ?`
    ).bind(`%:${c.env.SERVER_NAME}`).all<{ room_id: string; room_version: string }>();
    for (const r of legacyRooms.results ?? []) {
      const w = await deriveRoomWireEvents(c.env, r.room_id, r.room_version);
      if (!w) continue;
      const storedId = [...w.idMap.entries()].find(([, wid]) => wid === eventId)?.[0];
      if (!storedId) continue;
      const wirePdu = w.wireById.get(storedId);
      if (wirePdu) {
        return c.json({
          origin: c.env.SERVER_NAME,
          origin_server_ts: Date.now(),
          pdus: [wirePdu],
        });
      }
    }
    return Errors.notFound('Event not found').toResponse();
  }

  const eventRoom = await getRoom(c.env.DB, event.room_id);

  // Server ACL: denied servers get no room content, single events included.
  if (await callerDeniedByRoomAcl(c, event.room_id)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }
  const evWire = await wireForRoom(c.env, event.room_id, eventRoom?.room_version ?? '10');
  const evWirePdu = evWire?.wireById.get(event.event_id);
  if (evWirePdu) {
    return c.json({
      origin: c.env.SERVER_NAME,
      origin_server_ts: Date.now(),
      pdus: [evWirePdu],
    });
  }

  const pdu: PDU = {
    event_id: event.event_id,
    room_id: event.room_id,
    sender: event.sender,
    type: event.event_type,
    state_key: event.state_key ?? undefined,
    content: JSON.parse(event.content),
    origin_server_ts: event.origin_server_ts,
    depth: event.depth,
    auth_events: JSON.parse(event.auth_events),
    prev_events: JSON.parse(event.prev_events),
    hashes: event.hashes ? JSON.parse(event.hashes) : undefined,
    signatures: event.signatures ? JSON.parse(event.signatures) : undefined,
  };

  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: [omitWireEventId(pdu, eventRoom?.room_version)],
  });
});

// Reconstruct the room state at a named event by walking the stored DAG
// backwards from its prev_events/auth_events, then applying last-writer-wins
// per (type, state_key). This avoids silently serving CURRENT state for an
// event-scoped /state or /state_ids query.
const MAX_STATE_WALK = 2000;
const MAX_AUTH_CHAIN = 500;

async function stateBeforeEvent(
  db: D1Database,
  roomId: string,
  eventId: string
): Promise<{ state: PDU[]; authSeeds: string[] } | null> {
  const target = await getEvent(db, eventId);
  if (!target || target.room_id !== roomId) return null;

  const visited = new Set<string>();
  const stateById = new Map<string, PDU>();
  const queue: string[] = [...(target.prev_events ?? []), ...(target.auth_events ?? [])];
  while (queue.length > 0 && visited.size < MAX_STATE_WALK) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const event = await getEvent(db, id);
    if (!event || event.room_id !== roomId) continue;
    stateById.set(id, event);
    queue.push(...(event.prev_events ?? []), ...(event.auth_events ?? []));
  }

  const slots = new Map<string, PDU>();
  for (const event of stateById.values()) {
    if (event.state_key === undefined || event.state_key === null) continue;
    const key = `${event.type}\0${event.state_key}`;
    const incumbent = slots.get(key);
    if (
      !incumbent ||
      (event.depth ?? 0) > (incumbent.depth ?? 0) ||
      ((event.depth ?? 0) === (incumbent.depth ?? 0) &&
        (event.origin_server_ts ?? 0) >= (incumbent.origin_server_ts ?? 0))
    ) {
      slots.set(key, event);
    }
  }

  const authSeeds = [
    ...(target.auth_events ?? []),
    ...[...slots.values()].flatMap((event) => event.auth_events ?? []),
  ];
  return { state: [...slots.values()], authSeeds };
}

// Transitive auth chain (not just one hop): every auth_events reference of
// every auth event must be included until the create event closes the chain.
async function collectAuthChain(db: D1Database, seeds: string[]): Promise<PDU[]> {
  const visited = new Set<string>();
  const chain: PDU[] = [];
  const queue = [...seeds];
  while (queue.length > 0 && chain.length < MAX_AUTH_CHAIN) {
    const id = queue.shift()!;
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const event = await getEvent(db, id);
    if (!event) continue;
    chain.push(event);
    for (const ref of event.auth_events ?? []) {
      if (!visited.has(ref)) queue.push(ref);
    }
  }
  return chain;
}

// GET /_matrix/federation/v1/state/:roomId - Get room state
app.get('/_matrix/federation/v1/state/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.query('event_id');

  if (await callerDeniedByRoomAcl(c, roomId)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }

  const stateRoom = await getRoom(c.env.DB, roomId);

  // Get current room state
  type StateRow = {
    event_id: string;
    room_id: string;
    sender: string;
    event_type: string;
    state_key: string | null;
    content: string;
    origin_server_ts: number;
    depth: number;
    auth_events: string;
    prev_events: string;
    hashes: string | null;
    signatures: string | null;
  };
  const scoped = eventId ? await stateBeforeEvent(c.env.DB, roomId, eventId) : null;
  if (eventId && !scoped) return Errors.notFound('Event not found').toResponse();

  let stateEvents: StateRow[];
  let authSeeds: string[];
  if (scoped) {
    stateEvents = scoped.state.map((p): StateRow => ({
      event_id: p.event_id,
      room_id: p.room_id,
      sender: p.sender,
      event_type: p.type,
      state_key: p.state_key ?? null,
      content: JSON.stringify(p.content),
      origin_server_ts: p.origin_server_ts,
      depth: p.depth,
      auth_events: JSON.stringify(p.auth_events ?? []),
      prev_events: JSON.stringify(p.prev_events ?? []),
      hashes: p.hashes ? JSON.stringify(p.hashes) : null,
      signatures: p.signatures ? JSON.stringify(p.signatures) : null,
    }));
    authSeeds = scoped.authSeeds;
  } else {
    stateEvents = (await c.env.DB.prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content,
       e.origin_server_ts, e.depth, e.auth_events, e.prev_events, e.hashes, e.signatures
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`
    ).bind(roomId).all<StateRow>()).results ?? [];
    authSeeds = stateEvents.flatMap((e) => JSON.parse(e.auth_events) as string[]);
  }

  const pdus = stateEvents.map(e => ({
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    type: e.event_type,
    state_key: e.state_key ?? '',
    content: JSON.parse(e.content),
    origin_server_ts: e.origin_server_ts,
    depth: e.depth,
    auth_events: JSON.parse(e.auth_events),
    prev_events: JSON.parse(e.prev_events),
    hashes: e.hashes ? JSON.parse(e.hashes) : undefined,
    signatures: e.signatures ? JSON.parse(e.signatures) : undefined,
  }));

  const authChain = await collectAuthChain(c.env.DB, authSeeds);

  const stateWire = await wireForRoom(c.env, roomId, stateRoom?.room_version ?? '10');
  if (stateWire) {
    const joined = buildWireJoinState(stateWire, stateEvents.map((e) => e.event_id));
    return c.json({
      origin: c.env.SERVER_NAME,
      origin_server_ts: Date.now(),
      pdus: joined.state,
      auth_chain: joined.authChain,
    });
  }
  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: pdus.map((p) => omitWireEventId(p, stateRoom?.room_version)),
    auth_chain: authChain.map((p) => omitWireEventId(p, stateRoom?.room_version)),
  });
});

// GET /_matrix/federation/v1/state_ids/:roomId - Get room state event IDs only
app.get('/_matrix/federation/v1/state_ids/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.query('event_id');

  // Verify room exists
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  if (await callerDeniedByRoomAcl(c, roomId)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }

  // event_id is authoritative when present: serve state before that event,
  // never current state under an event-scoped query.
  const scoped = eventId ? await stateBeforeEvent(c.env.DB, roomId, eventId) : null;
  if (eventId && !scoped) return Errors.notFound('Event not found').toResponse();

  let stateEventIds: string[];
  let authSeeds: string[];
  if (scoped) {
    stateEventIds = scoped.state.map((event) => event.event_id);
    authSeeds = scoped.authSeeds;
  } else {
    const stateEvents = await c.env.DB.prepare(
      `SELECT e.event_id, e.auth_events
       FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`
    ).bind(roomId).all<{ event_id: string; auth_events: string }>();
    stateEventIds = stateEvents.results.map((e) => e.event_id);
    authSeeds = stateEvents.results.flatMap((e) => JSON.parse(e.auth_events) as string[]);
  }
  const authChainIds = (await collectAuthChain(c.env.DB, authSeeds)).map(
    (event) => event.event_id
  );

  const idsWire = await wireForRoom(c.env, roomId, room.room_version);
  if (idsWire) {
    const pduIds = stateEventIds.map((id) => idsWire.idMap.get(id) ?? id);
    const inState = new Set(pduIds);
    const authSet = new Set<string>();
    const queue = [...pduIds];
    while (queue.length > 0) {
      const id = queue.pop()!;
      const ev = idsWire.wireById.get(id);
      for (const ref of ((ev?.auth_events as string[] | undefined) ?? [])) {
        if (!inState.has(ref) && !authSet.has(ref)) {
          authSet.add(ref);
          queue.push(ref);
        }
      }
    }
    return c.json({ pdu_ids: pduIds, auth_chain_ids: [...authSet] });
  }
  return c.json({
    pdu_ids: stateEventIds,
    auth_chain_ids: authChainIds,
  });
});

// GET /_matrix/federation/v1/event_auth/:roomId/:eventId - Get auth chain for an event
app.get('/_matrix/federation/v1/event_auth/:roomId/:eventId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');

  // Verify room exists
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get the event
  const event = await c.env.DB.prepare(
    `SELECT event_id, auth_events FROM events WHERE event_id = ? AND room_id = ?`
  ).bind(eventId, roomId).first<{ event_id: string; auth_events: string }>();

  if (!event) {
    return Errors.notFound('Event not found').toResponse();
  }

  // Build auth chain by recursively collecting auth events
  // Cap at 500 events to prevent unbounded memory consumption
  const MAX_AUTH_CHAIN_SIZE = 500;
  const authChain: PDU[] = [];
  const visited = new Set<string>();
  const authWire = await wireForRoom(c.env, roomId, room.room_version);
  let toProcess = JSON.parse(event.auth_events) as string[];
  if (authWire) toProcess = toProcess.map((id) => authWire.idMap.get(id) ?? id);

  while (toProcess.length > 0 && authChain.length < MAX_AUTH_CHAIN_SIZE) {
    const authId = toProcess.shift()!;
    if (visited.has(authId)) continue;
    visited.add(authId);

    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events WHERE event_id = ?`
    ).bind(authId).first<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      state_key: string | null;
      content: string;
      origin_server_ts: number;
      depth: number;
      auth_events: string;
      prev_events: string;
      hashes: string | null;
      signatures: string | null;
    }>();

    if (authEvent) {
      const wireForm = authWire?.wireById.get(authEvent.event_id);
      authChain.push((wireForm ?? omitWireEventId({
        event_id: authEvent.event_id,
        room_id: authEvent.room_id,
        sender: authEvent.sender,
        type: authEvent.event_type,
        state_key: authEvent.state_key ?? undefined,
        content: JSON.parse(authEvent.content),
        origin_server_ts: authEvent.origin_server_ts,
        depth: authEvent.depth,
        auth_events: JSON.parse(authEvent.auth_events),
        prev_events: JSON.parse(authEvent.prev_events),
        hashes: authEvent.hashes ? JSON.parse(authEvent.hashes) : undefined,
        signatures: authEvent.signatures ? JSON.parse(authEvent.signatures) : undefined,
      }, room.room_version)) as PDU);

      // Add this event's auth_events to process (wire IDs when derived)
      const moreAuthEvents = (wireForm?.auth_events as string[] | undefined) ?? JSON.parse(authEvent.auth_events) as string[];
      for (const id of moreAuthEvents) {
        if (!visited.has(id)) {
          toProcess.push(id);
        }
      }
    }
  }

  return c.json({
    auth_chain: authChain.map((p) => omitWireEventId(p, room.room_version)),
  });
});

// GET /_matrix/federation/v1/backfill/:roomId - Fetch historical events
app.get('/_matrix/federation/v1/backfill/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const rawLimit = parseInt(c.req.query('limit') || '100', 10);
  const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 100 : rawLimit, 1000));
  const vParam = c.req.query('v'); // Starting event IDs

  // Verify room exists
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Verify the requesting server has membership in this room
  const origin = (c as any).get('federationOrigin');
  if (origin) {
    const hasMember = await c.env.DB.prepare(
      `SELECT 1 FROM room_memberships WHERE room_id = ? AND SUBSTR(user_id, INSTR(user_id, ':') + 1) = ? AND membership = 'join' LIMIT 1`
    ).bind(roomId, origin).first();
    if (!hasMember) {
      return c.json({ errcode: 'M_FORBIDDEN', error: 'Requesting server has no users in this room' }, 403);
    }
  }

  if (await callerDeniedByRoomAcl(c, roomId)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }

  // Parse starting event IDs (cap at 20 to prevent oversized IN queries)
  const startEventIds = vParam ? vParam.split(',').slice(0, 20) : [];

  let events: any[];
  if (startEventIds.length > 0) {
    // Get events before the specified events
    const startEvents = await c.env.DB.prepare(
      `SELECT MIN(depth) as min_depth FROM events WHERE event_id IN (${startEventIds.map(() => '?').join(',')})`
    ).bind(...startEventIds).first<{ min_depth: number }>();

    const maxDepth = startEvents?.min_depth || 0;

    events = (await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events
       WHERE room_id = ? AND depth < ?
       ORDER BY depth DESC
       LIMIT ?`
    ).bind(roomId, maxDepth, limit).all()).results;
  } else {
    // Get most recent events
    events = (await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events
       WHERE room_id = ?
       ORDER BY depth DESC
       LIMIT ?`
    ).bind(roomId, limit).all()).results;
  }

  const pdus = events.map((e: any) => ({
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    type: e.event_type,
    state_key: e.state_key ?? undefined,
    content: JSON.parse(e.content),
    origin_server_ts: e.origin_server_ts,
    depth: e.depth,
    auth_events: JSON.parse(e.auth_events),
    prev_events: JSON.parse(e.prev_events),
    hashes: e.hashes ? JSON.parse(e.hashes) : undefined,
    signatures: e.signatures ? JSON.parse(e.signatures) : undefined,
  }));

  const bfWire = await wireForRoom(c.env, roomId, room.room_version);
  return c.json({
    origin: c.env.SERVER_NAME,
    origin_server_ts: Date.now(),
    pdus: bfWire
      ? events.map((e: any) => bfWire.wireById.get(e.event_id)).filter(Boolean)
      : pdus.map((p) => omitWireEventId(p, room.room_version)),
  });
});

// POST /_matrix/federation/v1/get_missing_events/:roomId - Fill event gaps
app.post('/_matrix/federation/v1/get_missing_events/:roomId', async (c) => {
  const roomId = c.req.param('roomId');

  let body: {
    earliest_events?: string[];
    latest_events?: string[];
    limit?: number;
    min_depth?: number;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const earliestEvents = (body.earliest_events || []).slice(0, 20);
  const latestEvents = (body.latest_events || []).slice(0, 20);
  const limit = Math.min(body.limit || 10, 100);
  const minDepth = body.min_depth || 0;

  // Verify room exists
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Verify the requesting server has membership in this room
  const missingEventsOrigin = (c as any).get('federationOrigin');
  if (missingEventsOrigin) {
    const hasMember = await c.env.DB.prepare(
      `SELECT 1 FROM room_memberships WHERE room_id = ? AND SUBSTR(user_id, INSTR(user_id, ':') + 1) = ? AND membership = 'join' LIMIT 1`
    ).bind(roomId, missingEventsOrigin).first();
    if (!hasMember) {
      return c.json({ errcode: 'M_FORBIDDEN', error: 'Requesting server has no users in this room' }, 403);
    }
  }

  if (await callerDeniedByRoomAcl(c, roomId)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }

  // Walk backwards from latest_events to earliest_events
  const events: any[] = [];
  const visited = new Set<string>(earliestEvents);
  const toProcess = [...latestEvents];

  while (toProcess.length > 0 && events.length < limit) {
    const eventId = toProcess.shift()!;
    if (visited.has(eventId)) continue;
    visited.add(eventId);

    const event = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events
       WHERE event_id = ? AND room_id = ? AND depth >= ?`
    ).bind(eventId, roomId, minDepth).first<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      state_key: string | null;
      content: string;
      origin_server_ts: number;
      depth: number;
      auth_events: string;
      prev_events: string;
      hashes: string | null;
      signatures: string | null;
    }>();

    if (event) {
      events.push({
        event_id: event.event_id,
        room_id: event.room_id,
        sender: event.sender,
        type: event.event_type,
        state_key: event.state_key ?? undefined,
        content: JSON.parse(event.content),
        origin_server_ts: event.origin_server_ts,
        depth: event.depth,
        auth_events: JSON.parse(event.auth_events),
        prev_events: JSON.parse(event.prev_events),
        hashes: event.hashes ? JSON.parse(event.hashes) : undefined,
        signatures: event.signatures ? JSON.parse(event.signatures) : undefined,
      });

      // Add prev_events to process
      const prevEvents = JSON.parse(event.prev_events) as string[];
      for (const prevId of prevEvents) {
        if (!visited.has(prevId)) {
          toProcess.push(prevId);
        }
      }
    }
  }

  const gmWire = await wireForRoom(c.env, roomId, room.room_version);
  return c.json({
    events: gmWire
      ? events.map((p: any) => gmWire.wireById.get(p.event_id)).filter(Boolean)
      : events.map((p) => omitWireEventId(p, room.room_version)),
  });
});

// Derive the wire form of every event in a room: reference-hash ID, content
// hash, and a signature over the redacted event. Room versions 11+ store
// locally-created events under generated IDs that reference each other by
// those IDs, but federation peers only ever exchange derived IDs -- every
// outbound use (make_join templates, send_join state) must translate.
// Wire derivation lives in services/event-wire (shared with outbound paths).
// Countersign a joining server's m.room.member join event and persist it as
// current state. The joining server signs first; the resident server (us)
// adds its own signature -- both must survive -- and stores the event under
// its derived wire ID, because that is the ID every peer sees.
async function persistInboundJoin(
  env: Env,
  roomId: string,
  joinEvent: Record<string, unknown>,
  origin?: string,
  roomVersion?: string
): Promise<string | null> {
  if (
    joinEvent['room_id'] !== roomId ||
    joinEvent['type'] !== 'm.room.member' ||
    (joinEvent['content'] as { membership?: string } | undefined)?.membership !== 'join' ||
    typeof joinEvent['state_key'] !== 'string' ||
    joinEvent['state_key'] !== joinEvent['sender']
  ) {
    return null;
  }

  // A joining user's event travels through that user's own server, so the
  // authenticated origin of the request must match the sender's domain.
  // Without this check a server that signs its own requests could submit
  // joins on behalf of users of other servers.
  if (origin) {
    const sender = typeof joinEvent['sender'] === 'string' ? joinEvent['sender'] : '';
    const senderServer = sender.includes(':') ? sender.slice(sender.indexOf(':') + 1) : '';
    if (senderServer !== origin) {
      console.warn(
        `[federation] Rejecting inbound join: sender ${sender} is not from origin ${origin}`
      );
      return null;
    }
  }

  const signingKey = await getServerSigningKey(env.DB);
  if (!signingKey) return null;

  const signed = await signJson(
    redactEventForSigning(toWireEventObject(joinEvent), roomVersion),
    env.SERVER_NAME,
    signingKey.keyId,
    signingKey.privateKeyJwk
  );
  const ourSig = (signed as { signatures?: Record<string, unknown> }).signatures?.[env.SERVER_NAME];
  joinEvent['signatures'] = {
    ...((joinEvent['signatures'] as Record<string, unknown> | undefined) ?? {}),
    ...(ourSig ? { [env.SERVER_NAME]: ourSig } : {}),
  };

  const wireId = await computeWireEventId(joinEvent, roomVersion);
  joinEvent['event_id'] = wireId;

  const event = joinEvent as unknown as PDU;
  await storeEvent(env.DB, event);
  await updateMembership(env.DB, roomId, event.state_key as string, 'join', wireId);
  await fanoutEventToAppServices(env, event);

  // Wake local members' sync loops so the new member shows up promptly.
  const localMembers = await env.DB.prepare(
    `SELECT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join' AND user_id LIKE ?`
  ).bind(roomId, `%:${env.SERVER_NAME}`).all<{ user_id: string }>();
  for (const member of localMembers.results ?? []) {
    await notifyUserSync(env, member.user_id, 'events');
  }

  return wireId;
}

// Legacy rooms (v1-10) keep the reference-hash event ID the joining server
// assigned, so unlike persistInboundJoin we must not recompute a derived ID.
async function persistLegacyInboundJoin(
  env: Env,
  roomId: string,
  joinEvent: Record<string, unknown>,
  origin?: string
): Promise<string | null> {
  if (
    joinEvent['room_id'] !== roomId ||
    joinEvent['type'] !== 'm.room.member' ||
    (joinEvent['content'] as { membership?: string } | undefined)?.membership !== 'join' ||
    typeof joinEvent['state_key'] !== 'string' ||
    joinEvent['state_key'] !== joinEvent['sender'] ||
    typeof joinEvent['event_id'] !== 'string'
  ) {
    return null;
  }
  if (origin) {
    const sender = typeof joinEvent['sender'] === 'string' ? joinEvent['sender'] : '';
    const senderServer = sender.includes(':') ? sender.slice(sender.indexOf(':') + 1) : '';
    if (senderServer !== origin) return null;
  }
  const eventId = joinEvent['event_id'] as string;
  const existing = await env.DB.prepare(
    `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`
  ).bind(roomId, joinEvent['state_key']).first<{ membership: string }>();
  if (existing?.membership === 'join') return eventId;

  const signingKey = await getServerSigningKey(env.DB);
  if (signingKey) {
    // v4+ signatures cover the wire form: no event_id, no unsigned. Signing
    // with event_id present produces a signature peers cannot verify.
    const wire = toWireEventObject(joinEvent);
    const signed = await signJson(
      redactEventForSigning(wire),
      env.SERVER_NAME,
      signingKey.keyId,
      signingKey.privateKeyJwk
    );
    const ourSig = (signed as { signatures?: Record<string, unknown> }).signatures?.[env.SERVER_NAME];
    joinEvent['signatures'] = {
      ...((joinEvent['signatures'] as Record<string, unknown> | undefined) ?? {}),
      ...(ourSig ? { [env.SERVER_NAME]: ourSig } : {}),
    };
  }
  const event = joinEvent as unknown as PDU;
  await storeEvent(env.DB, event);
  await updateMembership(env.DB, roomId, event.state_key as string, 'join', eventId);
  await fanoutEventToAppServices(env, event);

  const localMembers = await env.DB.prepare(
    `SELECT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join' AND user_id LIKE ?`
  ).bind(roomId, `%:${env.SERVER_NAME}`).all<{ user_id: string }>();
  for (const member of localMembers.results ?? []) {
    await notifyUserSync(env, member.user_id, 'events');
  }
  return eventId;
}

// Authorize an inbound join against our copy of the room state before
// countersigning and persisting it. The joining server runs the same rules,
// but we must not trust it: without this check send_join accepted joins into
// invite-only rooms (and handed the caller the room's state).
export async function authorizeInboundJoin(
  env: Env,
  roomId: string,
  roomVersion: string,
  joinEvent: Record<string, unknown>,
  origin?: string
): Promise<string | null> {
  const sender = typeof joinEvent['sender'] === 'string' ? joinEvent['sender'] : '';
  const stateKey = typeof joinEvent['state_key'] === 'string' ? joinEvent['state_key'] : '';
  if (!sender || sender !== stateKey) {
    return 'Join event must be sent by the joining user';
  }
  if (origin) {
    const senderServer = sender.includes(':') ? sender.slice(sender.indexOf(':') + 1) : '';
    if (senderServer !== origin) {
      return 'Join event sender does not belong to the authenticated server';
    }
  }

  // Room v8 restricted-join rule: only a user on the RESIDENT server may
  // authorise an inbound join. checkEventAuth verifies membership and invite
  // power; the server identity is ours to enforce before we countersign.
  const content = joinEvent['content'] as Record<string, unknown> | undefined;
  const authorisingUser = content?.['join_authorised_via_users_server'];
  if (typeof authorisingUser === 'string' && authorisingUser) {
    if (serverNameFromId(authorisingUser) !== env.SERVER_NAME) {
      return 'The authorising user is not on this server';
    }
  }

  const roomState = await getRoomState(env.DB, roomId);
  // No synced state: cannot authorize, keep the previous permissive behavior
  // rather than refusing joins into rooms whose state we have not received.
  if (roomState.length === 0) return null;

  // Server ACL (spec module; MSC4436): denied servers cannot join either.
  const acl = findServerAcl(roomState);
  if (acl) {
    const senderServer = serverNameFromId(sender);
    if (!isServerAllowedByAcl(acl, senderServer)) {
      return `Server ${senderServer} is denied by the room's server ACL`;
    }
  }

  try {
    const result = checkEventAuth(joinEvent as unknown as PDU, roomState, roomVersion);
    return result.allowed ? null : (result.error ?? 'Join is not authorized');
  } catch (err) {
    console.warn('[federation] Inbound join auth check failed:', err);
    return 'Join is not authorized';
  }
}

// POST /_matrix/federation/v1/make_join/:roomId/:userId - Prepare join request
app.get('/_matrix/federation/v1/make_join/:roomId/:userId', async (c) => {
  const roomId = c.req.param('roomId');
  const userId = c.req.param('userId');

  // Check if room exists and is joinable
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // A server may only ask for join templates for its own users. Without
  // this, any federated server could probe room state on behalf of users
  // it does not host.
  const origin = c.get('federationOrigin' as any) as string | undefined;
  if (origin) {
    const userServer = userId.includes(':') ? userId.slice(userId.indexOf(':') + 1) : '';
    if (userServer !== origin) {
      return Errors.forbidden('Cannot request a join for a user on another server').toResponse();
    }
  }

  // Get current room state for auth events
  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
  ).bind(roomId).first<{ event_id: string }>();

  const joinRulesEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'`
  ).bind(roomId).first<{ event_id: string }>();

  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`
  ).bind(roomId).first<{ event_id: string }>();

  // The joining user's current membership (their invite, if any): the
  // receiving server's auth checks require it in the join's auth_events.
  // The same state lookup tells us whether the user may join at all.
  const roomState = await getRoomState(c.env.DB, roomId);
  const membershipEvent = roomState.find(
    (e) => e.type === 'm.room.member' && e.state_key === userId
  );
  const inviteeMembership = membershipEvent ? { event_id: membershipEvent.event_id } : null;
  const membership = (membershipEvent?.content as { membership?: string } | undefined)?.membership;
  const joinRulesState = roomState.find((e) => e.type === 'm.room.join_rules');
  const joinRule = (joinRulesState?.content as { join_rule?: string } | undefined)?.join_rule;

  // Server ACL (spec module; MSC4436): denied servers get no join template.
  const acl = findServerAcl(roomState);
  if (acl) {
    const userServer = userId.includes(':') ? userId.slice(userId.indexOf(':') + 1) : '';
    if (!isServerAllowedByAcl(acl, userServer)) {
      return Errors.forbidden("Server is denied by the room's server ACL").toResponse();
    }
  }

  // Join-rule gate: refuse uninvited users of invite-only rooms here, with
  // M_FORBIDDEN, rather than serving a template the client then fails to use
  // (which surfaces as Element's vague "Something went wrong"). Only refuse
  // when the join_rules event is actually held -- a room whose state has not
  // synced keeps the previous behavior.
  if (membership === 'ban') {
    return Errors.forbidden('You are banned from this room').toResponse();
  }
  if (
    joinRule &&
    joinRule !== 'public' &&
    joinRule !== 'restricted' &&
    joinRule !== 'knock_restricted' &&
    membership !== 'invite' &&
    membership !== 'join'
  ) {
    return Errors.forbidden(
      joinRule === 'knock'
        ? 'This room requires a knock before joining'
        : 'You are not invited to this room'
    ).toResponse();
  }

  // Restricted rooms (MSC3083/MSC3787): without an invite the joining user
  // must be in an allowed room, and we must name a joined local member with
  // invite power so the remote server can authorise our join event.
  let restrictedAuthoriser: string | undefined;
  let restrictedAuthEventId: string | undefined;
  if (
    membership !== 'invite' &&
    membership !== 'join' &&
    (joinRule === 'restricted' || joinRule === 'knock_restricted')
  ) {
    const decision = await evaluateRestrictedJoin({
      db: c.env.DB,
      cache: c.env.CACHE,
      localServerName: c.env.SERVER_NAME,
      roomId,
      userId,
      roomState,
      roomVersion: room.room_version,
    });
    if (decision.error || !decision.authorizedBy) {
      return Errors.forbidden(decision.error ?? 'You are not allowed to join this room').toResponse();
    }
    restrictedAuthoriser = decision.authorizedBy;
    restrictedAuthEventId = decision.authEventId;
  }

  // The template must reference the IDs residents exchange. Only re-derive
  // rooms WE created: a remote-created room's stored IDs are the residents'
  // real IDs (often derived with the legacy keep-list that retained `origin`),
  // so translating them here would put phantom refs in the join template.
  const makerWire = await roomWireDerivationAllowed(c.env, roomId)
    ? await deriveRoomWireEvents(c.env, roomId, room.room_version)
    : null;
  const wireRef = (id: string): string => makerWire?.idMap.get(id) ?? id;

  const authEvents: string[] = [];
  if (createEvent && !isMsc4291RoomVersion(room.room_version)) authEvents.push(wireRef(createEvent.event_id));
  if (powerLevelsEvent) authEvents.push(wireRef(powerLevelsEvent.event_id));
  if (inviteeMembership) authEvents.push(wireRef(inviteeMembership.event_id));
  if (restrictedAuthEventId) authEvents.push(wireRef(restrictedAuthEventId));
  if (joinRulesEvent) authEvents.push(wireRef(joinRulesEvent.event_id));

  // Get latest event for prev_events
  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`
  ).bind(roomId).first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [wireRef(latestEvent.event_id)] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned join event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: {
      membership: 'join',
      ...(restrictedAuthoriser
        ? { join_authorised_via_users_server: restrictedAuthoriser }
        : {}),
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

// POST /_matrix/federation/v1/refresh_room/:roomId - Refresh current state
// of a restricted room after joining it via an allow-list room (spec v1.11).
app.post('/_matrix/federation/v1/refresh_room/:roomId', async (c) => {
  const roomId = c.req.param('roomId');

  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();
  if (!room) return Errors.notFound('Room not found').toResponse();

  const behavior = getRoomVersion(room.room_version);
  if (!behavior?.restrictedJoinsSupported) {
    return Errors.unsupportedRoomVersion('Restricted room state refresh requires a room version supporting restricted joins').toResponse();
  }

  // Same ACL posture as the other federation read/state routes: denied
  // servers learn nothing about the room, including via a refresh. Check
  // both the room-state ACL and the cached state-event lookup used by the
  // read endpoints.
  const aclDeniedMessage = "The calling server is denied by the room's server ACL";
  const origin = c.get('federationOrigin' as any) as string | undefined;
  try {
    const acl = findServerAcl(await getRoomState(c.env.DB, roomId));
    if (acl && origin && !isServerAllowedByAcl(acl, origin)) {
      return Errors.forbidden(aclDeniedMessage).toResponse();
    }
  } catch {
    // ACL lookup failures fall open, as on the other read routes.
  }
  if (await callerDeniedByRoomAcl(c, roomId)) {
    return Errors.forbidden(aclDeniedMessage).toResponse();
  }

  let body: { via?: unknown };
  try {
    body = await getFederationBody<{ via?: unknown }>(c);
  } catch {
    return Errors.badJson().toResponse();
  }
  const via = Array.isArray(body?.via)
    ? body.via.filter((value): value is string => typeof value === 'string' && !!value)
    : [];
  if (via.length === 0) {
    return Errors.invalidParam('via', 'via must be a non-empty array of server names').toResponse();
  }

  // The resync is deliberately not awaited: return 200 promptly and refresh
  // from the via servers on the Worker's execution context.
  const resync = refreshRestrictedRoomState(c.env, roomId, via, room.room_version)
    .catch((err) => {
      console.warn('[federation] refresh_room state resync failed', {
        roomId, error: err instanceof Error ? err.message : String(err),
      });
    });
  const executionCtx = (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } }).executionCtx;
  if (typeof executionCtx?.waitUntil === 'function') {
    executionCtx.waitUntil(resync);
  } else {
    void resync;
  }

  return c.json({});
});

// PUT /_matrix/federation/v1/send_join/:roomId/:eventId - Complete join
// (v1 was REMOVED from the spec in v1.18 (MSC4376) — kept here
// deliberately for older peers; v2 is the negotiated path for modern
// servers.)
app.put('/_matrix/federation/v1/send_join/:roomId/:eventId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');

  let body: any;
  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  // Validate the event ID matches
  if (body.event_id && body.event_id !== eventId) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event ID mismatch' },
      400
    );
  }

  // Get room info
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  const joinOrigin = c.get('federationOrigin' as any) as string | undefined;
  const joinAuthError = await authorizeInboundJoin(
    c.env,
    roomId,
    room.room_version,
    body as Record<string, unknown>,
    joinOrigin
  );
  if (joinAuthError) {
    return Errors.forbidden(joinAuthError).toResponse();
  }

  // MSC4284 (spec v1.18): joins in policy-server rooms must carry a valid
  // countersignature (membership events are refused, not soft-failed).
  if (await policySignatureMissing(c, body as Record<string, unknown>, room.room_version)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The join lacks a valid policy server signature' },
      403
    );
  }

  // Room versions 11+ (derived event IDs): countersign and store the join,
  // then serve the room's state in wire form -- peers only exchange derived
  // IDs, so locally stored events must be translated before they leave.
  let wire = await wireForRoom(c.env, roomId, room.room_version);
  if (!wire) {
    // send_join carries the event ID in the URL; the PDU body may omit it.
    if (!body.event_id) body.event_id = eventId;
    const storedJoinId = await persistLegacyInboundJoin(
      c.env,
      roomId,
      body as Record<string, unknown>,
      joinOrigin
    );
    if (!storedJoinId) {
      return Errors.forbidden('Join event was rejected').toResponse();
    }
  }
  if (wire) {
    const storedJoinId = await persistInboundJoin(
      c.env,
      roomId,
      body as Record<string, unknown>,
      joinOrigin,
      room.room_version
    );
    if (!storedJoinId) {
      return Errors.forbidden('Join event was rejected').toResponse();
    }
    console.log(`[federation] Stored inbound join ${storedJoinId} in ${roomId}`);
    // Re-derive after persisting so the join itself is in the served state.
    wire = (await wireForRoom(c.env, roomId, room.room_version)) ?? wire;
    {
      const stateRows = await c.env.DB.prepare(
        `SELECT event_id FROM room_state WHERE room_id = ?`
      ).bind(roomId).all<{ event_id: string }>();
      const { state, authChain } = buildWireJoinState(
        wire,
        (stateRows.results ?? []).map((r) => r.event_id)
      );
      return c.json({
        origin: c.env.SERVER_NAME,
        auth_chain: authChain,
        state,
        event: toWireEventObject(body as Record<string, unknown>),
      });
    }
  }

  // Legacy path (room versions 1-10): serve stored events as-is.
  // Get current state and auth chain
  const stateEvents = await c.env.DB.prepare(
    `SELECT e.* FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`
  ).bind(roomId).all();

  // Build auth chain
  const authChainIds = new Set<string>();
  for (const event of stateEvents.results) {
    const authEvents = JSON.parse((event as any).auth_events) as string[];
    for (const authId of authEvents) {
      authChainIds.add(authId);
    }
  }

  const authChain: any[] = [];
  for (const authId of authChainIds) {
    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events WHERE event_id = ?`
    ).bind(authId).first();

    if (authEvent) {
      authChain.push({
        event_id: (authEvent as any).event_id,
        room_id: (authEvent as any).room_id,
        sender: (authEvent as any).sender,
        type: (authEvent as any).event_type,
        state_key: (authEvent as any).state_key ?? undefined,
        content: JSON.parse((authEvent as any).content),
        origin_server_ts: (authEvent as any).origin_server_ts,
        depth: (authEvent as any).depth,
        auth_events: JSON.parse((authEvent as any).auth_events),
        prev_events: JSON.parse((authEvent as any).prev_events),
        hashes: (authEvent as any).hashes ? JSON.parse((authEvent as any).hashes) : undefined,
        signatures: (authEvent as any).signatures ? JSON.parse((authEvent as any).signatures) : undefined,
      });
    }
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    auth_chain: authChain.map((p) => omitWireEventId(p, room.room_version)),
    state: stateEvents.results.map((e: any) => omitWireEventId({
      event_id: e.event_id,
      room_id: e.room_id,
      sender: e.sender,
      type: e.event_type,
      state_key: e.state_key ?? undefined,
      content: JSON.parse(e.content),
      origin_server_ts: e.origin_server_ts,
      depth: e.depth,
      auth_events: JSON.parse(e.auth_events),
      prev_events: JSON.parse(e.prev_events),
      hashes: e.hashes ? JSON.parse(e.hashes) : undefined,
      signatures: e.signatures ? JSON.parse(e.signatures) : undefined,
    }, room.room_version)),
    event: omitWireEventId(body, room.room_version),
  });
});

// PUT /_matrix/federation/v2/send_join/:roomId/:eventId - Complete join (v2)
// v2 wraps response in { event, state, auth_chain, ... } instead of returning array
app.put('/_matrix/federation/v2/send_join/:roomId/:eventId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');

  let body: any;
  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  // Validate the event ID matches
  if (body.event_id && body.event_id !== eventId) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event ID mismatch' },
      400
    );
  }

  // Get room info
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  const joinOrigin = c.get('federationOrigin' as any) as string | undefined;
  const joinAuthError = await authorizeInboundJoin(
    c.env,
    roomId,
    room.room_version,
    body as Record<string, unknown>,
    joinOrigin
  );
  if (joinAuthError) {
    return Errors.forbidden(joinAuthError).toResponse();
  }

  // MSC4284 (spec v1.18): joins in policy-server rooms must carry a valid
  // countersignature (membership events are refused, not soft-failed).
  if (await policySignatureMissing(c, body as Record<string, unknown>, room.room_version)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The join lacks a valid policy server signature' },
      403
    );
  }

  // Room versions 11+ (derived event IDs): countersign and store the join,
  // then serve the room's state in wire form -- peers only exchange derived
  // IDs, so locally stored events must be translated before they leave.
  let wire = await wireForRoom(c.env, roomId, room.room_version);
  if (!wire) {
    // send_join carries the event ID in the URL; the PDU body may omit it.
    if (!body.event_id) body.event_id = eventId;
    const storedJoinId = await persistLegacyInboundJoin(
      c.env,
      roomId,
      body as Record<string, unknown>,
      joinOrigin
    );
    if (!storedJoinId) {
      return Errors.forbidden('Join event was rejected').toResponse();
    }
  }
  if (wire) {
    const storedJoinId = await persistInboundJoin(
      c.env,
      roomId,
      body as Record<string, unknown>,
      joinOrigin,
      room.room_version
    );
    if (!storedJoinId) {
      return Errors.forbidden('Join event was rejected').toResponse();
    }
    console.log(`[federation] Stored inbound join ${storedJoinId} in ${roomId}`);
    // Re-derive after persisting so the join itself is in the served state.
    wire = (await wireForRoom(c.env, roomId, room.room_version)) ?? wire;
    {
      const stateRows = await c.env.DB.prepare(
        `SELECT rs.event_id, e.sender, e.event_type, e.content FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ?`
      ).bind(roomId).all<{ event_id: string; sender: string; event_type: string; content: string }>();
      const rows = stateRows.results ?? [];
      const { state, authChain } = buildWireJoinState(wire, rows.map((r) => r.event_id));

      const serversInRoom = new Set<string>();
      for (const row of rows) {
        if (row.event_type === 'm.room.member') {
          const content = JSON.parse(row.content);
          if (content.membership === 'join') {
            const serverName = row.sender.split(':')[1];
            if (serverName) serversInRoom.add(serverName);
          }
        }
      }

      return c.json({
        origin: c.env.SERVER_NAME,
        auth_chain: authChain,
        state,
        event: toWireEventObject(body as Record<string, unknown>),
        members_omitted: false,
        servers_in_room: Array.from(serversInRoom),
      });
    }
  }

  // Legacy path (room versions 1-10): serve stored events as-is.
  // Get current state and auth chain
  const stateEvents = await c.env.DB.prepare(
    `SELECT e.* FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ?`
  ).bind(roomId).all();

  // Build auth chain
  const authChainIds = new Set<string>();
  for (const event of stateEvents.results) {
    const authEvents = JSON.parse((event as any).auth_events) as string[];
    for (const authId of authEvents) {
      authChainIds.add(authId);
    }
  }

  const authChain: any[] = [];
  for (const authId of authChainIds) {
    const authEvent = await c.env.DB.prepare(
      `SELECT event_id, room_id, sender, event_type, state_key, content,
       origin_server_ts, depth, auth_events, prev_events, hashes, signatures
       FROM events WHERE event_id = ?`
    ).bind(authId).first();

    if (authEvent) {
      authChain.push({
        event_id: (authEvent as any).event_id,
        room_id: (authEvent as any).room_id,
        sender: (authEvent as any).sender,
        type: (authEvent as any).event_type,
        state_key: (authEvent as any).state_key ?? undefined,
        content: JSON.parse((authEvent as any).content),
        origin_server_ts: (authEvent as any).origin_server_ts,
        depth: (authEvent as any).depth,
        auth_events: JSON.parse((authEvent as any).auth_events),
        prev_events: JSON.parse((authEvent as any).prev_events),
        hashes: (authEvent as any).hashes ? JSON.parse((authEvent as any).hashes) : undefined,
        signatures: (authEvent as any).signatures ? JSON.parse((authEvent as any).signatures) : undefined,
      });
    }
  }

  // v2 returns servers_in_room for restricted joins
  const serversInRoom = new Set<string>();
  for (const event of stateEvents.results) {
    if ((event as any).event_type === 'm.room.member') {
      const content = JSON.parse((event as any).content);
      if (content.membership === 'join') {
        const sender = (event as any).sender as string;
        const serverName = sender.split(':')[1];
        if (serverName) serversInRoom.add(serverName);
      }
    }
  }

  return c.json({
    origin: c.env.SERVER_NAME,
    auth_chain: authChain.map((p) => omitWireEventId(p, room.room_version)),
    state: stateEvents.results.map((e: any) => omitWireEventId({
      event_id: e.event_id,
      room_id: e.room_id,
      sender: e.sender,
      type: e.event_type,
      state_key: e.state_key ?? undefined,
      content: JSON.parse(e.content),
      origin_server_ts: e.origin_server_ts,
      depth: e.depth,
      auth_events: JSON.parse(e.auth_events),
      prev_events: JSON.parse(e.prev_events),
      hashes: e.hashes ? JSON.parse(e.hashes) : undefined,
      signatures: e.signatures ? JSON.parse(e.signatures) : undefined,
    }, room.room_version)),
    event: omitWireEventId(body, room.room_version),
    members_omitted: false,
    servers_in_room: Array.from(serversInRoom),
  });
});

// GET /_matrix/federation/v1/make_leave/:roomId/:userId - Prepare leave request
app.get('/_matrix/federation/v1/make_leave/:roomId/:userId', async (c) => {
  const roomId = c.req.param('roomId');
  const userId = c.req.param('userId');

  // Check if room exists
  const room = await c.env.DB.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check if user is a member of the room
  const membership = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`
  ).bind(roomId, userId).first<{ event_id: string }>();

  if (!membership) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'User is not a member of the room' },
      403
    );
  }

  // Get auth events for leave
  const createEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
  ).bind(roomId).first<{ event_id: string }>();

  const powerLevelsEvent = await c.env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'`
  ).bind(roomId).first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (membership) authEvents.push(membership.event_id);

  // Get latest event for prev_events
  const latestEvent = await c.env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`
  ).bind(roomId).first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned leave event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: {
      membership: 'leave',
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

// Verify that a send_leave event was signed by the server of the user it
// concerns. A resident that countersigns and persists an unverified leave can
// be tricked into ejecting a remote user by any peer that signs its own
// requests (the request signature only authenticates the HTTP peer).
async function verifyInboundLeaveSignature(
  env: Env,
  leaveEvent: Record<string, unknown>,
  origin: string,
  roomVersion: string
): Promise<string | null> {
  const verifyKeys = await resolvePduVerifyKeys(env, origin);
  const result = await verifyPdu(leaveEvent as unknown as PDU, origin, roomVersion, verifyKeys);
  return 'error' in result ? result.error : null;
}

// Authorize a leave against our copy of the room state, with the same ACL /
// membership checks the send_join path applies before countersigning.
async function authorizeInboundLeave(
  env: Env,
  roomId: string,
  roomVersion: string,
  leaveEvent: Record<string, unknown>,
  origin?: string
): Promise<string | null> {
  const sender = typeof leaveEvent['sender'] === 'string' ? leaveEvent['sender'] : '';
  const stateKey = typeof leaveEvent['state_key'] === 'string' ? leaveEvent['state_key'] : '';
  if (!sender || !stateKey) return 'Leave event must have a sender and state key';
  if (origin && serverNameFromId(sender) !== origin) {
    return 'Leave event sender does not belong to the authenticated server';
  }

  const roomState = await getRoomState(env.DB, roomId);
  if (roomState.length === 0) return null;

  const acl = findServerAcl(roomState);
  if (acl) {
    const senderServer = serverNameFromId(sender);
    if (!isServerAllowedByAcl(acl, senderServer)) {
      return `Server ${senderServer} is denied by the room's server ACL`;
    }
  }

  try {
    const result = checkEventAuth(leaveEvent as unknown as PDU, roomState, roomVersion);
    return result.allowed ? null : (result.error ?? 'Leave is not authorized');
  } catch (err) {
    console.warn('[federation] Inbound leave auth check failed:', err);
    return 'Leave is not authorized';
  }
}

// Countersign and persist a leave exactly as persistInboundJoin does for
// joins: the joining/leaving server signs first, the resident adds its own
// signature, and the event is stored under the ID the peers exchange.
async function persistInboundLeave(
  env: Env,
  roomId: string,
  leaveEvent: Record<string, unknown>,
  origin: string | undefined,
  roomVersion: string
): Promise<string | null> {
  if (
    leaveEvent['room_id'] !== roomId ||
    leaveEvent['type'] !== 'm.room.member' ||
    (leaveEvent['content'] as { membership?: string } | undefined)?.membership !== 'leave' ||
    typeof leaveEvent['state_key'] !== 'string'
  ) {
    return null;
  }
  const sender = typeof leaveEvent['sender'] === 'string' ? leaveEvent['sender'] : '';
  if (origin && serverNameFromId(sender) !== origin) return null;

  const signingKey = await getServerSigningKey(env.DB);
  if (!signingKey) return null;

  const signed = await signJson(
    redactEventForSigning(toWireEventObject(leaveEvent), roomVersion),
    env.SERVER_NAME,
    signingKey.keyId,
    signingKey.privateKeyJwk
  );
  const ourSig = (signed as { signatures?: Record<string, unknown> }).signatures?.[env.SERVER_NAME];
  leaveEvent['signatures'] = {
    ...((leaveEvent['signatures'] as Record<string, unknown> | undefined) ?? {}),
    ...(ourSig ? { [env.SERVER_NAME]: ourSig } : {}),
  };

  const eventId =
    typeof leaveEvent['event_id'] === 'string' && leaveEvent['event_id']
      ? leaveEvent['event_id']
      : await computeWireEventId(leaveEvent, roomVersion);
  leaveEvent['event_id'] = eventId;

  const event = leaveEvent as unknown as PDU;
  await storeEventIdempotent(env.DB, event);
  await updateMembership(env.DB, roomId, event.state_key as string, 'leave', eventId);
  await fanoutEventToAppServices(env, event);

  return eventId;
}

// Shared v1/v2 send_leave handler; both versions must verify, countersign and
// persist the leave. Only the response envelope differs.
async function handleSendLeave(c: any, version: 1 | 2) {
  const roomId = c.req.param('roomId') as string;
  const eventId = c.req.param('eventId') as string;

  let body: any;
  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  if (body.type !== 'm.room.member' || body.content?.membership !== 'leave') {
    return c.json({ errcode: 'M_INVALID_PARAM', error: 'Event is not a leave event' }, 400);
  }
  if (body.event_id && body.event_id !== eventId) {
    return c.json({ errcode: 'M_INVALID_PARAM', error: 'Event ID mismatch' }, 400);
  }

  const db = c.env.DB as D1Database;
  const room = await db.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();
  if (!room) return Errors.notFound('Room not found').toResponse();

  const origin = c.get('federationOrigin' as any) as string | undefined;
  const senderServer = serverNameFromId(typeof body.sender === 'string' ? body.sender : '');
  if (origin && (!senderServer || senderServer !== origin)) {
    return Errors.forbidden('Leave event sender does not belong to the authenticated server').toResponse();
  }
  if (!senderServer) {
    return Errors.forbidden('Leave event has no valid sender').toResponse();
  }

  const signatureError = await verifyInboundLeaveSignature(c.env, body, senderServer, room.room_version);
  if (signatureError) {
    return Errors.forbidden(`Leave event is not signed by ${senderServer}: ${signatureError}`).toResponse();
  }

  const authError = await authorizeInboundLeave(c.env, roomId, room.room_version, body, origin);
  if (authError) return Errors.forbidden(authError).toResponse();

  // MSC4284: membership events in policy-server rooms are refused outright
  // when they lack a valid countersignature, as on the send_join path.
  if (await policySignatureMissing(c, body as Record<string, unknown>, room.room_version)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The leave lacks a valid policy server signature' },
      403
    );
  }

  const storedId = await persistInboundLeave(
    c.env,
    roomId,
    body as Record<string, unknown>,
    origin,
    room.room_version
  );
  if (!storedId) return Errors.forbidden('Leave event was rejected').toResponse();

  // v1 is the legacy envelope; v2 carries the countersigned event.
  if (version === 1) return c.json({});
  return c.json({ event: toWireEventObject(body as Record<string, unknown>) });
}

// PUT /_matrix/federation/v1/send_leave/:roomId/:eventId - Complete leave
// (v1 was REMOVED from the spec in v1.18 (MSC4376) — kept here
// deliberately for older peers; v2 is the negotiated path for modern
// servers.)
app.put('/_matrix/federation/v1/send_leave/:roomId/:eventId', async (c) => handleSendLeave(c, 1));

// PUT /_matrix/federation/v2/send_leave/:roomId/:eventId - Complete leave (v2)
app.put('/_matrix/federation/v2/send_leave/:roomId/:eventId', async (c) => handleSendLeave(c, 2));

// Persist an invite received from a remote server so the invited local user
// actually sees it in /sync. The remote side is told "success" as soon as we
// return the signed event, so failures here are logged rather than
// propagated -- a storage hiccup must not break the remote room's invite
// flow (which would fail the whole DM creation upstream).
//
// Stripped state events from `invite_room_state` carry no event_id, so
// deterministic synthetic ids are derived from their content; re-invites
// overwrite cleanly (rooms are only created if missing, state events use
// idempotent inserts, membership rows are replaced).
async function storeInboundInvite(
  env: Env,
  inviteEvent: any,
  inviteRoomState: any[] | undefined,
  inviteEventIdFromUrl: string,
  origin?: string
): Promise<void> {
  try {
    const roomId: string = inviteEvent?.room_id;
    const invitee: string = inviteEvent?.state_key;
    const sender: string = typeof inviteEvent?.sender === 'string' ? inviteEvent.sender : '';
    // Remote servers may omit event_id from the signed event body (the URL
    // path carries the authoritative copy; the handler compares when present).
    const inviteEventId: string =
      typeof inviteEvent?.event_id === 'string' && inviteEvent.event_id
        ? inviteEvent.event_id
        : inviteEventIdFromUrl;
    if (!roomId || !invitee || !sender || !inviteEventId) return;

    // The inviter's event travels through the inviter's own server, so the
    // authenticated origin must match the sender's domain.
    if (origin) {
      const senderServer = sender.includes(':') ? sender.slice(sender.indexOf(':') + 1) : '';
      if (senderServer !== origin) {
        console.warn(
          `[federation] Rejecting inbound invite: sender ${sender} is not from origin ${origin}`
        );
        return;
      }
    }

    // Room version: prefer the create event's, else default to v10.
    const createEv = (inviteRoomState ?? []).find((ev: any) => ev?.type === 'm.room.create');
    const roomVersion: string =
      typeof createEv?.content?.room_version === 'string' ? createEv.content.room_version : '10';

    const existing = await getRoom(env.DB, roomId);
    if (!existing) {
      await createRoom(env.DB, roomId, roomVersion, sender);
    }

    // Store the stripped invite_room_state so the room renders with its
    // name/topic/avatar/join_rules for the invited user.
    for (const ev of inviteRoomState ?? []) {
      if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') continue;
      const stateKey = typeof ev.state_key === 'string' ? ev.state_key : '';
      const content = ev.content ?? {};
      const syntheticId =
        '$invite_state_' +
        (await sha256(`${roomId}|${ev.type}|${stateKey}|${JSON.stringify(content)}`)).slice(0, 32);
      await storeEventIdempotent(env.DB, {
        event_id: syntheticId,
        room_id: roomId,
        sender: typeof ev.sender === 'string' ? ev.sender : sender,
        type: ev.type,
        state_key: stateKey,
        content,
        origin_server_ts:
          typeof ev.origin_server_ts === 'number' ? ev.origin_server_ts : Date.now(),
        depth: 0,
        auth_events: [],
        prev_events: [],
      });
    }

    // Store the invite event itself and the invitee's membership row --
    // this is what makes the room appear in the user's /sync as an invite.
    const invitePdu: PDU = {
      event_id: inviteEventId,
      room_id: roomId,
      sender,
      type: typeof inviteEvent.type === 'string' ? inviteEvent.type : 'm.room.member',
      state_key: invitee,
      content: inviteEvent.content ?? {},
      origin_server_ts:
        typeof inviteEvent.origin_server_ts === 'number' ? inviteEvent.origin_server_ts : Date.now(),
      depth: typeof inviteEvent.depth === 'number' ? inviteEvent.depth : 0,
      auth_events: Array.isArray(inviteEvent.auth_events) ? inviteEvent.auth_events : [],
      prev_events: Array.isArray(inviteEvent.prev_events) ? inviteEvent.prev_events : [],
      hashes: inviteEvent.hashes,
      signatures: inviteEvent.signatures,
    };
    const { inserted } = await storeEventIdempotent(env.DB, invitePdu);

    await updateMembership(env.DB, roomId, invitee, 'invite', inviteEventId);
    if (inserted) {
      await fanoutEventToAppServices(env, invitePdu);
    }

    // Wake the invitee's long-polling sync so the invite appears immediately.
    await notifyUserSync(env, invitee, 'events');
  } catch (error) {
    console.error('[federation] Failed to store inbound invite:', error);
  }
}

// PUT /_matrix/federation/v1/invite/:roomId/:eventId - Receive invite (v1)
// Used when a remote server invites a local user to a room
app.put('/_matrix/federation/v1/invite/:roomId/:eventId', async (c) => {
  // roomId is available from route params but we validate from the event body
  void c.req.param('roomId');
  const eventId = c.req.param('eventId');

  let body: {
    room_version?: string;
    event?: any;
    invite_room_state?: any[];
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const inviteEvent = body.event || body;

  // Validate the event is an invite
  if (inviteEvent.type !== 'm.room.member' || inviteEvent.content?.membership !== 'invite') {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event is not an invite event' },
      400
    );
  }

  // Validate event ID matches
  if (inviteEvent.event_id && inviteEvent.event_id !== eventId) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event ID mismatch' },
      400
    );
  }

  // Validate the sender belongs to the authenticated origin server
  const inviteOrigin = (c as any).get('federationOrigin');
  const senderServer = inviteEvent.sender?.split(':')[1];
  if (inviteOrigin && senderServer && senderServer !== inviteOrigin) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'Sender does not belong to the authenticated origin server' },
      403
    );
  }

  // Server ACL (spec module; MSC4436): denied servers cannot invite either.
  if (
    senderServer &&
    !(await isServerAllowedInRoom(c.env.DB, inviteEvent.room_id, senderServer))
  ) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "Inviting server is denied by the room's server ACL" },
      403
    );
  }

  // MSC4284 (spec v1.18): invites in policy-server rooms must carry a
  // valid countersignature. v1 invites carry no room_version: use the
  // stored one (unknown rooms default harmlessly — no policy state).
  const v1InviteRoom = await getRoom(c.env.DB, inviteEvent.room_id);
  if (
    await policySignatureMissing(
      c, inviteEvent as unknown as Record<string, unknown>, String(v1InviteRoom?.room_version ?? '10')
    )
  ) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The invite lacks a valid policy server signature' },
      403
    );
  }

  // Moderation policy lists (spec module): banned users/servers cannot
  // invite our users.
  {
    const modRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);
    if (modRules.subscriptions > 0) {
      const bannedUser = isUserBannedByPolicy(modRules, inviteEvent.sender as string);
      const bannedServer = senderServer
        ? isServerBannedByPolicy(modRules, senderServer)
        : null;
      if (bannedUser || bannedServer) {
        const banReason = bannedUser?.reason || bannedServer?.reason || 'banned entity';
        return c.json(
          {
            errcode: 'M_FORBIDDEN',
            error: `The inviter is banned by a moderation policy list (${banReason})`,
          },
          403
        );
      }
    }
  }

  // Validate the invite is for a local user
  const stateKey = inviteEvent.state_key;
  if (!stateKey || !stateKey.includes(':')) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Invalid state_key for invite' },
      400
    );
  }

  const invitedServer = stateKey.split(':')[1];
  if (invitedServer !== c.env.SERVER_NAME) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'User is not local to this server' },
      403
    );
  }

  // Check if user exists locally
  const localUser = await c.env.DB.prepare(
    `SELECT user_id FROM users WHERE user_id = ?`
  ).bind(stateKey).first<{ user_id: string }>();

  if (!localUser) {
    return c.json(
      { errcode: 'M_NOT_FOUND', error: 'User not found' },
      404
    );
  }

  // MSC4155: the local recipient's invite permission config applies to
  // federation invites too.
  if ((await getInvitePermission(c.env.DB, stateKey, inviteEvent.sender)) === 'block') {
    return c.json(
      { errcode: 'M_INVITE_BLOCKED', error: 'The recipient does not accept invites from this sender' },
      403
    );
  }

  // Persist the invite locally so the invited user sees it in /sync.
  await storeInboundInvite(
    c.env,
    inviteEvent,
    body.invite_room_state,
    eventId,
    c.get('federationOrigin' as any) as string | undefined
  );

  // Sign the invite event and return it
  // Get our signing key
  const key = await c.env.DB.prepare(
    `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`
  ).first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'Server signing key not configured' },
      500
    );
  }

  // Sign the event
  const signedEvent = await signJson(
    inviteEvent,
    c.env.SERVER_NAME,
    key.key_id,
    JSON.parse(key.private_key_jwk)
  );

  // v1 returns the signed event directly
  return c.json([200, signedEvent]);
});

// PUT /_matrix/federation/v2/invite/:roomId/:eventId - Receive invite (v2)
app.put('/_matrix/federation/v2/invite/:roomId/:eventId', async (c) => {
  // roomId is available from route params but we validate from the event body
  void c.req.param('roomId');
  const eventId = c.req.param('eventId');

  let body: {
    room_version: string;
    event: any;
    invite_room_state?: any[];
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const roomVersion = body.room_version;
  const inviteEvent = body.event;

  if (!roomVersion) {
    return Errors.missingParam('room_version').toResponse();
  }

  if (!inviteEvent) {
    return Errors.missingParam('event').toResponse();
  }

  // Check room version is supported
  if (!SUPPORTED_ROOM_VERSIONS.includes(roomVersion)) {
    return c.json(
      { errcode: 'M_INCOMPATIBLE_ROOM_VERSION', error: `Unsupported room version: ${roomVersion}` },
      400
    );
  }

  // Validate the event is an invite
  if (inviteEvent.type !== 'm.room.member' || inviteEvent.content?.membership !== 'invite') {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event is not an invite event' },
      400
    );
  }

  // Validate event ID matches
  if (inviteEvent.event_id && inviteEvent.event_id !== eventId) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Event ID mismatch' },
      400
    );
  }

  // Validate the sender belongs to the authenticated origin server
  const v2InviteOrigin = (c as any).get('federationOrigin');
  const v2SenderServer = inviteEvent.sender?.split(':')[1];
  if (v2InviteOrigin && v2SenderServer && v2SenderServer !== v2InviteOrigin) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'Sender does not belong to the authenticated origin server' },
      403
    );
  }

  // Server ACL (spec module; MSC4436): denied servers cannot invite either.
  if (
    v2SenderServer &&
    !(await isServerAllowedInRoom(c.env.DB, inviteEvent.room_id, v2SenderServer))
  ) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "Inviting server is denied by the room's server ACL" },
      403
    );
  }

  // MSC4284 (spec v1.18): invites in policy-server rooms must carry a
  // valid countersignature (membership events are refused, not soft-failed).
  if (
    await policySignatureMissing(
      c, inviteEvent as unknown as Record<string, unknown>, roomVersion
    )
  ) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The invite lacks a valid policy server signature' },
      403
    );
  }

  // Moderation policy lists (spec module): banned users/servers cannot
  // invite our users.
  {
    const modRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);
    if (modRules.subscriptions > 0) {
      const bannedUser = isUserBannedByPolicy(modRules, inviteEvent.sender as string);
      const bannedServer = v2SenderServer
        ? isServerBannedByPolicy(modRules, v2SenderServer)
        : null;
      if (bannedUser || bannedServer) {
        const banReason = bannedUser?.reason || bannedServer?.reason || 'banned entity';
        return c.json(
          {
            errcode: 'M_FORBIDDEN',
            error: `The inviter is banned by a moderation policy list (${banReason})`,
          },
          403
        );
      }
    }
  }

  // Validate the invite is for a local user
  const stateKey = inviteEvent.state_key;
  if (!stateKey || !stateKey.includes(':')) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'Invalid state_key for invite' },
      400
    );
  }

  const invitedServer = stateKey.split(':')[1];
  if (invitedServer !== c.env.SERVER_NAME) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'User is not local to this server' },
      403
    );
  }

  // Check if user exists locally
  const localUser = await c.env.DB.prepare(
    `SELECT user_id FROM users WHERE user_id = ?`
  ).bind(stateKey).first<{ user_id: string }>();

  if (!localUser) {
    return c.json(
      { errcode: 'M_NOT_FOUND', error: 'User not found' },
      404
    );
  }

  // MSC4155: the local recipient's invite permission config applies to
  // federation invites too.
  if ((await getInvitePermission(c.env.DB, stateKey, inviteEvent.sender)) === 'block') {
    return c.json(
      { errcode: 'M_INVITE_BLOCKED', error: 'The recipient does not accept invites from this sender' },
      403
    );
  }

  // Persist the invite locally so the invited user sees it in /sync.
  await storeInboundInvite(
    c.env,
    inviteEvent,
    body.invite_room_state,
    eventId,
    c.get('federationOrigin' as any) as string | undefined
  );

  // Sign the invite event and return it
  const key = await c.env.DB.prepare(
    `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`
  ).first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'Server signing key not configured' },
      500
    );
  }

  // Sign the event
  const signedEvent = await signJson(
    inviteEvent,
    c.env.SERVER_NAME,
    key.key_id,
    JSON.parse(key.private_key_jwk)
  );

  // v2 returns { event: signedEvent }
  return c.json({ event: signedEvent });
});

// GET /_matrix/federation/v1/query/directory - Resolve room alias
app.get('/_matrix/federation/v1/query/directory', async (c) => {
  const alias = c.req.query('room_alias');

  if (!alias) {
    return Errors.missingParam('room_alias').toResponse();
  }

  const roomId = await c.env.DB.prepare(
    `SELECT room_id FROM room_aliases WHERE alias = ?`
  ).bind(alias).first<{ room_id: string }>();

  if (!roomId) {
    return Errors.notFound('Room alias not found').toResponse();
  }

  return c.json({
    room_id: roomId.room_id,
    servers: [c.env.SERVER_NAME],
  });
});

// GET /_matrix/federation/v1/query/profile - Query user profile
app.get('/_matrix/federation/v1/query/profile', async (c) => {
  const userId = c.req.query('user_id');
  const field = c.req.query('field');

  if (!userId) {
    return Errors.missingParam('user_id').toResponse();
  }

  const user = await c.env.DB.prepare(
    `SELECT display_name, avatar_url FROM users WHERE user_id = ?`
  ).bind(userId).first<{ display_name: string | null; avatar_url: string | null }>();

  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  if (field === 'displayname') {
    return c.json({ displayname: user.display_name });
  } else if (field === 'avatar_url') {
    return c.json({ avatar_url: user.avatar_url });
  }

  return c.json({
    displayname: user.display_name,
    avatar_url: user.avatar_url,
  });
});

// ============================================
// Federation E2EE Endpoints
// Required for cross-server encrypted messaging
// ============================================

// Helper to get UserKeys Durable Object for a user
function getUserKeysDO(env: typeof app extends Hono<infer E> ? E['Bindings'] : never, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

// Helper to get device keys from Durable Object
async function getDeviceKeysFromDO(env: typeof app extends Hono<infer E> ? E['Bindings'] : never, userId: string, deviceId?: string): Promise<any> {
  const stub = getUserKeysDO(env, userId);
  const url = deviceId
    ? `http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`
    : 'http://internal/device-keys/get';
  const response = await stub.fetch(new Request(url));
  if (!response.ok) {
    return deviceId ? null : {};
  }
  return await response.json();
}

// Helper to get cross-signing keys from Durable Object
async function getCrossSigningKeysFromDO(env: typeof app extends Hono<infer E> ? E['Bindings'] : never, userId: string): Promise<{
  master?: any;
  self_signing?: any;
  user_signing?: any;
}> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(new Request('http://internal/cross-signing/get'));
  if (!response.ok) {
    return {};
  }
  return await response.json();
}

// POST /_matrix/federation/v1/user/keys/query - Query device keys for local users
// This endpoint is called by remote servers to get device keys for E2EE
app.post('/_matrix/federation/v1/user/keys/query', async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    device_keys?: Record<string, string[]>;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.device_keys;
  if (!requestedKeys || typeof requestedKeys !== 'object') {
    return Errors.missingParam('device_keys').toResponse();
  }

  const deviceKeys: Record<string, Record<string, any>> = {};
  const masterKeys: Record<string, any> = {};
  const selfSigningKeys: Record<string, any> = {};

  // Helper to merge signatures from D1 into device keys
  async function mergeSignaturesForDevice(userId: string, deviceId: string, deviceKey: any): Promise<any> {
    const dbSignatures = await db.prepare(`
      SELECT signer_user_id, signer_key_id, signature
      FROM cross_signing_signatures
      WHERE user_id = ? AND key_id = ?
    `).bind(userId, deviceId).all<{
      signer_user_id: string;
      signer_key_id: string;
      signature: string;
    }>();

    if (dbSignatures.results.length > 0) {
      deviceKey.signatures = deviceKey.signatures || {};
      for (const sig of dbSignatures.results) {
        deviceKey.signatures[sig.signer_user_id] = deviceKey.signatures[sig.signer_user_id] || {};
        deviceKey.signatures[sig.signer_user_id][sig.signer_key_id] = sig.signature;
      }
    }

    return deviceKey;
  }

  for (const [userId, requestedDevices] of Object.entries(requestedKeys)) {
    // Verify user is local to this server
    const userServerName = userId.split(':')[1];
    if (userServerName !== serverName) {
      // Skip non-local users - federation should query their home server
      continue;
    }

    // Check if user exists locally
    const user = await db.prepare(
      `SELECT user_id FROM users WHERE user_id = ?`
    ).bind(userId).first<{ user_id: string }>();

    if (!user) {
      continue;
    }

    deviceKeys[userId] = {};

    // Get device keys from Durable Object (strongly consistent)
    if (!requestedDevices || requestedDevices.length === 0) {
      // Get all devices for this user
      const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);
      for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    } else {
      // Get specific devices
      for (const deviceId of requestedDevices) {
        const keys = await getDeviceKeysFromDO(c.env, userId, deviceId);
        if (keys) {
          deviceKeys[userId][deviceId] = await mergeSignaturesForDevice(userId, deviceId, keys);
        }
      }
    }

    // Get cross-signing keys (master + self_signing only for federation)
    // Note: user_signing key is NOT included in federation responses per spec
    const csKeys = await getCrossSigningKeysFromDO(c.env, userId);

    if (csKeys.master) {
      masterKeys[userId] = csKeys.master;
    }
    if (csKeys.self_signing) {
      selfSigningKeys[userId] = csKeys.self_signing;
    }
  }

  return c.json({
    device_keys: deviceKeys,
    master_keys: masterKeys,
    self_signing_keys: selfSigningKeys,
  });
});

// POST /_matrix/federation/v1/user/keys/claim - Claim one-time keys for E2EE session establishment
// Remote servers call this to get OTKs to establish encrypted sessions with local users
app.post('/_matrix/federation/v1/user/keys/claim', async (c) => {
  const serverName = c.env.SERVER_NAME;
  const db = c.env.DB;

  let body: {
    one_time_keys?: Record<string, Record<string, string>>;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const requestedKeys = body.one_time_keys;
  if (!requestedKeys || typeof requestedKeys !== 'object') {
    return Errors.missingParam('one_time_keys').toResponse();
  }

  const oneTimeKeys: Record<string, Record<string, Record<string, any>>> = {};

  for (const [userId, devices] of Object.entries(requestedKeys)) {
    // Verify user is local to this server
    const userServerName = userId.split(':')[1];
    if (userServerName !== serverName) {
      continue;
    }

    oneTimeKeys[userId] = {};

    for (const [deviceId, algorithm] of Object.entries(devices)) {
      // Try to claim a one-time key from KV first (fast path)
      const existingKeys = await c.env.ONE_TIME_KEYS.get(
        `otk:${userId}:${deviceId}`,
        'json'
      ) as Record<string, { keyId: string; keyData: any; claimed: boolean }[]> | null;

      let foundKey = false;

      if (existingKeys && existingKeys[algorithm]) {
        // Find first unclaimed key
        const keyIndex = existingKeys[algorithm].findIndex(k => !k.claimed);
        if (keyIndex >= 0) {
          const key = existingKeys[algorithm][keyIndex];
          // Mark as claimed
          existingKeys[algorithm][keyIndex].claimed = true;

          // Save back to KV
          await c.env.ONE_TIME_KEYS.put(
            `otk:${userId}:${deviceId}`,
            JSON.stringify(existingKeys)
          );

          // Also mark in D1
          await db.prepare(`
            UPDATE one_time_keys SET claimed = 1, claimed_at = ?
            WHERE user_id = ? AND device_id = ? AND key_id = ?
          `).bind(Date.now(), userId, deviceId, key.keyId).run();

          oneTimeKeys[userId][deviceId] = {
            [key.keyId]: key.keyData,
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        // Fallback to D1 for keys not in KV
        const otk = await db.prepare(`
          SELECT id, key_id, key_data FROM one_time_keys
          WHERE user_id = ? AND device_id = ? AND algorithm = ? AND claimed = 0
          LIMIT 1
        `).bind(userId, deviceId, algorithm).first<{
          id: number;
          key_id: string;
          key_data: string;
        }>();

        if (otk) {
          // Mark as claimed
          await db.prepare(`
            UPDATE one_time_keys SET claimed = 1, claimed_at = ? WHERE id = ?
          `).bind(Date.now(), otk.id).run();

          oneTimeKeys[userId][deviceId] = {
            [otk.key_id]: JSON.parse(otk.key_data),
          };
          foundKey = true;
        }
      }

      if (!foundKey) {
        // Try fallback key as last resort
        const fallback = await db.prepare(`
          SELECT key_id, key_data, used FROM fallback_keys
          WHERE user_id = ? AND device_id = ? AND algorithm = ?
        `).bind(userId, deviceId, algorithm).first<{
          key_id: string;
          key_data: string;
          used: number;
        }>();

        if (fallback) {
          // Mark fallback as used
          await db.prepare(`
            UPDATE fallback_keys SET used = 1 WHERE user_id = ? AND device_id = ? AND algorithm = ?
          `).bind(userId, deviceId, algorithm).run();

          const keyData = JSON.parse(fallback.key_data);
          oneTimeKeys[userId][deviceId] = {
            [fallback.key_id]: {
              ...keyData,
              fallback: true,
            },
          };
        }
      }
    }
  }

  return c.json({
    one_time_keys: oneTimeKeys,
  });
});

// GET /_matrix/federation/v1/user/devices/:userId - Get device list for a local user
// Remote servers call this to get the list of devices for a user
app.get('/_matrix/federation/v1/user/devices/:userId', async (c) => {
  const serverName = c.env.SERVER_NAME;
  const userId = c.req.param('userId');
  const db = c.env.DB;

  // Verify user is local to this server
  const userServerName = userId.split(':')[1];
  if (userServerName !== serverName) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User is not local to this server',
    }, 403);
  }

  // Check if user exists
  const user = await db.prepare(
    `SELECT user_id FROM users WHERE user_id = ?`
  ).bind(userId).first<{ user_id: string }>();

  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  // Get all devices from D1 (for display names)
  const dbDevices = await db.prepare(
    `SELECT device_id, display_name FROM devices WHERE user_id = ?`
  ).bind(userId).all<{ device_id: string; display_name: string | null }>();

  // Get device keys from Durable Object (strongly consistent)
  const allDeviceKeys = await getDeviceKeysFromDO(c.env, userId);

  // Get stream_id for device key changes
  const streamPosition = await db.prepare(
    `SELECT MAX(stream_position) as stream_id FROM device_key_changes WHERE user_id = ?`
  ).bind(userId).first<{ stream_id: number | null }>();

  // Build device list
  const devices: Array<{
    device_id: string;
    keys?: any;
    device_display_name?: string;
  }> = [];

  for (const dbDevice of dbDevices.results) {
    const deviceKeys = allDeviceKeys[dbDevice.device_id];
    devices.push({
      device_id: dbDevice.device_id,
      keys: deviceKeys || undefined,
      device_display_name: dbDevice.display_name || undefined,
    });
  }

  // Get cross-signing keys (master + self_signing only for federation)
  const csKeys = await getCrossSigningKeysFromDO(c.env, userId);

  const response: any = {
    user_id: userId,
    stream_id: streamPosition?.stream_id || 0,
    devices,
  };

  // Add cross-signing keys if present
  if (csKeys.master) {
    response.master_key = csKeys.master;
  }
  if (csKeys.self_signing) {
    response.self_signing_key = csKeys.self_signing;
  }

  return c.json(response);
});

// ============================================
// Knock Protocol Endpoints
// Allows users to request to join rooms
// ============================================

// GET /_matrix/federation/v1/make_knock/:roomId/:userId - Prepare knock request
// Remote servers call this to get a knock event template
app.get('/_matrix/federation/v1/make_knock/:roomId/:userId', async (c) => {
  const roomId = c.req.param('roomId');
  const userId = c.req.param('userId');
  const db = c.env.DB;

  // Check if room exists
  const room = await db.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get join_rules to verify room allows knocking
  const joinRulesEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ content: string }>();

  if (joinRulesEvent) {
    const joinRules = JSON.parse(joinRulesEvent.content);
    if (joinRules.join_rule !== 'knock' && joinRules.join_rule !== 'knock_restricted') {
      return c.json({
        errcode: 'M_FORBIDDEN',
        error: 'Room does not allow knocking',
      }, 403);
    }
  } else {
    // Default join_rule is 'invite', knocking not allowed
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Room does not allow knocking',
    }, 403);
  }

  // Check if user is already banned
  const membership = await db.prepare(
    `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`
  ).bind(roomId, userId).first<{ membership: string }>();

  if (membership?.membership === 'ban') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User is banned from this room',
    }, 403);
  }

  if (membership?.membership === 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User is already a member of this room',
    }, 403);
  }

  // Get auth events for knock
  const createEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `).bind(roomId).first<{ event_id: string }>();

  const joinRulesEventId = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ event_id: string }>();

  const powerLevelsEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'
  `).bind(roomId).first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEventId) authEvents.push(joinRulesEventId.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);

  // Get latest event for prev_events
  const latestEvent = await db.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`
  ).bind(roomId).first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;

  // Create unsigned knock event template
  const eventTemplate = {
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: {
      membership: 'knock',
    },
    origin_server_ts: Date.now(),
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  return c.json({
    room_version: room.room_version,
    event: eventTemplate,
  });
});

// PUT /_matrix/federation/v1/send_knock/:roomId/:eventId - Complete knock
// Remote servers call this to finalize the knock with a signed event
app.put('/_matrix/federation/v1/send_knock/:roomId/:eventId', async (c) => {
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');
  const db = c.env.DB;

  let body: any;
  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  // Validate the event is a knock event
  if (body.type !== 'm.room.member' || body.content?.membership !== 'knock') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Event is not a knock event',
    }, 400);
  }

  // Validate the event ID matches
  if (body.event_id && body.event_id !== eventId) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Event ID mismatch',
    }, 400);
  }

  // Verify room exists
  const room = await db.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Verify room allows knocking
  const joinRulesEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ content: string }>();

  if (joinRulesEvent) {
    const joinRules = JSON.parse(joinRulesEvent.content);
    if (joinRules.join_rule !== 'knock' && joinRules.join_rule !== 'knock_restricted') {
      return c.json({
        errcode: 'M_FORBIDDEN',
        error: 'Room does not allow knocking',
      }, 403);
    }
  } else {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Room does not allow knocking',
    }, 403);
  }

  // Check if user is already banned or joined
  const userId = body.state_key;
  const membership = await db.prepare(
    `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`
  ).bind(roomId, userId).first<{ membership: string }>();

  if (membership?.membership === 'ban') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User is banned from this room',
    }, 403);
  }

  if (membership?.membership === 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User is already a member of this room',
    }, 403);
  }

  // Store the knock event
  try {
    const knockPosition = await db.prepare(
      `UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'events' RETURNING position`
    ).first<{ position: number }>();
    const knockStreamOrdering = knockPosition?.position ?? 1;

    await db.prepare(`
      INSERT OR IGNORE INTO events
      (event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth, auth_events, prev_events, hashes, signatures, stream_ordering)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      roomId,
      body.sender,
      body.type,
      body.state_key,
      JSON.stringify(body.content),
      body.origin_server_ts,
      body.depth || 0,
      JSON.stringify(body.auth_events || []),
      JSON.stringify(body.prev_events || []),
      body.hashes ? JSON.stringify(body.hashes) : null,
      body.signatures ? JSON.stringify(body.signatures) : null,
      knockStreamOrdering
    ).run();

    // Update room state
    await db.prepare(`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (?, ?, ?, ?)
    `).bind(roomId, body.type, body.state_key, eventId).run();

    // Update memberships table
    await db.prepare(`
      INSERT OR REPLACE INTO room_memberships (room_id, user_id, membership, event_id)
      VALUES (?, ?, 'knock', ?)
    `).bind(roomId, userId, eventId).run();
  } catch (e) {
    console.error(`Failed to store knock event ${eventId}:`, e);
  }

  // Return stripped state events (room name, avatar, join_rules, canonical_alias)
  const strippedState: any[] = [];

  // Get room name
  const nameEvent = await db.prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender, e.origin_server_ts
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
  `).bind(roomId).first<{
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
    origin_server_ts: number;
  }>();

  if (nameEvent) {
    strippedState.push({
      type: nameEvent.event_type,
      state_key: nameEvent.state_key,
      content: JSON.parse(nameEvent.content),
      sender: nameEvent.sender,
    });
  }

  // Get room avatar
  const avatarEvent = await db.prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
  `).bind(roomId).first<{
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
  }>();

  if (avatarEvent) {
    strippedState.push({
      type: avatarEvent.event_type,
      state_key: avatarEvent.state_key,
      content: JSON.parse(avatarEvent.content),
      sender: avatarEvent.sender,
    });
  }

  // Get join_rules
  if (joinRulesEvent) {
    const joinRulesEventFull = await db.prepare(`
      SELECT e.event_type, e.state_key, e.content, e.sender
      FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
    `).bind(roomId).first<{
      event_type: string;
      state_key: string;
      content: string;
      sender: string;
    }>();

    if (joinRulesEventFull) {
      strippedState.push({
        type: joinRulesEventFull.event_type,
        state_key: joinRulesEventFull.state_key,
        content: JSON.parse(joinRulesEventFull.content),
        sender: joinRulesEventFull.sender,
      });
    }
  }

  // Get canonical alias
  const aliasEvent = await db.prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
  `).bind(roomId).first<{
    event_type: string;
    state_key: string;
    content: string;
    sender: string;
  }>();

  if (aliasEvent) {
    strippedState.push({
      type: aliasEvent.event_type,
      state_key: aliasEvent.state_key,
      content: JSON.parse(aliasEvent.content),
      sender: aliasEvent.sender,
    });
  }

  return c.json({
    knock_room_state: strippedState,
  });
});

// ============================================
// Federation Media Endpoints
// Serve local media to remote servers
// ============================================

// GET /_matrix/federation/v1/media/download/:mediaId - Download media via federation
app.get('/_matrix/federation/v1/media/download/:mediaId', async (c) => {
  const mediaId = c.req.param('mediaId');

  // Get media from R2
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // Get metadata from D1
  const metadata = await c.env.DB.prepare(
    `SELECT content_type, filename FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string; filename: string | null }>();

  const headers = new Headers();
  headers.set('Content-Type', metadata?.content_type || 'application/octet-stream');
  if (metadata?.filename) {
    headers.set('Content-Disposition', `inline; filename="${metadata.filename}"`);
  }
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');

  return new Response(object.body, { headers });
});

// GET /_matrix/federation/v1/media/thumbnail/:mediaId - Get thumbnail via federation
app.get('/_matrix/federation/v1/media/thumbnail/:mediaId', async (c) => {
  const mediaId = c.req.param('mediaId');
  const width = Math.min(parseInt(c.req.query('width') || '96'), 1920);
  const height = Math.min(parseInt(c.req.query('height') || '96'), 1920);
  const method = c.req.query('method') || 'scale';

  // Get media metadata
  const metadata = await c.env.DB.prepare(
    `SELECT content_type FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string }>();

  if (!metadata) {
    return Errors.notFound('Media not found').toResponse();
  }

  const isImage = metadata.content_type.startsWith('image/');

  // Check for pre-generated thumbnail
  const thumbnailKey = `thumb_${mediaId}_${width}x${height}_${method}`;
  const existingThumb = await c.env.MEDIA.get(thumbnailKey);

  if (existingThumb) {
    const headers = new Headers();
    headers.set('Content-Type', 'image/jpeg');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return new Response(existingThumb.body, { headers });
  }

  // Get original
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // If not an image, return original
  const headers = new Headers();
  headers.set('Content-Type', metadata.content_type);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (isImage) {
    headers.set('X-Thumbnail-Generated', 'false');
  }

  return new Response(object.body, { headers });
});

// ============================================
// Federation Public Rooms Directory
// ============================================

// GET /_matrix/federation/v1/publicRooms - Get public rooms
app.get('/_matrix/federation/v1/publicRooms', async (c) => {
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
  const since = c.req.query('since');
  // Note: include_all_networks reserved for future use
  void c.req.query('include_all_networks');

  // Parse since token for pagination (format: "offset_N")
  let offset = 0;
  if (since && since.startsWith('offset_')) {
    offset = parseInt(since.substring(7), 10) || 0;
  }

  // Query public rooms
  const rooms = await db.prepare(`
    SELECT r.room_id
    FROM rooms r
    WHERE r.is_public = 1
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit + 1, offset).all<{ room_id: string }>();

  const hasMore = rooms.results.length > limit;
  const roomResults = rooms.results.slice(0, limit);

  // Build room chunks
  const chunks: any[] = [];

  for (const room of roomResults) {
    const roomInfo = await getRoomPublicInfo(db, room.room_id, serverName);
    if (roomInfo) {
      chunks.push(roomInfo);
    }
  }

  // Count total
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM rooms WHERE is_public = 1
  `).first<{ count: number }>();

  const response: any = {
    chunk: chunks,
    total_room_count_estimate: totalCount?.count || 0,
  };

  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }
  if (offset > 0) {
    response.prev_batch = `offset_${Math.max(0, offset - limit)}`;
  }

  return c.json(response);
});

// POST /_matrix/federation/v1/publicRooms - Search public rooms
app.post('/_matrix/federation/v1/publicRooms', async (c) => {
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: {
    limit?: number;
    since?: string;
    filter?: { generic_search_term?: string };
    include_all_networks?: boolean;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  const limit = Math.min(body.limit || 100, 500);
  const since = body.since;
  const searchTerm = body.filter?.generic_search_term?.toLowerCase();

  // Parse since token
  let offset = 0;
  if (since && since.startsWith('offset_')) {
    offset = parseInt(since.substring(7), 10) || 0;
  }

  // Query public rooms with optional search
  let rooms;
  if (searchTerm) {
    rooms = await db.prepare(`
      SELECT DISTINCT r.room_id
      FROM rooms r
      LEFT JOIN room_state rs_name ON rs_name.room_id = r.room_id AND rs_name.event_type = 'm.room.name'
      LEFT JOIN events e_name ON rs_name.event_id = e_name.event_id
      LEFT JOIN room_state rs_topic ON rs_topic.room_id = r.room_id AND rs_topic.event_type = 'm.room.topic'
      LEFT JOIN events e_topic ON rs_topic.event_id = e_topic.event_id
      LEFT JOIN room_aliases ra ON ra.room_id = r.room_id
      WHERE r.is_public = 1
        AND (
          LOWER(e_name.content) LIKE ?
          OR LOWER(e_topic.content) LIKE ?
          OR LOWER(ra.alias) LIKE ?
        )
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`, limit + 1, offset).all<{ room_id: string }>();
  } else {
    rooms = await db.prepare(`
      SELECT r.room_id
      FROM rooms r
      WHERE r.is_public = 1
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit + 1, offset).all<{ room_id: string }>();
  }

  const hasMore = rooms.results.length > limit;
  const roomResults = rooms.results.slice(0, limit);

  // Build room chunks
  const chunks: any[] = [];

  for (const room of roomResults) {
    const roomInfo = await getRoomPublicInfo(db, room.room_id, serverName);
    if (roomInfo) {
      chunks.push(roomInfo);
    }
  }

  // Count total
  const totalCount = await db.prepare(`
    SELECT COUNT(*) as count FROM rooms WHERE is_public = 1
  `).first<{ count: number }>();

  const response: any = {
    chunk: chunks,
    total_room_count_estimate: totalCount?.count || 0,
  };

  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }
  if (offset > 0) {
    response.prev_batch = `offset_${Math.max(0, offset - limit)}`;
  }

  return c.json(response);
});

// Helper to get public room info
async function getRoomPublicInfo(db: D1Database, roomId: string, _serverName: string): Promise<any> {
  // Get room name
  const nameEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
  `).bind(roomId).first<{ content: string }>();

  // Get room topic
  const topicEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'
  `).bind(roomId).first<{ content: string }>();

  // Get canonical alias
  const aliasEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
  `).bind(roomId).first<{ content: string }>();

  // Get avatar
  const avatarEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
  `).bind(roomId).first<{ content: string }>();

  // Get join rule
  const joinRuleEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ content: string }>();

  // Get history visibility
  const historyEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.history_visibility'
  `).bind(roomId).first<{ content: string }>();

  // Get guest access
  const guestEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.guest_access'
  `).bind(roomId).first<{ content: string }>();

  // Get member count
  const memberCount = await db.prepare(`
    SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'
  `).bind(roomId).first<{ count: number }>();

  // Get room type
  const createEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `).bind(roomId).first<{ content: string }>();

  let roomType: string | undefined;
  if (createEvent) {
    try {
      const content = JSON.parse(createEvent.content);
      roomType = content.type;
    } catch {}
  }

  let historyVisibility = 'shared';
  if (historyEvent) {
    try {
      historyVisibility = JSON.parse(historyEvent.content).history_visibility;
    } catch {}
  }

  let guestAccess = false;
  if (guestEvent) {
    try {
      guestAccess = JSON.parse(guestEvent.content).guest_access === 'can_join';
    } catch {}
  }

  return {
    room_id: roomId,
    name: nameEvent ? JSON.parse(nameEvent.content).name : undefined,
    topic: topicEvent ? JSON.parse(topicEvent.content).topic : undefined,
    canonical_alias: aliasEvent ? JSON.parse(aliasEvent.content).alias : undefined,
    avatar_url: avatarEvent ? JSON.parse(avatarEvent.content).url : undefined,
    join_rule: joinRuleEvent ? JSON.parse(joinRuleEvent.content).join_rule : 'invite',
    num_joined_members: memberCount?.count || 0,
    world_readable: historyVisibility === 'world_readable',
    guest_can_join: guestAccess,
    room_type: roomType,
  };
}

// ============================================
// Federation Space Hierarchy
// ============================================

// GET /_matrix/federation/v1/hierarchy/:roomId - Get space hierarchy
app.get('/_matrix/federation/v1/hierarchy/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  const suggestedOnly = c.req.query('suggested_only') === 'true';
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const from = c.req.query('from');

  // Check if room exists
  const room = await db.prepare(`
    SELECT room_id FROM rooms WHERE room_id = ?
  `).bind(roomId).first();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Server ACL: denied servers get no room content, space hierarchies included.
  if (await callerDeniedByRoomAcl(c, roomId)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: "The calling server is denied by the room's server ACL" },
      403
    );
  }

  // Parse pagination token
  let offset = 0;
  if (from && from.startsWith('offset_')) {
    offset = parseInt(from.substring(7), 10) || 0;
  }

  // Get space children from m.space.child state events
  const childEvents = await db.prepare(`
    SELECT rs.state_key, e.content
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.space.child'
    LIMIT ? OFFSET ?
  `).bind(roomId, limit + 1, offset).all<{ state_key: string; content: string }>();

  const hasMore = childEvents.results.length > limit;
  const childResults = childEvents.results.slice(0, limit);

  const rooms: any[] = [];

  // Add the space itself first (only on first page)
  if (offset === 0) {
    const spaceInfo = await getRoomPublicInfo(db, roomId, serverName);
    if (spaceInfo) {
      const spaceChildState = await db.prepare(`
        SELECT rs.state_key, e.content
        FROM room_state rs
        JOIN events e ON rs.event_id = e.event_id
        WHERE rs.room_id = ? AND rs.event_type = 'm.space.child'
      `).bind(roomId).all<{ state_key: string; content: string }>();

      rooms.push({
        ...spaceInfo,
        children_state: spaceChildState.results.map(ce => {
          try {
            return {
              type: 'm.space.child',
              state_key: ce.state_key,
              content: JSON.parse(ce.content),
            };
          } catch {
            return null;
          }
        }).filter(Boolean),
      });
    }
  }

  // Process each child
  for (const child of childResults) {
    const childRoomId = child.state_key;

    try {
      const content = JSON.parse(child.content);

      // Skip if suggested_only and not suggested
      if (suggestedOnly && !content.suggested) {
        continue;
      }

      // Skip if content has empty via array (deleted child)
      if (!content.via || content.via.length === 0) {
        continue;
      }

      // Get child room info
      const childInfo = await getRoomPublicInfo(db, childRoomId, serverName);
      if (childInfo) {
        rooms.push({
          ...childInfo,
          children_state: [], // Grandchildren not included in federation response
        });
      }
    } catch {
      // Skip invalid child entries
    }
  }

  const response: any = {
    room: rooms[0] || null,
    children: rooms.slice(1),
    inaccessible_children: [],
  };

  if (hasMore) {
    response.next_batch = `offset_${offset + limit}`;
  }

  return c.json(response);
});

// ============================================
// Miscellaneous Federation Endpoints
// ============================================

// GET /_matrix/federation/v1/timestamp_to_event/:roomId - Find event closest to timestamp
app.get('/_matrix/federation/v1/timestamp_to_event/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const ts = parseInt(c.req.query('ts') || '0', 10);
  const dir = c.req.query('dir') || 'f'; // 'f' = forward, 'b' = backward
  const db = c.env.DB;

  if (!ts || ts <= 0) {
    return Errors.missingParam('ts').toResponse();
  }

  // Verify room exists
  const room = await db.prepare(
    `SELECT room_id, room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  let event;
  if (dir === 'b') {
    // Find closest event at or before timestamp
    event = await db.prepare(`
      SELECT event_id, origin_server_ts
      FROM events
      WHERE room_id = ? AND origin_server_ts <= ?
      ORDER BY origin_server_ts DESC
      LIMIT 1
    `).bind(roomId, ts).first<{ event_id: string; origin_server_ts: number }>();
  } else {
    // Find closest event at or after timestamp
    event = await db.prepare(`
      SELECT event_id, origin_server_ts
      FROM events
      WHERE room_id = ? AND origin_server_ts >= ?
      ORDER BY origin_server_ts ASC
      LIMIT 1
    `).bind(roomId, ts).first<{ event_id: string; origin_server_ts: number }>();
  }

  if (!event) {
    return Errors.notFound('No event found near timestamp').toResponse();
  }

  return c.json({
    event_id: event.event_id,
    origin_server_ts: event.origin_server_ts,
  });
});

// GET /_matrix/federation/v1/openid/userinfo - Validate OpenID token and return user info
app.get('/_matrix/federation/v1/openid/userinfo', async (c) => {
  const accessToken = c.req.query('access_token');

  if (!accessToken) {
    return Errors.missingParam('access_token').toResponse();
  }

  // Look up the OpenID token in KV
  const tokenData = await c.env.SESSIONS.get(`openid:${accessToken}`, 'json') as {
    user_id: string;
    expires_at: number;
  } | null;

  if (!tokenData) {
    return c.json({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'Invalid or expired OpenID token',
    }, 401);
  }

  // Check if token has expired
  if (Date.now() > tokenData.expires_at) {
    // Clean up expired token
    await c.env.SESSIONS.delete(`openid:${accessToken}`);
    return c.json({
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'OpenID token has expired',
    }, 401);
  }

  return c.json({
    sub: tokenData.user_id,
  });
});

// PUT /_matrix/federation/v1/exchange_third_party_invite/:roomId - Exchange 3PID invite
// Handles third-party invites when a user accepts an invite via their verified email/phone
app.put('/_matrix/federation/v1/exchange_third_party_invite/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: {
    type: string;
    room_id: string;
    sender: string;
    state_key: string;
    content: {
      membership: string;
      third_party_invite?: {
        display_name?: string;
        signed: {
          mxid: string;
          token: string;
          signatures: Record<string, Record<string, string>>;
        };
      };
    };
    origin_server_ts?: number;
    depth?: number;
    auth_events?: string[];
    prev_events?: string[];
    event_id?: string;
    signatures?: Record<string, Record<string, string>>;
  };

  try {
    body = await getFederationBody(c);
  } catch {
    return Errors.badJson().toResponse();
  }

  // Validate this is a membership invite
  if (body.type !== 'm.room.member' || body.content?.membership !== 'invite') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Event must be a membership invite',
    }, 400);
  }

  // Validate room ID matches
  if (body.room_id !== roomId) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Room ID mismatch',
    }, 400);
  }

  // Validate third_party_invite is present
  const thirdPartyInvite = body.content.third_party_invite;
  if (!thirdPartyInvite || !thirdPartyInvite.signed) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Missing third_party_invite or signed data',
    }, 400);
  }

  const { mxid, token, signatures } = thirdPartyInvite.signed;
  if (!mxid || !token || !signatures) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Incomplete signed data in third_party_invite',
    }, 400);
  }

  // Verify room exists
  const room = await db.prepare(`
    SELECT room_id, room_version FROM rooms WHERE room_id = ?
  `).bind(roomId).first<{ room_id: string; room_version: string }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Find the matching m.room.third_party_invite state event
  const thirdPartyInviteEvent = await db.prepare(`
    SELECT e.event_id, e.content, e.sender, e.state_key
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.third_party_invite' AND rs.state_key = ?
  `).bind(roomId, token).first<{
    event_id: string;
    content: string;
    sender: string;
    state_key: string;
  }>();

  if (!thirdPartyInviteEvent) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'No third party invite found with matching token',
    }, 403);
  }

  // Parse the third-party invite content to get the public keys
  let inviteContent: {
    display_name?: string;
    key_validity_url?: string;
    public_key?: string;
    public_keys?: Array<{ public_key: string; key_validity_url?: string }>;
  };

  try {
    inviteContent = JSON.parse(thirdPartyInviteEvent.content);
  } catch {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'Invalid third party invite content',
    }, 400);
  }

  // Verify the signature against the public keys in the invite
  // The signed object format is: { mxid, sender, token, signatures }
  // where sender is from the original third_party_invite event
  const signedDataForVerification: Record<string, unknown> = {
    mxid,
    sender: thirdPartyInviteEvent.sender,
    token,
    signatures,
  };

  let signatureValid = false;
  const publicKeys = inviteContent.public_keys || [];
  if (inviteContent.public_key) {
    publicKeys.push({ public_key: inviteContent.public_key });
  }

  // Try to verify with each public key
  for (const keyInfo of publicKeys) {
    const publicKey = keyInfo.public_key;
    if (!publicKey) continue;

    // Look for a signature from the identity server
    // Signatures are keyed by server name (typically the identity server)
    for (const [signingServer, keySignatures] of Object.entries(signatures)) {
      for (const [keyId, signature] of Object.entries(keySignatures)) {
        if (!signature) continue;

        try {
          // Verify the Ed25519 signature using the public key from the invite
          const isValid = await verifySignature(
            signedDataForVerification,
            signingServer,
            keyId,
            publicKey
          );

          if (isValid) {
            signatureValid = true;
            break;
          }
        } catch (e) {
          console.warn(`Failed to verify signature from ${signingServer}:${keyId}:`, e);
        }
      }
      if (signatureValid) break;
    }
    if (signatureValid) break;
  }

  if (!signatureValid) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Could not verify third party invite signature',
    }, 403);
  }

  // Verify the mxid matches the state_key
  if (mxid !== body.state_key) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'mxid does not match state_key',
    }, 400);
  }

  // Get our signing key
  const key = await db.prepare(
    `SELECT key_id, private_key_jwk FROM server_keys WHERE is_current = 1 AND key_version = 2`
  ).first<{ key_id: string; private_key_jwk: string | null }>();

  if (!key || !key.private_key_jwk) {
    return c.json({
      errcode: 'M_UNKNOWN',
      error: 'Server signing key not configured',
    }, 500);
  }

  // Get auth events for the invite
  const createEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `).bind(roomId).first<{ event_id: string }>();

  const joinRulesEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ event_id: string }>();

  const powerLevelsEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'
  `).bind(roomId).first<{ event_id: string }>();

  const senderMembershipEvent = await db.prepare(`
    SELECT e.event_id FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?
  `).bind(roomId, body.sender).first<{ event_id: string }>();

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (senderMembershipEvent) authEvents.push(senderMembershipEvent.event_id);
  authEvents.push(thirdPartyInviteEvent.event_id);

  // Get latest event for prev_events
  const latestEvent = await db.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1`
  ).bind(roomId).first<{ event_id: string; depth: number }>();

  const prevEvents = latestEvent ? [latestEvent.event_id] : [];
  const depth = (latestEvent?.depth || 0) + 1;
  const originServerTs = Date.now();

  // Create the invite event
  const inviteEvent = {
    room_id: roomId,
    sender: body.sender,
    type: 'm.room.member',
    state_key: mxid,
    content: {
      membership: 'invite',
      third_party_invite: {
        display_name: inviteContent.display_name || thirdPartyInvite.display_name,
        signed: thirdPartyInvite.signed,
      },
    },
    origin_server_ts: originServerTs,
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Calculate event ID (for room versions 1-3, event_id is computed differently)
  // For room versions 4+, event_id is computed from the content hash
  const eventIdHash = await sha256(JSON.stringify({
    ...inviteEvent,
    origin: serverName,
  }));
  const eventId = body.event_id || `$${eventIdHash}`;

  // Sign the event
  const signedEvent = await signJson(
    { ...inviteEvent, event_id: eventId },
    serverName,
    key.key_id,
    JSON.parse(key.private_key_jwk)
  );

  // Store the event
  try {
    const invitePosition = await db.prepare(
      `UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'events' RETURNING position`
    ).first<{ position: number }>();
    const inviteStreamOrdering = invitePosition?.position ?? 1;

    await db.prepare(`
      INSERT OR IGNORE INTO events
      (event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth, auth_events, prev_events, signatures, stream_ordering)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      roomId,
      body.sender,
      'm.room.member',
      mxid,
      JSON.stringify(inviteEvent.content),
      originServerTs,
      depth,
      JSON.stringify(authEvents),
      JSON.stringify(prevEvents),
      JSON.stringify((signedEvent as any).signatures),
      inviteStreamOrdering
    ).run();

    // Update room state
    await db.prepare(`
      INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
      VALUES (?, 'm.room.member', ?, ?)
    `).bind(roomId, mxid, eventId).run();

    // Update memberships table
    await db.prepare(`
      INSERT OR REPLACE INTO room_memberships (room_id, user_id, membership, event_id, display_name)
      VALUES (?, ?, 'invite', ?, ?)
    `).bind(roomId, mxid, eventId, inviteContent.display_name || null).run();

    // Delete the third party invite state event (it's been consumed)
    await db.prepare(`
      DELETE FROM room_state
      WHERE room_id = ? AND event_type = 'm.room.third_party_invite' AND state_key = ?
    `).bind(roomId, token).run();
  } catch (e) {
    console.error('Failed to store third party invite exchange event:', e);
    return c.json({
      errcode: 'M_UNKNOWN',
      error: 'Failed to store invite event',
    }, 500);
  }

  return c.json({});
});

// POST /_matrix/policy/v1/sign - MSC4284 (spec v1.18)
//
// This server acting AS a Policy Server. A 200 means the event is
// recommended for inclusion and carries our countersignature (always
// keyed ed25519:policy_server); anything else is a refusal. What we
// check is an implementation detail — the current policy is permissive:
// known room + caller allowed by the room's server ACL. Per-room rules
// can layer in later without touching the contract.
//
// The spec marks this endpoint rate-limited: one bucket per calling
// server (federationOriginRateLimit) so a flood from one server cannot
// crowd out the rest.
app.post('/_matrix/policy/v1/sign', federationOriginRateLimit(120, 60_000), async (c) => {
  let event: Record<string, unknown>;
  try {
    event = (await getFederationBody(c)) as Record<string, unknown>;
  } catch {
    return c.json({ errcode: 'M_NOT_JSON', error: 'Request body was not JSON' }, 400);
  }

  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.room_id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.sender !== 'string' ||
    !event.content ||
    typeof event.content !== 'object'
  ) {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'The supplied PDU-formatted event was improperly formatted' },
      400
    );
  }

  // The m.room.policy state event itself is never signed by policy
  // servers — it is what disables us.
  if (eventExemptFromPolicy(event)) {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'The m.room.policy state event is not signed by policy servers' },
      400
    );
  }

  const room = await getRoom(c.env.DB, event.room_id as string);
  if (!room) {
    return c.json(
      { errcode: 'M_NOT_FOUND', error: 'The room is not known to this policy server' },
      404
    );
  }

  // Optional per spec: respect the room's server ACL for callers. A PS
  // that does not track the DAG may skip this; we do track rooms.
  const origin = (c as any).get('federationOrigin') as string | undefined;
  if (origin && !(await isServerAllowedInRoom(c.env.DB, event.room_id as string, origin))) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'The calling server is denied by the room ACL' },
      403
    );
  }

  const signatures = await signEventAsPolicyServer(
    c.env.DB,
    c.env.SERVER_NAME,
    event,
    String(room.room_version ?? '10')
  );
  if (!signatures) {
    console.error('[policy] signing key unavailable');
    return c.json({ errcode: 'M_UNKNOWN', error: 'Policy server key unavailable' }, 500);
  }

  return c.json(signatures);
});

export default app;
