// Matrix room endpoints

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Env, RoomCreateContent, RoomMemberContent, PDU } from '../types';
import { Errors, MatrixApiError } from '../utils/errors';
import type { ErrorCode } from '../types';
import { askPolicyServerSignature, attachPolicySignature, eventExemptFromPolicy, getRoomPolicyServer, verifyPolicySignature } from '../services/policy-server';
import { requireAuth } from '../middleware/auth';
import { generateRoomId, generateEventId, generateDeterministicEventId, formatRoomAlias, generateOpaqueId, parseUserId } from '../utils/ids';
import { invalidateRoomCache, bumpRoomCacheGeneration } from '../services/room-cache';
import { isRoomVersionSupported, getDefaultRoomVersion } from '../services/room-versions';
import { MSC4583_ROOM_VERSION } from './msc4583';
import { applyEventRedaction } from '../services/event-redaction';
import { calculateContentHash, sha256 } from '../utils/crypto';
import { computeEventReferenceHash, isMsc4291RoomVersion, msc4291CreateEventId, msc4291RoomId } from '../utils/event-signing';
import { federationGet } from '../services/federation-keys';
import { getEffectiveUserPowerLevel, expectedAuthTypes } from '../services/event-auth';
import { evaluateRestrictedJoin } from '../services/restricted-joins';
import { augmentAuthEvents, legacyWireForRoom, prepareOutboundPdu } from '../services/event-wire';
import { fanoutEventToAppServices } from '../services/appservice-fanout';
import { isServerAllowedByAcl, isServerAllowedInRoom, serverNameFromId, type ServerAclContent } from '../services/server-acl';
import {
  getActivePolicyRules,
  isRoomBannedByPolicy,
  isServerBannedByPolicy,
  isUserBannedByPolicy,
} from '../services/moderation-policy';
import {
  createRoom,
  getRoom,
  storeEvent,
  storeEventIdempotent,
  getRoomState,
  getStateEvent,
  getRoomEvents,
  updateMembership,
  tryInsertJoinMembership,
  getMembership,
  getUserRooms,
  getRoomMembers,
  createRoomAlias,
  getRoomByAlias,
  deleteRoomAlias,
  getEvent,
  getUserById,
  notifyUsersOfEvent,
  validateEventSize,
  getInvitePermission,
} from '../services/database';
import type { JoinResult } from '../workflows';

const app = new Hono<AppEnv>();

// Validation for initial_state events
interface StateEventValidation {
  valid: boolean;
  error?: string;
}

/** Exported for unit tests. */
export function validateStateEvent(event: any, index: number): StateEventValidation {
  // Must be an object
  if (!event || typeof event !== 'object') {
    return { valid: false, error: `initial_state[${index}]: must be an object` };
  }

  // Must have a type property that is a non-empty string
  if (!event.type || typeof event.type !== 'string' || event.type.trim() === '') {
    return { valid: false, error: `initial_state[${index}]: missing or invalid 'type' property` };
  }

  // state_key must be a string if provided (can be empty string)
  if (event.state_key !== undefined && typeof event.state_key !== 'string') {
    return { valid: false, error: `initial_state[${index}]: 'state_key' must be a string` };
  }

  // content must be an object
  if (!event.content || typeof event.content !== 'object' || Array.isArray(event.content)) {
    return { valid: false, error: `initial_state[${index}]: missing or invalid 'content' property` };
  }

  // Disallow certain event types that are created automatically
  const disallowedTypes = ['m.room.create', 'm.room.member', 'm.room.power_levels'];
  if (disallowedTypes.includes(event.type)) {
    return { valid: false, error: `initial_state[${index}]: '${event.type}' cannot be set via initial_state` };
  }

  // Validate m.room.encryption content
  if (event.type === 'm.room.encryption') {
    if (!event.content.algorithm || typeof event.content.algorithm !== 'string') {
      return { valid: false, error: `initial_state[${index}]: m.room.encryption requires 'algorithm'` };
    }
    // Only m.megolm.v1.aes-sha2 is widely supported
    const supportedAlgorithms = ['m.megolm.v1.aes-sha2'];
    if (!supportedAlgorithms.includes(event.content.algorithm)) {
      return { valid: false, error: `initial_state[${index}]: unsupported algorithm '${event.content.algorithm}'` };
    }
  }

  return { valid: true };
}

// Helper to create initial room events.
// Returns the create event ID for use in initializing m.fully_read.
//
// All initial state events for a room are submitted as a single D1 batch so
// either every required state event lands or none does. D1 does not support
// BEGIN/COMMIT, but batches execute atomically — partial failure cannot leave
// a room with missing fundamental state events.
async function createInitialRoomEvents(
  env: Env,
  roomId: string,
  roomVersion: string,
  creatorId: string,
  options: {
    name?: string;
    topic?: string;
    preset?: string;
    is_direct?: boolean;
    initial_state?: Array<{ type: string; state_key?: string; content: any }>;
    invite?: string[];
    room_alias_local_part?: string;
    creation_content?: Record<string, unknown>;
    power_level_content_override?: Record<string, unknown>;
  },
  prebuiltCreate?: { eventId: string; pduBase: Record<string, unknown>; hashes: Record<string, string> }
): Promise<string> {
  const db = env.DB;
  const now = Date.now();

  interface PlannedEvent {
    pdu: PDU;
    membership?: { userId: string; state: 'join' | 'invite' };
  }

  // In MSC4291 (room version 12) the create event is implicit in every
  // event's auth chain and MUST NOT be listed in auth_events. Plain version
  // 11 keeps the ordinary v4 format, where the create IS listed.
  const createIsImplicit = isMsc4291RoomVersion(roomVersion);

  const planned: PlannedEvent[] = [];
  const authEvents: string[] = [];
  const prevEvents: string[] = [];
  let depth = 0;

  // MSC4291 (v12): a room's event IDs are reference hashes of the exact
  // bytes federation will see. The creation batch must therefore be stored
  // in that same derived space — IDs derived, references translated to
  // derived IDs, auth_events reduced to the receiving server's expected
  // selection — or the stored room and the served room diverge into two ID
  // spaces and remote servers cannot resolve references into either.
  const plannedRefTargets = new Map<string, { type: string; stateKey: string }>();
  let createPlannedId: string | undefined;
  const AUTH_SEP = String.fromCharCode(0);

  // Add auth types the receiver requires (join_rules for joins, sender
  // membership, ...) from the state planned so far.
  const augmentRefs = (
    refs: string[],
    type: string,
    stateKey: string | undefined,
    content: any
  ): string[] => {
    const expected = expectedAuthTypes(type, creatorId, stateKey, content);
    const have = new Set(refs);
    const out = [...refs];
    for (const [id, t] of plannedRefTargets) {
      if (expected.has(t.type + AUTH_SEP + t.stateKey) && !have.has(id)) {
        have.add(id);
        out.push(id);
      }
    }
    if (!createIsImplicit && createPlannedId && !have.has(createPlannedId)) out.push(createPlannedId);
    return out;
  };

  const reduceAuthRefs = (
    refs: string[],
    type: string,
    stateKey: string | undefined,
    content: any
  ): string[] => {
    const expected = expectedAuthTypes(type, creatorId, stateKey, content);
    const kept: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
      if (!seen.has(id)) {
        seen.add(id);
        kept.push(id);
      }
    };
    for (const ref of refs) {
      const target = plannedRefTargets.get(ref);
      if (!target) {
        push(ref);
        continue;
      }
      if (target.type === 'm.room.create') continue;
      if (expected.has(`${target.type}\u0000${target.stateKey}`)) push(ref);
    }
    return kept;
  };

  async function plan(
    type: string,
    content: any,
    stateKey: string | undefined,
    membership?: { userId: string; state: 'join' | 'invite' }
  ): Promise<string> {
    if (createIsImplicit) {
      // Derive the wire form first (reduced refs, reference-hash ID, content
      // hash, server signature) and store that exact form, so the stored
      // event is byte-identical to what the serving derivation produces.
      const pdu: PDU = {
        // Placeholder: the real ID is the derived wire ID assigned below
        // (prepareOutboundPdu strips event_id before hashing anyway).
        event_id: '',
        room_id: roomId,
        sender: creatorId,
        type,
        state_key: stateKey,
        content,
        origin_server_ts: now,
        depth: depth++,
        auth_events: reduceAuthRefs(augmentRefs([...authEvents], type, stateKey, content), type, stateKey, content),
        prev_events: [...prevEvents],
      };
      const prepared = await prepareOutboundPdu(env, pdu, roomVersion);
      if (!prepared) {
        throw new Error('[createRoom] cannot derive v12 event ID without a signing key');
      }
      pdu.event_id = prepared.wireId;
      pdu.hashes = prepared.hashes as PDU['hashes'];
      pdu.signatures = prepared.signatures as PDU['signatures'];
      if (type === 'm.room.create') createPlannedId = prepared.wireId;
      validateEventSize(pdu);
      planned.push({ pdu, membership });
      if (stateKey !== undefined && type !== 'm.room.create') {
        authEvents.push(prepared.wireId);
        plannedRefTargets.set(prepared.wireId, { type, stateKey: stateKey ?? '' });
      }
      prevEvents.length = 0;
      prevEvents.push(prepared.wireId);
      return prepared.wireId;
    }

    const pdu: PDU = {
      event_id: '',
      room_id: roomId,
      sender: creatorId,
      type,
      state_key: stateKey,
      content,
      origin_server_ts: now,
      depth: depth++,
      auth_events: augmentRefs([...authEvents], type, stateKey, content),
      prev_events: [...prevEvents],
    };
    // Room v3+ event IDs are reference hashes and peers verify our server
    // signature, so legacy rooms hash+sign like derived ones (but keep
    // room_id and the full auth_events selection). Without a signing key
    // (local-only/test rooms) fall back to a generated ID, unsigned.
    const prepared = await prepareOutboundPdu(env, pdu, roomVersion);
    let eventId: string;
    if (prepared) {
      eventId = prepared.wireId;
      pdu.hashes = prepared.hashes as PDU['hashes'];
      pdu.signatures = prepared.signatures as PDU['signatures'];
    } else {
      eventId = await generateEventId(env.SERVER_NAME, roomVersion);
      pdu.hashes = { sha256: await calculateContentHash(pdu as unknown as Record<string, unknown>) };
    }
    pdu.event_id = eventId;
    if (type === 'm.room.create') createPlannedId = eventId;

    // Validate row size up front; fail fast before submitting the batch.
    validateEventSize(pdu);

    planned.push({ pdu, membership });

    if (stateKey !== undefined && !(type === 'm.room.create' && createIsImplicit)) {
      authEvents.push(eventId);
    }
    prevEvents.length = 0;
    prevEvents.push(eventId);
    return eventId;
  }

  // 1. m.room.create
  let createEventId: string;
  if (prebuiltCreate) {
    // MSC4291: the room ID and create event ID are derived from the create's
    // own reference hash, computed by the caller before the room row exists.
    createEventId = prebuiltCreate.eventId;
    const createPdu = {
      event_id: createEventId,
      room_id: roomId,
      ...prebuiltCreate.pduBase,
      hashes: prebuiltCreate.hashes,
    } as unknown as PDU;
    validateEventSize(createPdu);
    planned.push({ pdu: createPdu });
    prevEvents.push(createEventId);
  } else {
    // creation_content is client-supplied, but the server owns the creator
    // and room_version fields — merge client keys first so they cannot be
    // overridden (spec: "servers should ignore" attempts to set version).
    const createContent = {
      ...(options.creation_content ?? {}),
      creator: creatorId,
      room_version: roomVersion,
    } as RoomCreateContent;
    createEventId = await plan('m.room.create', createContent, '');
  }

  // 2. m.room.member (creator joins)
  const memberContent: RoomMemberContent = { membership: 'join' };
  await plan('m.room.member', memberContent, creatorId, { userId: creatorId, state: 'join' });

  // 3. m.room.power_levels
  const preset = options.preset || 'private_chat';
  const powerLevelsContent = {
    ban: 50,
    events: {
      'm.room.avatar': 50,
      'm.room.canonical_alias': 50,
      'm.room.encryption': 100,
      'm.room.history_visibility': 100,
      'm.room.name': 50,
      'm.room.power_levels': 100,
      'm.room.server_acl': 100,
      'm.room.tombstone': 100,
    },
    events_default: 0,
    invite: preset === 'public_chat' ? 0 : 50,
    kick: 50,
    notifications: { room: 50 },
    redact: 50,
    state_default: 50,
    // MSC4289: in v12 rooms the creator has implicit power and must not
    // appear in the users map (Synapse rejects remote joins otherwise).
    users: isMsc4291RoomVersion(roomVersion) ? {} : { [creatorId]: 100 },
    users_default: 0,
  };

  // power_level_content_override is merged after the preset so client keys
  // win for every field (events, ban, kick, redact, invite, notifications,
  // ...). The creator's own power is server-owned and stays 100; in v12
  // rooms MSC4289 keeps it implicit by omitting it from the users map.
  const mergedPowerLevels: Record<string, unknown> = {
    ...powerLevelsContent,
    ...(options.power_level_content_override ?? {}),
  };
  const overrideUsers = mergedPowerLevels.users;
  const users: Record<string, unknown> =
    overrideUsers && typeof overrideUsers === 'object' && !Array.isArray(overrideUsers)
      ? { ...(overrideUsers as Record<string, unknown>) }
      : {};
  if (isMsc4291RoomVersion(roomVersion)) {
    delete users[creatorId];
  } else {
    users[creatorId] = 100;
  }
  mergedPowerLevels.users = users;
  await plan('m.room.power_levels', mergedPowerLevels, '');

  // 4. m.room.join_rules
  let joinRule = 'invite';
  if (preset === 'public_chat') joinRule = 'public';
  else if (preset === 'trusted_private_chat') joinRule = 'invite';
  await plan('m.room.join_rules', { join_rule: joinRule }, '');

  // 5. m.room.history_visibility
  let historyVisibility = 'shared';
  if (preset === 'public_chat') historyVisibility = 'shared';
  await plan('m.room.history_visibility', { history_visibility: historyVisibility }, '');

  // 6. m.room.guest_access
  let guestAccess = 'forbidden';
  if (preset === 'public_chat') guestAccess = 'can_join';
  await plan('m.room.guest_access', { guest_access: guestAccess }, '');

  // 7. E2EE for direct / trusted-private chats: Element expects DMs to be
  // encrypted and shows "unencrypted" otherwise.
  const hasEncryption = (options.initial_state ?? []).some((s) => s.type === 'm.room.encryption');
  if ((options.is_direct || preset === 'trusted_private_chat') && !hasEncryption) {
    await plan('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, '');
  }

  if (options.name) {
    await plan('m.room.name', { name: options.name }, '');
  }
  if (options.topic) {
    await plan('m.room.topic', { topic: options.topic }, '');
  }
  if (options.initial_state) {
    for (const state of options.initial_state) {
      await plan(state.type, state.content, state.state_key ?? '');
    }
  }

  // Invites are part of the atomic batch too: either the room is created with
  // all its requested invite memberships or nothing is committed.
  if (options.invite) {
    for (const invitee of options.invite) {
      const inviteContent: RoomMemberContent = {
        membership: 'invite',
        is_direct: options.is_direct,
      };
      await plan('m.room.member', inviteContent, invitee, { userId: invitee, state: 'invite' });
    }
  }

  // Allocate stream_ordering for all events atomically. Increment by N and
  // reserve the contiguous range [position - N + 1 .. position].
  const n = planned.length;
  const posResult = await db.prepare(
    `UPDATE stream_positions SET position = position + ? WHERE stream_name = 'events' RETURNING position`
  ).bind(n).first<{ position: number }>();
  const lastPosition = posResult?.position ?? n;
  const firstPosition = lastPosition - n + 1;

  // Build all batch statements.
  const stmts: D1PreparedStatement[] = [];
  planned.forEach((p, i) => {
    const e = p.pdu;
    const streamOrdering = firstPosition + i;
    stmts.push(
      db.prepare(
        `INSERT INTO events (event_id, room_id, sender, event_type, state_key, content,
         origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        e.event_id,
        e.room_id,
        e.sender,
        e.type,
        e.state_key ?? null,
        JSON.stringify(e.content),
        e.origin_server_ts,
        e.unsigned ? JSON.stringify(e.unsigned) : null,
        e.depth,
        JSON.stringify(e.auth_events),
        JSON.stringify(e.prev_events),
        e.hashes ? JSON.stringify(e.hashes) : null,
        e.signatures ? JSON.stringify(e.signatures) : null,
        streamOrdering
      )
    );
    if (e.state_key !== undefined) {
      stmts.push(
        db.prepare(
          `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id)
           VALUES (?, ?, ?, ?)`
        ).bind(e.room_id, e.type, e.state_key, e.event_id)
      );
    }
    if (p.membership) {
      stmts.push(
        db.prepare(
          `INSERT OR REPLACE INTO room_memberships (room_id, user_id, membership, event_id, display_name, avatar_url)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(roomId, p.membership.userId, p.membership.state, e.event_id, null, null)
      );
    }
  });

  try {
    await db.batch(stmts);
  } catch (err) {
    // Compensating cleanup: D1 batches are documented atomic, but defensively
    // attempt to remove anything we inserted for this room in case a partial
    // write slipped through. This is best-effort; the original error is rethrown.
    console.error('[createRoom] batch failed, attempting compensating cleanup for room', roomId, err);
    try {
      await db.batch([
        db.prepare(`DELETE FROM room_memberships WHERE room_id = ?`).bind(roomId),
        db.prepare(`DELETE FROM room_state WHERE room_id = ?`).bind(roomId),
        db.prepare(`DELETE FROM events WHERE room_id = ?`).bind(roomId),
      ]);
    } catch (cleanupErr) {
      console.error('[createRoom] compensating cleanup also failed for room', roomId, cleanupErr);
    }
    throw err;
  }

  return createEventId;
}

// POST /_matrix/client/v3/createRoom - Create a new room
app.post('/_matrix/client/v3/createRoom', requireAuth(), async (c) => {
  const userId = c.get('userId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const {
    room_alias_local_part,
    name,
    topic,
    invite,
    room_version,
    initial_state,
    preset,
    is_direct,
    visibility,
    creation_content,
    power_level_content_override,
  } = body;
  // invite_3pid remains reserved; creation_content and
  // power_level_content_override are spec parameters merged into the initial
  // create / power-level events below.
  void body.invite_3pid;

  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (creation_content !== undefined && !isPlainObject(creation_content)) {
    return Errors.invalidParam('creation_content', 'creation_content must be an object').toResponse();
  }
  if (power_level_content_override !== undefined && !isPlainObject(power_level_content_override)) {
    return Errors.invalidParam(
      'power_level_content_override',
      'power_level_content_override must be an object'
    ).toResponse();
  }

  // MSC4155: reject the create if any invitee's permission config blocks us.
  if (Array.isArray(invite)) {
    for (const invitee of invite) {
      if (typeof invitee !== 'string') continue;
      if ((await getInvitePermission(c.env.DB, invitee, userId)) === 'block') {
        return Errors.inviteBlocked().toResponse();
      }
      // Moderation policy lists (spec module): no invites to banned users
      // or onto banned servers ("no outbound invites").
      {
        const modRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);
        if (modRules.subscriptions > 0) {
          const bannedUser = isUserBannedByPolicy(modRules, invitee);
          const bannedServer = isServerBannedByPolicy(
            modRules,
            serverNameFromId(invitee)
          );
          if (bannedUser || bannedServer) {
            return Errors.forbidden(
              `The invitee is banned by a moderation policy list (${bannedUser?.reason || bannedServer?.reason || 'banned entity'})`
            ).toResponse();
          }
        }
      }
    }
  }

  // Validate room alias if provided
  if (room_alias_local_part) {
    const alias = formatRoomAlias(room_alias_local_part, c.env.SERVER_NAME);
    const existingRoom = await getRoomByAlias(c.env.DB, alias);
    if (existingRoom) {
      return Errors.roomInUse().toResponse();
    }
  }

  // Validate initial_state if provided
  if (initial_state !== undefined) {
    if (!Array.isArray(initial_state)) {
      return c.json({
        errcode: 'M_INVALID_PARAM',
        error: 'initial_state must be an array',
      }, 400);
    }

    // Check for duplicate encryption events
    const encryptionEvents = initial_state.filter((s: any) => s.type === 'm.room.encryption');
    if (encryptionEvents.length > 1) {
      return c.json({
        errcode: 'M_INVALID_PARAM',
        error: 'Cannot specify multiple m.room.encryption events in initial_state',
      }, 400);
    }

    // Validate each state event
    for (let i = 0; i < initial_state.length; i++) {
      const validation = validateStateEvent(initial_state[i], i);
      if (!validation.valid) {
        return c.json({
          errcode: 'M_INVALID_PARAM',
          error: validation.error,
        }, 400);
      }
    }
  }

  // Validate room version
  const version = room_version || getDefaultRoomVersion();
  if (!isRoomVersionSupported(version)) {
    return Errors.unsupportedRoomVersion(`Room version '${version}' is not supported`).toResponse();
  }

  // MSC4291 (room version 12): the room ID and the create event's ID are
  // both derived from the create event's reference hash, so the create must
  // be built before the room row exists.
  const prebuiltCreate = isMsc4291RoomVersion(version)
    ? await buildMsc4291CreateEvent(version, userId, undefined, creation_content)
    : null;

  // Generate room ID
  const roomId = prebuiltCreate ? prebuiltCreate.roomId : await generateRoomId(c.env.SERVER_NAME);

  console.log('[createRoom] Creating room:', roomId, 'for user:', userId);

  // Create room in database
  const isPublic = visibility === 'public';
  await createRoom(c.env.DB, roomId, version, userId, isPublic);
  console.log('[createRoom] Room record created in DB');

  // Create initial room events atomically.
  let createEventId: string;
  try {
    createEventId = await createInitialRoomEvents(c.env, roomId, version, userId, {
      name,
      topic,
      preset,
      is_direct,
      initial_state,
      invite,
      room_alias_local_part,
      creation_content,
      power_level_content_override,
    }, prebuiltCreate ?? undefined);
    console.log('[createRoom] Initial room events created successfully');

    await c.env.DB.prepare(`
      INSERT INTO account_data (user_id, room_id, event_type, content)
      VALUES (?, ?, 'm.fully_read', ?)
      ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET content = excluded.content
    `).bind(userId, roomId, JSON.stringify({ event_id: createEventId })).run();
  } catch (err) {
    console.error('[createRoom] Failed to create initial room events, rolling back:', err);
    // Best-effort cleanup of the rooms row so we don't leave a half-created room
    // discoverable. Event/state/membership rows were already cleaned by
    // createInitialRoomEvents on failure.
    try {
      await c.env.DB.prepare(`DELETE FROM rooms WHERE room_id = ?`).bind(roomId).run();
    } catch (cleanupErr) {
      console.error('[createRoom] Failed to delete rooms row during rollback:', cleanupErr);
    }
    if (err instanceof Error && (err as any).errcode === 'M_TOO_LARGE') {
      return new Response(JSON.stringify({ errcode: 'M_TOO_LARGE', error: err.message }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Errors.unknown('Failed to create room').toResponse();
  }

  // Create room alias if provided
  if (room_alias_local_part) {
    const alias = formatRoomAlias(room_alias_local_part, c.env.SERVER_NAME);
    await createRoomAlias(c.env.DB, alias, roomId, userId);
  }

  // Notify the creator's sync that the room was created
  await notifyUsersOfEvent(c.env, roomId, roomId, 'm.room.create');

  // Federate invites for remote invitees so their servers learn about the
  // room (the Federation DO owns delivery and retries).
  if (invite) {
    for (const invitee of invite) {
      const inviteeDomain = String(invitee).split(':').slice(1).join(':');
      if (!inviteeDomain || inviteeDomain === c.env.SERVER_NAME) continue;
      const inviteEvent = await getStateEvent(c.env.DB, roomId, 'm.room.member', invitee);
      if (inviteEvent) await federateInvite(c.env, roomId, inviteEvent);
    }
  }

  return c.json({
    room_id: roomId,
    room_alias: room_alias_local_part
      ? formatRoomAlias(room_alias_local_part, c.env.SERVER_NAME)
      : undefined,
  });
});

// GET /_matrix/client/v3/joined_rooms - List joined rooms
app.get('/_matrix/client/v3/joined_rooms', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const rooms = await getUserRooms(c.env.DB, userId, 'join');
  return c.json({ joined_rooms: rooms });
});

// Helper to extract server name from room ID (!localpart:server)
function getServerFromRoomId(roomId: string): string | null {
  const match = roomId.match(/^!.+:(.+)$/);
  return match ? match[1] : null;
}

// Resident server for a room. Legacy room IDs carry a :server suffix; MSC4291
// (v12) room IDs do not, so fall back to the create event's sender domain.
async function getRoomResidentServer(
  db: D1Database,
  roomId: string
): Promise<string | null> {
  const suffix = getServerFromRoomId(roomId);
  if (suffix) return suffix;
  const create = await getStateEvent(db, roomId, 'm.room.create');
  const sender = (create as { sender?: string } | null)?.sender;
  if (typeof sender === 'string' && sender.includes(':')) {
    return sender.slice(sender.indexOf(':') + 1);
  }
  return null;
}

// A previously-unknown remote room needs a rooms row before the join workflow
// stores state (room_state has a FK to rooms). Version is corrected from the
// resident server's create event once the join completes.
async function ensureRemoteRoomRow(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO rooms (room_id, room_version, is_public, creator_id, created_at)
     VALUES (?, '10', 0, ?, ?)`
  ).bind(roomId, userId, Date.now()).run();
}

async function syncRoomVersionFromCreate(db: D1Database, roomId: string): Promise<void> {
  const create = await getStateEvent(db, roomId, 'm.room.create');
  const rv = (create?.content as { room_version?: string } | undefined)?.room_version;
  const creator = (create as { sender?: string } | null)?.sender;
  if (rv || creator) {
    await db.prepare(
      `UPDATE rooms SET room_version = COALESCE(?, room_version), creator_id = COALESCE(?, creator_id) WHERE room_id = ?`
    ).bind(rv ? String(rv) : null, creator ?? null, roomId).run();
  }
}

// Resolve a remote room alias via the alias server's federation directory
// (GET /_matrix/federation/v1/query/directory). Local aliases are handled by
// getRoomByAlias; this covers aliases hosted on other servers.
async function resolveRemoteAlias(
  env: Env,
  alias: string
): Promise<{ roomId: string; servers: string[] } | null> {
  const colon = alias.indexOf(':');
  if (colon <= 0) return null;
  const server = alias.slice(colon + 1);
  if (!server || server === env.SERVER_NAME) return null;
  try {
    const res = await federationGet(
      server,
      `/_matrix/federation/v1/query/directory?room_alias=${encodeURIComponent(alias)}`,
      env.SERVER_NAME,
      env.DB,
      env.CACHE
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { room_id?: string; servers?: string[] };
    if (typeof data.room_id !== 'string') return null;
    return {
      roomId: data.room_id,
      servers: Array.isArray(data.servers) && data.servers.length ? data.servers : [server],
    };
  } catch {
    return null;
  }
}

// Snapshot the newest local stream position before handing a remote join to
// RoomJoinWorkflow. Between /join and the federation handshake's membership
// registration the joining server is not a destination, so locally-written
// events are never queued for federation. The workflow re-sweeps everything
// above this watermark once send_join succeeds (see resweep-recent-events).
export async function joinStreamWatermark(db: D1Database, roomId: string): Promise<number> {
  try {
    const row = await db.prepare(
      `SELECT COALESCE(MAX(stream_ordering), 0) AS ordering FROM events WHERE room_id = ?`
    ).bind(roomId).first<{ ordering: number }>();
    return Number(row?.ordering ?? 0);
  } catch {
    // Best-effort snapshot: 0 still sweeps (at most the bounded window), and a
    // storage failure must never prevent a client from joining.
    return 0;
  }
}

// POST /_matrix/client/v3/rooms/:roomId/join - Join a room
// Fallback join candidates: the room-ID domain may be dead or serving a
// broken federation endpoint while other residents are fine. Synapse tries
// the inviter's server and other participating servers; so do we. Sources:
// the invite event's sender (invite-accepts) and currently-joined remote
// members. Never includes the local server; deduplicated.
export async function joinFallbackServers(
  db: D1Database,
  roomId: string,
  localServerName: string,
  inviteEventId?: string
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>([localServerName]);
  const add = (s?: string): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  try {
    if (inviteEventId) {
      const inv = await db
        .prepare(`SELECT sender FROM events WHERE event_id = ?`)
        .bind(inviteEventId)
        .first<{ sender: string }>();
      const sender = inv?.sender;
      if (sender && sender.includes(':')) add(sender.slice(sender.indexOf(':') + 1));
    }
  } catch {
    // Best-effort candidate only.
  }
  for (const s of await getJoinedRemoteServers(db, roomId, localServerName)) add(s);
  return out;
}

// Local restricted-room joins need the same allow-list + local-authoriser
// evaluation as make_join. Returns null when the room is not restricted or
// the user already holds an invite (the ordinary join rules apply then).
async function evaluateLocalRestrictedJoin(params: {
  env: Env;
  roomId: string;
  roomVersion: string;
  userId: string;
  joinRule: string;
  hasInvite: boolean;
}) {
  if (params.hasInvite ||
      (params.joinRule !== 'restricted' && params.joinRule !== 'knock_restricted')) {
    return null;
  }
  const roomState = await getRoomState(params.env.DB, params.roomId);
  return evaluateRestrictedJoin({
    db: params.env.DB,
    cache: params.env.CACHE,
    localServerName: params.env.SERVER_NAME,
    roomId: params.roomId,
    userId: params.userId,
    roomState,
    roomVersion: params.roomVersion,
  });
}

app.post('/_matrix/client/v3/rooms/:roomId/join', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  // Moderation policy lists (spec module): banned rooms are not joinable
  // by our users ("the user should leave the room and not join it").
  {
    const modRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);
    if (modRules.subscriptions > 0) {
      const bannedRoom = isRoomBannedByPolicy(modRules, roomId);
      if (bannedRoom) {
        return Errors.forbidden(
          `This room is banned by a moderation policy list (${bannedRoom.reason || bannedRoom.entity})`
        ).toResponse();
      }
    }
  }

  // Extract server from room ID to check if it's a remote room. v12 room IDs
  // have no suffix, so fall back to the create event's sender domain.
  const room = await getRoom(c.env.DB, roomId);
  const roomServer =
    getServerFromRoomId(roomId) ??
    (room ? await getRoomResidentServer(c.env.DB, roomId) : null);
  const isRemoteRoom = roomServer && roomServer !== c.env.SERVER_NAME;

  // Check if room exists locally
  // (room already loaded above)

  // Remote rooms go through the workflow for the federation handshake: either
  // the room is unknown locally, or we only hold invite state received from
  // the remote server and this join must be registered with it
  // (make_join/send_join) before it will relay the room's events to us.
  const localMembership =
    room && isRemoteRoom ? await getMembership(c.env.DB, roomId, userId) : null;
  const needsFederationJoin =
    isRemoteRoom && roomServer && (!room || localMembership?.membership === 'invite');
  if (needsFederationJoin && roomServer) {
    console.log('[rooms] Remote room join via workflow', { roomId, roomServer, userId });

    if (!room) await ensureRemoteRoomRow(c.env.DB, roomId, userId);

    // Trigger the RoomJoinWorkflow for durable federation handling. The
    // room-ID domain is tried first, with the inviter's server and other
    // participating servers as fallbacks (the resident domain can be dead
    // while the inviter happily serves make_join).
    const fallbackServers = await joinFallbackServers(
      c.env.DB, roomId, c.env.SERVER_NAME, localMembership?.eventId
    );
    const sinceStreamOrdering = await joinStreamWatermark(c.env.DB, roomId);
    const instance = await c.env.ROOM_JOIN_WORKFLOW.create({
      params: {
        roomId,
        userId,
        isRemote: true,
        remoteServer: roomServer,
        backfill: true,
        servers: fallbackServers,
        sinceStreamOrdering,
      },
    });

    // Wait for the workflow to complete (with timeout)
    // The workflow handles retries internally
    try {
      const status = await instance.status();
      console.log('[rooms] Workflow status', { roomId, status });

      // If workflow is still running, return accepted
      if (status.status === 'running' || status.status === 'queued') {
        // Return success - the join is in progress
        // Client will see the room appear in sync when complete
        return c.json({ room_id: roomId });
      }

      // Check if workflow completed successfully
      const output = status.output as JoinResult | undefined;
      if (status.status === 'complete' && output?.success) {
        await syncRoomVersionFromCreate(c.env.DB, roomId);
        return c.json({ room_id: roomId });
      }

      // Workflow failed
      console.error('[rooms] Workflow failed', { roomId, status });
      return Errors.unknown('Failed to join remote room').toResponse();
    } catch (err) {
      console.error('[rooms] Workflow error', { roomId, error: err });
      return Errors.unknown('Failed to join remote room').toResponse();
    }
  }

  // Local room handling (existing code)
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check current membership
  const currentMembership = await getMembership(c.env.DB, roomId, userId);

  // Check join rules
  const joinRulesEvent = await getStateEvent(c.env.DB, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as any)?.join_rule || 'invite';

  const restrictedDecision = await evaluateLocalRestrictedJoin({
    env: c.env,
    roomId,
    roomVersion: room.room_version,
    userId,
    joinRule,
    hasInvite: currentMembership?.membership === 'invite',
  });
  if (restrictedDecision?.error) {
    // A knock_restricted room with no allow-list match still has the normal
    // knock flow available to the client.
    return Errors.forbidden(
      joinRule === 'knock_restricted'
        ? `${restrictedDecision.error}. Knock to request access instead.`
        : restrictedDecision.error
    ).toResponse();
  }

  // Determine if user can join
  let canJoin = false;
  if (joinRule === 'public') {
    canJoin = true;
  } else if (currentMembership?.membership === 'invite') {
    canJoin = true;
  } else if (currentMembership?.membership === 'join') {
    // Already joined
    return c.json({ room_id: roomId });
  } else if (restrictedDecision?.authorizedBy) {
    canJoin = true;
  }

  if (!canJoin) {
    return Errors.forbidden('Cannot join room').toResponse();
  }

  // Get current state for auth events
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);
  if (restrictedDecision?.authEventId) authEvents.push(restrictedDecision.authEventId);

  // Get prev events (latest events in room)
  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  // Deterministic event ID — concurrent retries within the same 1s bucket
  // collapse to the same ID, which combined with INSERT OR IGNORE makes the
  // join idempotent under concurrency.
  const ts = Date.now();
  const eventId = await generateDeterministicEventId(
    c.env.SERVER_NAME, roomId, userId, 'join', ts, 1, room.room_version
  );

  const memberContent: RoomMemberContent = {
    membership: 'join',
    ...(restrictedDecision?.authorizedBy
      ? { join_authorised_via_users_server: restrictedDecision.authorizedBy }
      : {}),
  };

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: ts,
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Idempotent insert: if a concurrent request already wrote this exact
  // event, INSERT OR IGNORE silently no-ops and we surface the existing one.
  const insertResult = await storeEventIdempotent(c.env.DB, event);

  // Even if the event row already existed, we still need to ensure the
  // membership row is consistent. tryInsertJoinMembership uses ON CONFLICT
  // to preserve an existing 'join' row rather than overwriting it.
  const memberResult = await tryInsertJoinMembership(c.env.DB, roomId, userId, eventId);

  // Only notify on a genuinely new join — duplicate retries should not
  // produce duplicate sync notifications.
  if (insertResult.inserted || memberResult.inserted) {
    await notifyUsersOfEvent(c.env, roomId, memberResult.eventId, 'm.room.member');
  }

  // Federate the join to remote members so their servers can resolve later
  // events that auth-reference it.
  const joinDestinations = await getJoinedRemoteServers(c.env.DB, roomId, c.env.SERVER_NAME);
  await federateLocalStateEventToRemotes(c.env, event, roomId, joinDestinations);

  return c.json({ room_id: roomId });
});

// POST /_matrix/client/v3/rooms/:roomId/leave - Leave a room
app.post('/_matrix/client/v3/rooms/:roomId/leave', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  // Check current membership
  const currentMembership = await getMembership(c.env.DB, roomId, userId);
  if (!currentMembership) {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // join / invite / leave all proceed: leaving an invite rejects it, and a
  // REPEATED leave stores a fresh m.room.member leave event. The fresh event
  // matters -- a client whose sync token already advanced past the original
  // leave event (or that missed the transition entirely) can only converge
  // when a leave newer than its token is delivered via /sync. The auth rules
  // allow a self leave from any state, so the extra event is valid.
  // Bans cannot be left; knocks are not memberships to leave.
  if (currentMembership.membership !== 'join' &&
      currentMembership.membership !== 'invite' &&
      currentMembership.membership !== 'leave') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Create leave event
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'leave',
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(c.env.DB, roomId, userId, 'leave', eventId);

  // Notify room members about the leave
  await notifyUsersOfEvent(c.env, roomId, eventId, 'm.room.member');

  // Federate the leave to remote members so their servers can resolve later
  // events that auth-reference it.
  const leaveDestinations = await getJoinedRemoteServers(c.env.DB, roomId, c.env.SERVER_NAME);
  await federateLocalStateEventToRemotes(c.env, event, roomId, leaveDestinations);

  // MSC4267: transparently forget the room now that the user has left.
  await autoForgetLeftRoom(c.env, roomId, userId);

  return c.json({});
});

// POST /_matrix/client/v3/rooms/:roomId/knock - Knock on a room (MSC2403)
app.post('/_matrix/client/v3/rooms/:roomId/knock', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  let body: { reason?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  // Check if room exists
  const room = await getRoom(db, roomId);
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check current membership
  const currentMembership = await getMembership(db, roomId, userId);
  if (currentMembership?.membership === 'join') {
    return c.json({ room_id: roomId }); // Already joined
  }
  if (currentMembership?.membership === 'ban') {
    return Errors.forbidden('User is banned from this room').toResponse();
  }

  // Check join rules - knock only allowed if join_rule is 'knock' or 'knock_restricted'
  const joinRulesEvent = await getStateEvent(db, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as any)?.join_rule || 'invite';

  if (!['knock', 'knock_restricted'].includes(joinRule)) {
    return Errors.forbidden('Room does not allow knocking').toResponse();
  }

  // Create knock event
  const createEvent = await getStateEvent(db, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(db, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(db, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'knock',
    reason: body.reason,
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(db, roomId, userId, 'knock', eventId);

  // Store in room_knocks table for easy querying
  await db.prepare(`
    INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(roomId, userId, body.reason || null, eventId, Date.now()).run();

  return c.json({ room_id: roomId });
});

// POST /_matrix/client/v3/knock/:roomIdOrAlias - Knock by ID or alias
app.post('/_matrix/client/v3/knock/:roomIdOrAlias', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomIdOrAlias = c.req.param('roomIdOrAlias');
  const db = c.env.DB;

  let body: { reason?: string; server_name?: string[] };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  let roomId = roomIdOrAlias;

  // If it's an alias, resolve it
  if (roomIdOrAlias.startsWith('#')) {
    const resolved = await getRoomByAlias(db, roomIdOrAlias);
    if (!resolved) {
      return Errors.notFound('Room alias not found').toResponse();
    }
    roomId = resolved;
  }

  // Check if room exists
  const room = await getRoom(db, roomId);
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check join rules
  const joinRulesEvent = await getStateEvent(db, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as any)?.join_rule || 'invite';

  if (!['knock', 'knock_restricted'].includes(joinRule)) {
    return Errors.forbidden('Room does not allow knocking').toResponse();
  }

  // Check current membership
  const currentMembership = await getMembership(db, roomId, userId);
  if (currentMembership?.membership === 'join') {
    return c.json({ room_id: roomId });
  }
  if (currentMembership?.membership === 'ban') {
    return Errors.forbidden('User is banned from this room').toResponse();
  }

  // Create knock event
  const createEvent = await getStateEvent(db, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(db, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(db, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'knock',
    reason: body.reason,
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(db, roomId, userId, 'knock', eventId);

  await db.prepare(`
    INSERT OR REPLACE INTO room_knocks (room_id, user_id, reason, event_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(roomId, userId, body.reason || null, eventId, Date.now()).run();

  return c.json({ room_id: roomId });
});

// GET /_matrix/client/v3/rooms/:roomId/state - Get all current state
app.get('/_matrix/client/v3/rooms/:roomId/state', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const state = await getRoomState(c.env.DB, roomId);

  // Format events for client
  const clientEvents = state.map(e => ({
    type: e.type,
    state_key: e.state_key,
    content: e.content,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  }));

  return c.json(clientEvents);
});

// GET /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey? - Get specific state
// Registered twice: matrix-js-sdk sends empty state keys as a path ending in
// "/state/<type>/" (trailing slash), which Hono's optional-param pattern
// does not match — without the second registration Element's state reads
// (and the whole Addresses panel) 404 with M_UNRECOGNIZED.
async function getRoomStateHandler(c: any) {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const eventType = c.req.param('eventType');
  const stateKey = c.req.param('stateKey') ?? '';

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const event = await getStateEvent(c.env.DB, roomId, eventType, stateKey);
  if (!event) {
    return Errors.notFound('State event not found').toResponse();
  }

  return c.json(event.content);
}
app.get('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?', requireAuth(), getRoomStateHandler);
app.get('/_matrix/client/v3/rooms/:roomId/state/:eventType/', requireAuth(), getRoomStateHandler);

// PUT /_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey? - Set state
//
// Permission and state writes are serialized via optimistic concurrency
// (see issue 009 sub-finding 2/3). The auth basis is captured up front
// (power_levels event id + the existing state event for this slot), then
// re-validated immediately before the write. If anything has changed in
// between, we abort with M_CONFLICT instead of overwriting based on stale
// auth context. Clients should re-read room state and retry.
// Core of PUT /rooms/:roomId/state, shared with MSC4140 delayed state events.
export async function performStateEvent(
  env: Env,
  roomId: string,
  userId: string,
  eventType: string,
  stateKey: string,
  content: any
): Promise<{ eventId: string } | { error: MatrixApiError }> {
  // Check membership
  const membership = await getMembership(env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return { error: Errors.forbidden('Not a member of this room') };
  }

  // Server ACL: if the room's ACL denies OUR server, every compliant server
  // — including us — upholds it, so local state writes are refused too.
  // (The dedicated /leave endpoint bypasses this core, so leaving stays
  // possible; reads are unaffected.)
  if (!(await isServerAllowedInRoom(env.DB, roomId, env.SERVER_NAME))) {
    return { error: Errors.forbidden("This server is denied by the room's server ACL") };
  }

  // MSC4155: an invite written through the state endpoint is still an invite.
  if (eventType === 'm.room.member' && content?.membership === 'invite') {
    if ((await getInvitePermission(env.DB, stateKey, userId)) === 'block') {
      return { error: Errors.inviteBlocked() };
    }
    // Moderation policy lists (spec module): no invites to banned users
    // or onto banned servers ("no outbound invites").
    {
      const modRules = await getActivePolicyRules(env.DB, env.CACHE);
      if (modRules.subscriptions > 0) {
        const bannedUser = isUserBannedByPolicy(modRules, stateKey);
        const bannedServer = isServerBannedByPolicy(modRules, serverNameFromId(stateKey));
        if (bannedUser || bannedServer) {
          return {
            error: Errors.forbidden(
              `The invitee is banned by a moderation policy list (${bannedUser?.reason || bannedServer?.reason || 'banned entity'})`
            ),
          };
        }
      }
    }
  }

  // Capture the auth basis at check-time.
  const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
  const powerLevelsEventCheck = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const existingStateEventCheck = await getStateEvent(env.DB, roomId, eventType, stateKey);

  // Power-level permission check. We re-read this just before writing.
  const powerLevels = (powerLevelsEventCheck?.content as any) || {};
  const userPower = getEffectiveUserPowerLevel(powerLevels, userId, createEvent);
  const requiredPower = powerLevels.events?.[eventType]
    ?? (eventType === 'm.room.member' ? (powerLevels.state_default ?? 50) : (powerLevels.state_default ?? 50));
  if (userPower < requiredPower) {
    return { error: Errors.forbidden('Insufficient power level for this state event') };
  }

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEventCheck) authEvents.push(powerLevelsEventCheck.event_id);
  if (membership) authEvents.push(membership.eventId);

  const { events: latestEvents } = await getRoomEvents(env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: eventType,
    state_key: stateKey,
    content,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Re-read the auth basis immediately before the write. If either the
  // power level event or the slot we're writing has been replaced since
  // our check, the original permission decision was made on stale data —
  // refuse rather than silently overwriting another concurrent write.
  const powerLevelsEventNow = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const existingStateEventNow = await getStateEvent(env.DB, roomId, eventType, stateKey);
  if ((powerLevelsEventCheck?.event_id ?? null) !== (powerLevelsEventNow?.event_id ?? null)) {
    return { error: Errors.conflict('Power levels changed during request; retry') };
  }
  if ((existingStateEventCheck?.event_id ?? null) !== (existingStateEventNow?.event_id ?? null)) {
    return { error: Errors.conflict(`State event ${eventType}/${stateKey} changed during request; retry`) };
  }

  // Spec v1.19: client-formatted state events carry unsigned.replaces_state
  // pointing at the event this one supersedes, so clients can diff state
  // deltas without a full /state fetch. The conflict re-check above makes
  // existingStateEventNow the exact event being replaced.
  if (existingStateEventNow) {
    event.unsigned = {
      ...(event.unsigned ?? {}),
      replaces_state: existingStateEventNow.event_id,
    };
  }

  const eventId = await prepareAndStoreLocalEvent(env, roomId, event);

  // Destinations for federation fanout: captured before any membership row
  // mutates, plus the affected user's server for membership events.
  const remoteServers = await getJoinedRemoteServers(env.DB, roomId, env.SERVER_NAME);
  let fanoutDestinations = remoteServers;
  if (eventType === 'm.room.member') {
    const targetDomain = stateKey.includes(':') ? stateKey.slice(stateKey.indexOf(':') + 1) : '';
    if (targetDomain && targetDomain !== env.SERVER_NAME && !remoteServers.includes(targetDomain)) {
      fanoutDestinations = [...remoteServers, targetDomain];
    }
  }

  // Invalidate room metadata cache if this is a metadata-affecting state event
  const CACHED_STATE_TYPES = ['m.room.name', 'm.room.avatar', 'm.room.topic', 'm.room.canonical_alias', 'm.room.member'];
  if (CACHED_STATE_TYPES.includes(eventType)) {
    // Bump the cache generation first (see issue 009 sub-finding 4): even
    // if the subsequent KV delete fails, readers that compare generations
    // will reject the stale cached value.
    await bumpRoomCacheGeneration(env.CACHE, roomId).catch((err) => {
      console.warn(`[rooms] Cache generation bump failed for room ${roomId}:`, err);
    });
    invalidateRoomCache(env.CACHE, roomId).catch((err) => {
      console.warn(`[rooms] Cache invalidation failed for room ${roomId}:`, err);
    });
  }

  // Update membership table if this is a membership event
  if (eventType === 'm.room.member') {
    await updateMembership(
      env.DB,
      roomId,
      stateKey,
      content.membership,
      eventId,
      content.displayname,
      content.avatar_url
    );
  }

  // Notify room members about the state change (wakes up long-polling syncs)
  await notifyUsersOfEvent(env, roomId, eventId, eventType);

  // Bot auto-accept: when a bot user is invited (local or federated invite
  // through the state path), the homeserver completes the join for it —
  // bots have no client session to tap "accept" with. Best-effort.
  if (eventType === 'm.room.member' && content?.membership === 'invite') {
    try {
      const { getBotByUserId } = await import('../services/bots');
      const bot = await getBotByUserId(env.DB, stateKey);
      if (bot) {
        await joinBotUserToRoom(env, roomId, stateKey);
        console.log('[rooms] bot auto-accepted invite', { roomId, bot: stateKey });
      }
    } catch (err) {
      console.warn('[rooms] bot auto-accept failed:', err);
    }
  }

  // Federate the state event. Member invites travel via the dedicated
  // federation /invite endpoint instead (the invitee's server is not yet in
  // the room, so a transaction PDU cannot be authorized there).
  if (eventType === 'm.room.member' && content?.membership === 'invite') {
    await federateInvite(env, roomId, event);
  } else {
    await federateLocalStateEventToRemotes(env, event, roomId, fanoutDestinations);
  }

  return { eventId };
}

// matrix-js-sdk sends empty state keys with a trailing slash (".../state/<type>/"),
// which Hono's optional-param pattern does not match; register both shapes.
async function putRoomStateHandler(c: any) {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const eventType = c.req.param('eventType');
  const stateKey = c.req.param('stateKey') ?? '';

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const result = await performStateEvent(c.env, roomId, userId, eventType, stateKey, content);
  if ('error' in result) return result.error.toResponse();

  return c.json({ event_id: result.eventId });
}
app.put('/_matrix/client/v3/rooms/:roomId/state/:eventType/:stateKey?', requireAuth(), putRoomStateHandler);
app.put('/_matrix/client/v3/rooms/:roomId/state/:eventType/', requireAuth(), putRoomStateHandler);

// GET /_matrix/client/v3/rooms/:roomId/members - Get room members
app.get('/_matrix/client/v3/rooms/:roomId/members', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const membershipFilter = c.req.query('membership');
  const notMembershipFilter = c.req.query('not_membership');
  const atParam = c.req.query('at');
  let atToken: number | undefined;
  if (atParam) {
    const parsed = parseInt(atParam.startsWith('s') ? atParam.slice(1) : atParam, 10);
    if (!isNaN(parsed)) atToken = parsed;
  }

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  type MemberRow = {
    event_id: string;
    room_id: string;
    sender: string;
    event_type: string;
    state_key: string | null;
    content: string;
    origin_server_ts: number;
    unsigned: string | null;
  };
  const memberRows: MemberRow[] = [];

  if (atToken !== undefined) {
    // Point-in-time membership: m.room.member events are kept in the events
    // table with their stream_ordering, so the latest event at or before the
    // token per state_key is the membership as it stood at that point.
    const history = await c.env.DB.prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content, e.origin_server_ts, e.unsigned
       FROM events e
       WHERE e.room_id = ? AND e.event_type = 'm.room.member'
         AND e.state_key IS NOT NULL AND e.stream_ordering IS NOT NULL
         AND e.stream_ordering <= ?
       ORDER BY e.stream_ordering ASC`
    ).bind(roomId, atToken).all<MemberRow & { stream_ordering: number }>();

    const latestByUser = new Map<string, MemberRow>();
    for (const row of history.results ?? []) {
      if (row.state_key) latestByUser.set(row.state_key, row);
    }
    memberRows.push(...latestByUser.values());
  } else {
    // One round trip for all current member events. A per-member getStateEvent
    // loop broke on big rooms (a 4,000-member room = 4,000 D1 subrequests in
    // one invocation → 500s), and lazy_load_members clients (Element Web
    // default) call this endpoint on demand for every room they render.
    const rows = await c.env.DB.prepare(
      `SELECT e.event_id, e.room_id, e.sender, e.event_type, e.state_key, e.content, e.origin_server_ts, e.unsigned
       FROM room_state rs JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.member'`
    ).bind(roomId).all<MemberRow>();
    memberRows.push(...(rows.results ?? []));
  }

  const memberEvents = [];
  for (const row of memberRows) {
    let content: unknown;
    try {
      content = JSON.parse(row.content);
    } catch {
      continue;
    }
    const m = (content as { membership?: string }).membership;
    if (membershipFilter && m !== membershipFilter) continue;
    if (notMembershipFilter && m === notMembershipFilter) continue;
    memberEvents.push({
      type: row.event_type,
      state_key: row.state_key ?? undefined,
      content,
      sender: row.sender,
      origin_server_ts: row.origin_server_ts,
      event_id: row.event_id,
      room_id: row.room_id,
      unsigned: row.unsigned ? JSON.parse(row.unsigned) : undefined,
    });
  }

  return c.json({ chunk: memberEvents });
});

// RoomEventFilter subset used by /messages. Unrecognized keys are ignored.
interface MessageEventFilter {
  types?: string[];
  not_types?: string[];
  rooms?: string[];
  not_rooms?: string[];
  senders?: string[];
  not_senders?: string[];
  contains_url?: boolean;
}

/** null = no such constraint; otherwise whether the value matched a pattern. */
function matchesEventPatterns(value: string, patterns: unknown): boolean | null {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  return patterns.some((pattern) =>
    typeof pattern === 'string' &&
    (pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern)
  );
}

/** Exported for unit tests. */
export function applyMessageEventFilter(events: any[], filter: MessageEventFilter): any[] {
  return events.filter((event) => {
    if (matchesEventPatterns(event.type, filter.types) === false) return false;
    if (matchesEventPatterns(event.type, filter.not_types) === true) return false;
    if (matchesEventPatterns(event.room_id, filter.rooms) === false) return false;
    if (matchesEventPatterns(event.room_id, filter.not_rooms) === true) return false;
    if (matchesEventPatterns(event.sender, filter.senders) === false) return false;
    if (matchesEventPatterns(event.sender, filter.not_senders) === true) return false;
    if (typeof filter.contains_url === 'boolean') {
      const hasUrl = typeof event.content?.url === 'string' && event.content.url.length > 0;
      if (filter.contains_url !== hasUrl) return false;
    }
    return true;
  });
}

// GET /_matrix/client/v3/rooms/:roomId/messages - Get room messages
app.get('/_matrix/client/v3/rooms/:roomId/messages', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const from = c.req.query('from');
  const to = c.req.query('to');
  const dir = (c.req.query('dir') || 'b') as 'f' | 'b';
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);

  // Parse token - handle both 's123' format (from sliding-sync) and plain '123' format
  let fromToken: number | undefined;
  if (from) {
    const tokenStr = from.startsWith('s') ? from.slice(1) : from;
    const parsed = parseInt(tokenStr);
    fromToken = isNaN(parsed) ? undefined : parsed;
  }
  let toToken: number | undefined;
  if (to) {
    const tokenStr = to.startsWith('s') ? to.slice(1) : to;
    const parsed = parseInt(tokenStr);
    toToken = isNaN(parsed) ? undefined : parsed;
  }

  const filterParam = c.req.query('filter');
  let eventFilter: MessageEventFilter | undefined;
  if (filterParam) {
    try {
      const parsed = JSON.parse(filterParam);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('filter must be a JSON object');
      }
      eventFilter = parsed;
    } catch {
      return Errors.badJson('Invalid filter JSON').toResponse();
    }
  }

  // `to` is an exclusive stop position. Bound the read where possible, then
  // trim by actual stream_ordering below (positions are not guaranteed dense).
  let queryFrom = fromToken;
  let queryLimit = limit;
  if (toToken !== undefined) {
    if (dir === 'b') {
      if (fromToken !== undefined) {
        queryLimit = fromToken > toToken ? Math.min(limit, fromToken - toToken - 1) : 0;
      } else {
        queryFrom = Number.MAX_SAFE_INTEGER;
      }
    } else if (fromToken !== undefined) {
      queryLimit = toToken > fromToken ? Math.min(limit, toToken - fromToken - 1) : 0;
    } else {
      queryLimit = Math.min(limit, Math.max(0, toToken - 1));
    }
  }
  const { events: fetchedEvents, end } = await getRoomEvents(c.env.DB, roomId, queryFrom, queryLimit, dir);
  let events = fetchedEvents;

  if (toToken !== undefined && events.length > 0) {
    const ids = events.map((e) => e.event_id);
    const positions = await c.env.DB.prepare(
      `SELECT event_id, stream_ordering FROM events WHERE event_id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all<{ event_id: string; stream_ordering: number | null }>();
    const byId = new Map(positions.results.map((row) => [row.event_id, row.stream_ordering]));
    events = events.filter((event) => {
      const position = byId.get(event.event_id);
      // A missing position means the event cannot be placed relative to the
      // token; keep it rather than silently dropping history.
      if (position == null) return true;
      return dir === 'b' ? position > toToken : position < toToken;
    });
  }

  if (eventFilter) events = applyMessageEventFilter(events, eventFilter);

  // Format events for client
  const clientEvents = events.map(e => ({
    type: e.type,
    state_key: e.state_key,
    content: e.content,
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
    unsigned: e.unsigned,
  }));

  // Build response - omit 'end' if no events returned (reached start/end of timeline)
  // This prevents infinite retry loops when client paginates past available events
  // Use 's' prefix for consistency with sliding-sync prev_batch tokens
  const response: { start: string; end?: string; chunk: typeof clientEvents } = {
    start: from || 's0',
    chunk: clientEvents,
  };

  // Only include 'end' if we have events to paginate from
  if (events.length > 0) {
    response.end = `s${end}`;
  }

  return c.json(response);
});

// GET /_matrix/client/v3/rooms/:roomId/event/:eventId - Get specific event
app.get('/_matrix/client/v3/rooms/:roomId/event/:eventId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const event = await getEvent(c.env.DB, eventId);
  if (!event || event.room_id !== roomId) {
    return Errors.notFound('Event not found').toResponse();
  }

  // Redacted events serve their pruned content (getEvent stays on the
  // original because auth-chain building shares it).
  const pruned = await c.env.DB.prepare(
    `SELECT redacted_content FROM events WHERE event_id = ?`
  ).bind(eventId).first<{ redacted_content: string | null }>();

  return c.json({
    type: event.type,
    state_key: event.state_key,
    content: pruned?.redacted_content ? JSON.parse(pruned.redacted_content) : event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
    unsigned: event.unsigned,
  });
});

// Servers (other than ours) with at least one joined member in the room --
// the federation destinations for events created locally in this room.
// Returns [] on any lookup failure so message sending never depends on it.
async function getJoinedRemoteServers(db: D1Database, roomId: string, serverName: string): Promise<string[]> {
  try {
    const { results } = await db
      .prepare(`SELECT DISTINCT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join'`)
      .bind(roomId)
      .all<{ user_id: string }>();
    const servers = new Set<string>();
    for (const row of results || []) {
      const server = row.user_id?.split(':')[1];
      if (server && server !== serverName) servers.add(server);
    }
    // Server ACL (MSC4436): never queue outbound traffic for servers the
    // room denies — compliant peers drop it anyway, and denied servers get
    // no visibility into the room's live traffic from us.
    try {
      const aclEvent = await getStateEvent(db, roomId, 'm.room.server_acl', '');
      if (aclEvent) {
        return [...servers].filter((s) =>
          isServerAllowedByAcl(aclEvent.content as ServerAclContent, s)
        );
      }
    } catch (aclErr) {
      console.warn('[rooms] ACL destination filter failed; sending to all joined servers:', aclErr);
    }
    return [...servers];
  } catch (err) {
    console.error('[rooms] getJoinedRemoteServers failed:', err);
    return [];
  }
}

// Moved to services/event-wire (shared with the federation serving paths);
// re-exported for existing importers.
export { prepareOutboundPdu } from '../services/event-wire';

/**
 * Prepare a locally-created event for storage and federation in MSC4291 room
 * versions (v12): auth refs reduced to the receiving server's expected
 * selection, reference-hash ID derived from the exact stored bytes, content
 * hash and server signature attached, then stored. The stored event is then
 * byte-identical to the served/delivered form, so remote servers can resolve
 * references into it (storing under a generated ID instead puts the room in
 * two ID spaces and makes every outbound reference unresolvable to peers).
 * Older room versions keep the legacy path (generated ID, no derivation).
 * Mutates `event` in place and returns its stored ID.
 */
// Server-side join for BOT users. Bots have no client session, so the
// homeserver performs the join for them: used by the admin bot-creation API
// and by invite auto-accept. Mirrors the local /join route's semantics
// (public rooms, or the bot currently holding an invite), stores through the
// version-aware pipeline, notifies members, and federates the join so remote
// servers can resolve later references. Returns the join event id or null.
export async function joinBotUserToRoom(env: Env, roomId: string, botUserId: string): Promise<string | null> {
  const room = await getRoom(env.DB, roomId);
  if (!room) return null;

  const currentMembership = await getMembership(env.DB, roomId, botUserId);
  const joinRulesEvent = await getStateEvent(env.DB, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as any)?.join_rule || 'invite';
  const canJoin = joinRule === 'public' || currentMembership?.membership === 'invite';
  if (!canJoin) {
    console.warn('[rooms] bot join refused (not public, no invite)', { roomId, botUserId });
    return null;
  }
  if (currentMembership?.membership === 'join') return null; // already joined

  // Destinations captured before the bot's own (local) row changes; remote
  // membership rows are unaffected either way.
  const destinations = await getJoinedRemoteServers(env.DB, roomId, env.SERVER_NAME);

  const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map((e) => e.event_id);

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: botUserId,
    type: 'm.room.member',
    state_key: botUserId,
    content: { membership: 'join' },
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(env, roomId, event);
  await updateMembership(env.DB, roomId, botUserId, 'join', eventId);
  await notifyUsersOfEvent(env, roomId, eventId, 'm.room.member');
  await federateLocalStateEventToRemotes(env, event, roomId, destinations);
  return eventId;
}

// Spec Profiles module, "Events on Change of Profile Information": when a
// user's display name or avatar URL changes, the server sends an updated
// m.room.member event to every room they are joined to, so the change
// renders for other users (locally and over federation) without anyone
// re-querying the profile. Joins have always carried the profile
// snapshot; this covers CHANGES. Best-effort per room — the profile
// write itself must never fail because one room's fanout did.
export async function broadcastProfileMemberUpdates(
  env: Env,
  userId: string,
  opts: { displayNameChanged?: boolean; avatarChanged?: boolean }
): Promise<number> {
  if (!opts.displayNameChanged && !opts.avatarChanged) return 0;

  // The profile write has already succeeded at this point; the fanout is
  // strictly best-effort and must never fail (or even slow-fail) the
  // caller. Any unexpected environment failure aborts quietly — rooms
  // converge on the next change instead.
  try {
    const user = await getUserById(env.DB, userId);
    const roomIds = await getUserRooms(env.DB, userId, 'join');
    let updated = 0;

    for (const roomId of roomIds) {
      try {
        const membership = await getMembership(env.DB, roomId, userId);
        if (!membership || membership.membership !== 'join') continue;

        // Rooms whose ACL denies our server cannot accept our events —
        // skip them like the send cores do.
        if (!(await isServerAllowedInRoom(env.DB, roomId, env.SERVER_NAME))) continue;

        const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
        const powerLevelsEvent = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
        const authEvents: string[] = [];
        if (createEvent) authEvents.push(createEvent.event_id);
        if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
        if (membership) authEvents.push(membership.eventId);

        const { events: latestEvents } = await getRoomEvents(env.DB, roomId, undefined, 1);
        const prevEvents = latestEvents.map((e) => e.event_id);

        // Absent displayname/avatar_url means "no profile value" — omit.
        const content: Record<string, unknown> = { membership: 'join' };
        if (user?.display_name) content.displayname = user.display_name;
        if (user?.avatar_url) content.avatar_url = user.avatar_url;

        const event: PDU = {
          event_id: '',
          room_id: roomId,
          sender: userId,
          type: 'm.room.member',
          state_key: userId,
          content,
          origin_server_ts: Date.now(),
          depth: (latestEvents[0]?.depth ?? 0) + 1,
          auth_events: authEvents,
          prev_events: prevEvents,
        };

        const eventId = await prepareAndStoreLocalEvent(env, roomId, event);

        // Wake members' sync loops; remote delivery follows the standard
        // state pipeline (incl. the policy-server ask inside the core).
        await notifyUsersOfEvent(env, roomId, eventId, 'm.room.member');
        const destinations = await getJoinedRemoteServers(env.DB, roomId, env.SERVER_NAME);
        await federateLocalStateEventToRemotes(env, event, roomId, destinations);
        updated++;
      } catch (err) {
        console.warn('[rooms] profile member-event fanout failed for room', {
          roomId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return updated;
  } catch (err) {
    console.warn('[rooms] profile member-event fanout aborted:', err);
    return 0;
  }
}

async function prepareAndStoreLocalEvent(env: Env, roomId: string, event: PDU): Promise<string> {
  const room = await getRoom(env.DB, roomId);
  const roomVersion = String(room?.room_version ?? '10');
  if (isMsc4291RoomVersion(roomVersion)) {
    const stateRows = await env.DB.prepare(
      `SELECT e.event_id, e.event_type, e.state_key
       FROM room_state rs JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`
    ).bind(roomId).all<{ event_id: string; event_type: string; state_key: string | null }>();
    const targets = new Map<string, { type: string; stateKey: string }>();
    let createId: string | undefined;
    for (const r of stateRows.results) {
      targets.set(r.event_id, { type: r.event_type, stateKey: r.state_key ?? '' });
      if (r.event_type === 'm.room.create') createId = r.event_id;
    }
    const expected = expectedAuthTypes(
      event.type,
      event.sender,
      event.state_key,
      (event.content ?? {}) as Record<string, unknown>
    );
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const ref of event.auth_events ?? []) {
      if (ref === createId) continue;
      const t = targets.get(ref);
      if (!t) {
        if (!seen.has(ref)) {
          seen.add(ref);
          kept.push(ref);
        }
        continue;
      }
      if (expected.has(`${t.type}\u0000${t.stateKey}`)) {
        if (!seen.has(ref)) {
          seen.add(ref);
          kept.push(ref);
        }
      }
    }
    event.auth_events = kept;
    const stateTargets = new Map<string, string>();
    for (const [id, t] of targets) stateTargets.set(t.type + String.fromCharCode(0) + t.stateKey, id);
    augmentAuthEvents(event, stateTargets, true, createId);
    const prepared = await prepareOutboundPdu(env, event, roomVersion);
    if (!prepared) {
      throw new Error('[rooms] cannot derive v12 event ID without a signing key');
    }
    event.event_id = prepared.wireId;
    event.hashes = prepared.hashes as PDU['hashes'];
    event.signatures = prepared.signatures as PDU['signatures'];
  } else {
    const legacyState = await env.DB.prepare(
      `SELECT rs.event_id, e.event_type, e.state_key FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ?`
    ).bind(roomId).all<{ event_id: string; event_type: string; state_key: string | null }>();
    const legacyTargets = new Map<string, string>();
    let legacyCreateId: string | undefined;
    for (const r of legacyState.results ?? []) {
      legacyTargets.set(r.event_type + String.fromCharCode(0) + (r.state_key ?? ''), r.event_id);
      if (r.event_type === 'm.room.create') legacyCreateId = r.event_id;
    }
    augmentAuthEvents(event, legacyTargets, false, legacyCreateId);
    const prepared = await prepareOutboundPdu(env, event, roomVersion);
    if (prepared) {
      event.event_id = prepared.wireId;
      event.hashes = prepared.hashes as PDU['hashes'];
      event.signatures = prepared.signatures as PDU['signatures'];
    } else {
      event.event_id = await generateEventId(env.SERVER_NAME, roomVersion);
    }
  }

  // MSC4284 (spec v1.18): rooms using a policy server need its
  // countersignature on every event before storage/delivery — including
  // membership and state changes, exactly as the spec demands. The ask
  // happens AFTER the wire-ID derivation so the PS signs the final form
  // remote servers will verify. The m.room.policy state event itself is
  // exempt so the room can always disable a misbehaving PS. A refusal
  // fails the request with the PS's error verbatim (app.onError maps
  // MatrixApiError to its response).
  const policy = await getRoomPolicyServer(env.DB, roomId);
  if (policy && !eventExemptFromPolicy(event)) {
    const asked = await askPolicyServerSignature(
      env, policy, event as unknown as Record<string, unknown>
    );
    if ('signature' in asked) {
      attachPolicySignature(event as unknown as Record<string, unknown>, policy.via, asked.signature);
      // Validate the returned signature against the room's pinned key
      // before trusting it (spec SHOULD).
      const verified = await verifyPolicySignature(
        event as unknown as Record<string, unknown>,
        policy.via,
        policy.ed25519,
        String(room?.room_version ?? '10')
      );
      if (!verified) {
        throw new MatrixApiError(
          'M_UNKNOWN' as ErrorCode,
          'The policy server returned an invalid signature',
          502
        );
      }
    } else {
      throw new MatrixApiError(
        asked.errcode as ErrorCode,
        asked.error,
        asked.status === 429 ? 429 : asked.status === 403 ? 403 : 400
      );
    }
  }

  await storeEvent(env.DB, event);
  await fanoutEventToAppServices(env, event);
  return event.event_id;
}

/**
 * Build the initial m.room.create event for an MSC4291 room (version 12):
 * the create carries no room_id, its ID is "$" + reference hash of the create
 * itself, and the room ID is "!" + that same reference hash with no server
 * suffix (Synapse resolves its implicit create reference as "$" + room_id[1:]
 * and requires it to equal the create's event ID). The reference hash is
 * computed over the exact bytes federation will see (no room_id, no event_id,
 * no signatures/unsigned), so remote servers derive the same IDs.
 */
export async function buildMsc4291CreateEvent(
  roomVersion: string,
  creatorId: string,
  predecessor?: { room_id: string; event_id: string },
  creationContent?: Record<string, unknown>
): Promise<{ roomId: string; eventId: string; pduBase: Record<string, unknown>; hashes: Record<string, string> }> {
  // MSC4289: in v12 rooms the creator is implicit (the create event's
  // sender); matrix.org's own v12 creates carry no `creator` field. Client
  // creation_content keys are merged in, but server-owned fields win.
  const content: Record<string, unknown> = {
    ...(creationContent ?? {}),
    room_version: roomVersion,
  };
  delete content.creator;
  if (predecessor) {
    content.predecessor = predecessor;
  }
  const pduBase: Record<string, unknown> = {
    sender: creatorId,
    type: 'm.room.create',
    state_key: '',
    content,
    origin_server_ts: Date.now(),
    depth: 0,
    auth_events: [],
    prev_events: [],
  };
  const hashes = { sha256: await calculateContentHash(pduBase) };
  const refHash = await computeEventReferenceHash({ ...pduBase, hashes });
  return {
    roomId: msc4291RoomId(refHash),
    eventId: msc4291CreateEventId(refHash),
    pduBase,
    hashes,
  };
}

// Hand a wire PDU to the per-destination Federation DO, which signs the
// federation transaction, batches, retries with backoff, and tracks delivery.
async function queueFederationPdu(
  env: Env,
  destinations: string[],
  pdu: Record<string, unknown>,
  eventId: string,
  roomId: string
): Promise<void> {
  // Fan out in parallel batches; a large room can have hundreds of member
  // servers and sequential awaits would exceed the request budget.
  const BATCH = 25;
  for (let i = 0; i < destinations.length; i += BATCH) {
    const batch = destinations.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (destination) => {
      try {
        const fedDO = env.FEDERATION.get(env.FEDERATION.idFromName(destination));
        await fedDO.fetch(new Request('http://internal/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination, event_id: eventId, room_id: roomId, pdu }),
        }));
      } catch (err) {
        console.error(`[rooms] Federation queueing failed for ${destination}:`, err);
      }
    }));
  }
}

// Federate a locally-created state/membership event to the room's remote
// servers. Mirrors the message send path: refs translated from the stored ID
// space into the wire space, v4+ wire form derived (content hash, redacted
// signature), then queued through the Federation DO for alarm-batched
// delivery with retries. Without this, remote servers never see local
// membership transitions — a leave + re-join "heal" sends later messages
// referencing a join event the resident never received, so it rejects them
// ("missing auth event type m.room.member") and the room stays broken.
// Best-effort: never fails the caller.
async function federateLocalStateEventToRemotes(
  env: Env,
  event: PDU,
  roomId: string,
  destinations: string[]
): Promise<void> {
  if (destinations.length === 0) return;
  try {
    const room = await getRoom(env.DB, roomId);
    const roomVersion = String(room?.room_version ?? '10');
    const createIsImplicit = isMsc4291RoomVersion(roomVersion);
    const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
    const createEventId = createEvent?.event_id;

    const legacyWire = await legacyWireForRoom(env, roomId, roomVersion);
    let auth = event.auth_events ?? [];
    if (createIsImplicit && createEventId) auth = auth.filter((id) => id !== createEventId);
    let prev = event.prev_events ?? [];
    if (legacyWire) {
      auth = auth.map((id) => legacyWire.idMap.get(id) ?? id);
      prev = prev.map((id) => legacyWire.idMap.get(id) ?? id);
    }

    const prepared = await prepareOutboundPdu(
      env,
      { ...event, auth_events: auth, prev_events: prev } as PDU,
      roomVersion
    );
    if (!prepared) return;
    console.log(`[rooms] Federation state PDU prepared for ${prepared.wireId} -> ${destinations.join(', ')}`);
    await queueFederationPdu(env, destinations, prepared.wire, event.event_id, roomId);
  } catch (err) {
    console.error('[rooms] State event federation fanout failed:', err);
  }
}

// The state a receiving server needs to render an invite for its user
// (Matrix prejoin state). The m.room.create event is mandatory and enforced
// for room versions 12+ (MSC4311); the inviter's member event is included so
// the invitee can display their profile (MSC4319).
const INVITE_ROOM_STATE_TYPES: Array<[string, string]> = [
  ['m.room.create', ''],
  ['m.room.join_rules', ''],
  ['m.room.name', ''],
  ['m.room.topic', ''],
  ['m.room.avatar', ''],
  ['m.room.canonical_alias', ''],
  ['m.room.encryption', ''],
];

// Deliver an invite for a remote user through the federation invite endpoint.
// The invitee's server is not in the room yet, so the invite cannot travel in
// a /send transaction: receiving servers validate every invite_room_state
// entry as a full PDU (parse + hash + signature checks for room versions
// 12+) and reject the request when m.room.create is missing. Each entry is
// therefore prepared for the wire exactly like an outbound PDU.
async function federateInvite(env: Env, roomId: string, inviteEvent: PDU): Promise<boolean> {
  try {
    const invitee = inviteEvent.state_key ?? '';
    const domain = invitee.split(':').slice(1).join(':');
    if (!domain || domain === env.SERVER_NAME) return false;

    const room = await getRoom(env.DB, roomId);
    const roomVersion = String(room?.room_version ?? '10');
    const createIsImplicit = isMsc4291RoomVersion(roomVersion);
    const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
    const createEventId = createEvent?.event_id;

    // MSC4291 (room version 12): the create event is implicit and must not
    // appear in auth_events. Strip it from a copy, before hashing and
    // signing, so the prepared wire event is self-consistent.
    const legacyWire = await legacyWireForRoom(env, roomId, roomVersion);
    const forWire = (event: PDU): PDU => {
      let auth = event.auth_events ?? [];
      if (createIsImplicit && createEventId) auth = auth.filter((id) => id !== createEventId);
      let prev = event.prev_events ?? [];
      if (legacyWire) {
        auth = auth.map((id) => legacyWire.idMap.get(id) ?? id);
        prev = prev.map((id) => legacyWire.idMap.get(id) ?? id);
      }
      return { ...event, auth_events: auth, prev_events: prev };
    };

    const preparedInvite = await prepareOutboundPdu(env, forWire(inviteEvent), roomVersion);
    if (!preparedInvite) return false;

    const inviteRoomState: Record<string, unknown>[] = [];
    const stateEntries: Array<[string, string]> = [
      ...INVITE_ROOM_STATE_TYPES,
      ['m.room.member', inviteEvent.sender],
    ];
    for (const [type, stateKey] of stateEntries) {
      const stateEvent = await getStateEvent(env.DB, roomId, type, stateKey);
      if (!stateEvent) continue;
      const preparedState = await prepareOutboundPdu(env, forWire(stateEvent), roomVersion);
      if (!preparedState) continue;
      inviteRoomState.push(preparedState.wire);
    }

    // Receiving servers reject the invite when create is missing.
    if (!inviteRoomState.some((e) => e.type === 'm.room.create')) {
      console.error(`[rooms] Cannot federate invite for ${roomId}: no create event in room state`);
      return false;
    }

    const fedDO = env.FEDERATION.get(env.FEDERATION.idFromName(domain));
    await fedDO.fetch(new Request('http://internal/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination: domain,
        room_id: roomId,
        event_id: preparedInvite.wireId,
        room_version: roomVersion,
        event: preparedInvite.wire,
        invite_room_state: inviteRoomState,
      }),
    }));
    console.log(`[rooms] Federated invite ${preparedInvite.wireId} for ${invitee} to ${domain}`);
    return true;
  } catch (err) {
    console.error('[rooms] federateInvite failed:', err);
    return false;
  }
}

// PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId - Send message
// Core of PUT /rooms/:roomId/send, shared with MSC4140 delayed events so a
// delayed send travels the same auth, signing and federation path as an
// immediate one.
export async function performSendEvent(
  env: Env,
  roomId: string,
  userId: string,
  eventType: string,
  content: any,
  txnId?: string
): Promise<{ eventId: string; originServerTs: number } | { error: MatrixApiError }> {
  // Check membership
  const membership = await getMembership(env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return { error: Errors.forbidden('Not a member of this room') };
  }

  // Server ACL: a room whose ACL denies our server must not accept local
  // message sends either — remote participants would drop them anyway.
  if (!(await isServerAllowedInRoom(env.DB, roomId, env.SERVER_NAME))) {
    return { error: Errors.forbidden("This server is denied by the room's server ACL") };
  }

  const eventId = await generateEventId(env.SERVER_NAME);

  const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const room = await getRoom(env.DB, roomId);

  // In MSC4291 (room version 12), the create event is implicitly part of
  // every non-create event's auth chain and MUST NOT appear explicitly in
  // auth_events -- the receiving server's parser rejects such events. Older
  // versions require it explicitly.
  const roomVersionStr = String(room?.room_version ?? '');
  const createIsImplicit = isMsc4291RoomVersion(roomVersionStr);

  const authEvents: string[] = [];
  if (createEvent && !createIsImplicit) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (membership) authEvents.push(membership.eventId);

  // Prefer extending the remote side's chain. When the room's newest events
  // are our own (possibly undelivered) messages, pointing prev_events at them
  // makes the resident server fetch a chain it has never seen and then drop
  // the event silently (its /send returns 200 before background processing).
  // The newest event authored by another server is the safest parent: every
  // participant already has it.
  const { events: latestEvents } = await getRoomEvents(env.DB, roomId, undefined, 1);
  const remoteTip = await env.DB.prepare(
    `SELECT event_id, depth FROM events WHERE room_id = ? AND sender NOT LIKE ? ORDER BY origin_server_ts DESC LIMIT 1`
  ).bind(roomId, `%:${env.SERVER_NAME}`).first<{ event_id: string; depth: number }>();
  const parent = remoteTip ?? latestEvents[0] ?? null;
  let prevEvents = parent ? [parent.event_id] : [];

  // Legacy rooms we created store pre-fix events under v11-rule IDs;
  // reference the translated wire IDs so the new event is stored under the
  // same ID federation peers derive.
  const legacyWire = await legacyWireForRoom(env, roomId, roomVersionStr);
  let authEventsFinal = authEvents;
  if (legacyWire) {
    authEventsFinal = authEvents.map((id) => legacyWire.idMap.get(id) ?? id);
    prevEvents = prevEvents.map((id) => legacyWire.idMap.get(id) ?? id);
  }

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: eventType,
    content,
    origin_server_ts: Date.now(),
    unsigned: { transaction_id: txnId },
    depth: (parent?.depth ?? 0) + 1,
    auth_events: authEventsFinal,
    prev_events: prevEvents,
  };

  // Adapt to the v4+ wire format (reference-hash ID, no explicit event_id,
  // signatures over the redacted event) and store under the same derived ID
  // so our local view always matches resident servers' view. For MSC4291
  // room versions the derivation happens even with no remote members yet:
  // the stored ID must equal the served ID the moment a remote joins.
  const remoteServers = await getJoinedRemoteServers(env.DB, roomId, env.SERVER_NAME);
  let wirePdu: Record<string, unknown> | null = null;
  if (remoteServers.length > 0 || isMsc4291RoomVersion(roomVersionStr)) {
    const prepared = await prepareOutboundPdu(env, event, roomVersionStr);
    if (prepared) {
      event.event_id = prepared.wireId;
      (event as unknown as Record<string, unknown>).hashes = prepared.hashes;
      (event as unknown as Record<string, unknown>).signatures = prepared.signatures;
      if (remoteServers.length > 0) {
        wirePdu = prepared.wire;
        console.log(`[rooms] Federation wire PDU prepared for ${prepared.wireId} -> ${remoteServers.join(', ')}`);
      }
    }
  }

  // MSC4284 (spec v1.18): ask the room's policy server to countersign
  // before the event is stored or delivered. Same rules as the state
  // path in prepareAndStoreLocalEvent: post-derivation ask, exemption
  // for m.room.policy itself, refusals fail the request verbatim, and
  // the returned signature is validated against the room's pinned key.
  const policy = await getRoomPolicyServer(env.DB, roomId);
  if (policy && !eventExemptFromPolicy(event)) {
    const asked = await askPolicyServerSignature(
      env, policy, event as unknown as Record<string, unknown>
    );
    if ('signature' in asked) {
      attachPolicySignature(event as unknown as Record<string, unknown>, policy.via, asked.signature);
      const verified = await verifyPolicySignature(
        event as unknown as Record<string, unknown>,
        policy.via,
        policy.ed25519,
        roomVersionStr
      );
      if (!verified) {
        return {
          error: new MatrixApiError(
            'M_UNKNOWN' as ErrorCode,
            'The policy server returned an invalid signature',
            502
          ),
        };
      }
      if (wirePdu) {
        // Carry the countersignature on the wire alongside ours.
        wirePdu = { ...wirePdu, signatures: (event as unknown as Record<string, unknown>).signatures };
      }
    } else {
      return {
        error: new MatrixApiError(
          asked.errcode as ErrorCode,
          asked.error,
          asked.status === 429 ? 429 : asked.status === 403 ? 403 : 400
        ),
      };
    }
  }

  await storeEvent(env.DB, event);
  await fanoutEventToAppServices(env, event);

  // Notify all room members that a new message was sent (wakes up long-polling syncs)
  await notifyUsersOfEvent(env, roomId, event.event_id, eventType);

  // Durably queue the wire PDU for federation before responding (fast storage
  // puts, batched); the Federation DO alarm performs the actual delivery and
  // retries, so it survives even if waitUntil subrequests are cancelled.
  if (wirePdu) {
    await queueFederationPdu(env, remoteServers, wirePdu, event.event_id, roomId);
  }

  // Native bots and bridges act on the stored message. Best-effort: never
  // fails the client send. Bot replies re-enter this pipeline with a bot
  // sender, which every integration skips (loop prevention).
  if (eventType === 'm.room.message') {
    try {
      const { handleRoomMessage } = await import('../services/room-integrations');
      await handleRoomMessage(env, roomId, userId, content, 'local');
    } catch (err) {
      console.warn('[rooms] integrations hook failed:', err);
    }
  }

  return { eventId: event.event_id, originServerTs: event.origin_server_ts };
}

// PUT /_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId - Send message
app.put('/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const eventType = c.req.param('eventType');
  const txnId = c.req.param('txnId');

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // MSC4169 (stable since spec v1.18): redactions may also travel through
  // the generic /send endpoint with content { redacts, reason? }. They share
  // the /redact pipeline rather than the plain send path so the target event
  // actually gets marked redacted.
  if (eventType === 'm.room.redaction') {
    if (typeof content?.redacts !== 'string' || !content.redacts) {
      return Errors.missingParam('redacts').toResponse();
    }
    const result = await performRedaction(
      c.env, roomId, userId, content.redacts, content.reason, txnId,
      { suspended: c.get('auth')?.suspended ?? false }
    );
    if ('error' in result) return result.error.toResponse();
    return c.json({ event_id: result.eventId });
  }

  const result = await performSendEvent(c.env, roomId, userId, eventType, content, txnId);
  if ('error' in result) return result.error.toResponse();

  // Send push notifications via durable workflow (fire and forget)
  // Only for message and encrypted event types
  if (eventType === 'm.room.message' || eventType === 'm.room.encrypted') {
    c.executionCtx.waitUntil(
      c.env.PUSH_NOTIFICATION_WORKFLOW.create({
        params: {
          eventId: result.eventId,
          roomId,
          eventType,
          sender: userId,
          content,
          originServerTs: result.originServerTs,
        },
      }).catch(err => {
        console.error('[rooms] Push notification workflow error:', err);
      })
    );
  }

  return c.json({ event_id: result.eventId });
});

// POST /_matrix/client/v3/rooms/:roomId/invite - Invite a user
// Resolve a 3PID (email/msisdn) to an MXID: local account bindings first,
// then the built-in identity associations, then — when the client supplied
// id_server/id_access_token — a v2 identity-server lookup. Returns null when
// the 3PID is not bound anywhere, in which case the invite is stored as an
// m.room.third_party_invite state event for later redemption.
async function resolve3Pid(
  env: Env,
  medium: string,
  address: string,
  idServer?: string,
  idAccessToken?: string
): Promise<string | null> {
  const bound = await env.DB.prepare(
    `SELECT user_id FROM user_threepids WHERE medium = ? AND address = ?`
  ).bind(medium, address).first<{ user_id: string }>();
  if (bound) return bound.user_id;

  const assoc = await env.DB.prepare(
    `SELECT mxid FROM identity_associations WHERE medium = ? AND address = ?`
  ).bind(medium, address).first<{ mxid: string }>();
  if (assoc) return assoc.mxid;

  if (idServer && idAccessToken && idServer !== env.SERVER_NAME) {
    try {
      const base = `https://${idServer}/_matrix/identity/v2`;
      const headers = {
        Authorization: `Bearer ${idAccessToken}`,
        'Content-Type': 'application/json',
      };
      const detailsRes = await fetch(`${base}/hash_details`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (detailsRes.ok) {
        const details = await detailsRes.json() as { lookup_pepper: string; algorithms: string[] };
        if (details.algorithms?.includes('sha256')) {
          const hash = await sha256(`${address} ${medium} ${details.lookup_pepper}`);
          const lookupRes = await fetch(`${base}/lookup`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ algorithm: 'sha256', pepper: details.lookup_pepper, addresses: [hash] }),
            signal: AbortSignal.timeout(10_000),
          });
          if (lookupRes.ok) {
            const { mappings } = await lookupRes.json() as { mappings: Record<string, string> };
            if (mappings?.[hash]) return mappings[hash];
          }
        }
      }
    } catch (err) {
      console.warn('[rooms] Identity server 3PID lookup failed:', err);
    }
  }

  return null;
}

// Store an m.room.third_party_invite state event (token as state_key) when
// the invited 3PID has no known MXID. Federates like any other state event;
// redemption happens via /exchange_third_party_invite once the invitee's
// identity server signs the bind.
async function storeThirdPartyInvite(
  c: Context<AppEnv>,
  roomId: string,
  sender: string,
  membershipEventId: string,
  address: string
): Promise<Response> {
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = getEffectiveUserPowerLevel(powerLevels, sender, createEvent);
  const invitePower = powerLevels.invite ?? 50;
  if (userPower < invitePower) {
    return Errors.forbidden('Insufficient power level to invite').toResponse();
  }

  const room = await getRoom(c.env.DB, roomId);
  const createIsImplicit = isMsc4291RoomVersion(String(room?.room_version ?? '10'));

  const authEvents: string[] = [];
  if (createEvent && !createIsImplicit) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  authEvents.push(membershipEventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);

  const token = await generateOpaqueId(32);
  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender,
    type: 'm.room.third_party_invite',
    state_key: token,
    content: { display_name: address },
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: latestEvents.map(e => e.event_id),
  };

  // Optimistic concurrency, same as the MXID invite path.
  const powerLevelsNow = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');
  if ((powerLevelsEvent?.event_id ?? null) !== (powerLevelsNow?.event_id ?? null)) {
    return Errors.conflict('Power levels changed during invite; retry').toResponse();
  }

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await notifyUsersOfEvent(c.env, roomId, eventId, 'm.room.third_party_invite');
  return c.json({});
}

type InviteOutcome = { eventId: string } | { error: MatrixApiError };

// Shared MXID invite path used by POST /invite and by room upgrades. Keeps
// invite permissions, moderation policy, the policy-server ask (inside
// prepareAndStoreLocalEvent), membership/notification updates and federation
// in one place so upgrade invites are ordinary invites, not bare member rows.
async function performRoomInvite(
  env: Env,
  roomId: string,
  inviterId: string,
  inviteeId: string,
  inviterMembership: { membership: string; eventId: string }
): Promise<InviteOutcome> {
  // MSC4155: the invitee's invite permission config can block this inviter.
  if ((await getInvitePermission(env.DB, inviteeId, inviterId)) === 'block') {
    return { error: Errors.inviteBlocked() };
  }

  // Moderation policy lists (spec module): no invites to banned users or
  // onto banned servers ("no outbound invites").
  {
    const modRules = await getActivePolicyRules(env.DB, env.CACHE);
    if (modRules.subscriptions > 0) {
      const bannedUser = isUserBannedByPolicy(modRules, inviteeId);
      const bannedServer = isServerBannedByPolicy(modRules, serverNameFromId(inviteeId));
      if (bannedUser || bannedServer) {
        return {
          error: Errors.forbidden(
            `The invitee is banned by a moderation policy list (${bannedUser?.reason || bannedServer?.reason || 'banned entity'})`
          ),
        };
      }
    }
  }

  // Check power levels (captured at check-time; re-validated just before write
  // for optimistic concurrency — see issue 009 sub-finding 3).
  const createEventForPower = await getStateEvent(env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = getEffectiveUserPowerLevel(powerLevels, inviterId, createEventForPower);
  const invitePower = powerLevels.invite ?? 50;

  if (userPower < invitePower) {
    return { error: Errors.forbidden('Insufficient power level to invite') };
  }

  // Check if already invited or joined
  const inviteeMembership = await getMembership(env.DB, roomId, inviteeId);
  if (inviteeMembership?.membership === 'join') {
    return { error: Errors.forbidden('User is already in the room') };
  }
  if (inviteeMembership?.membership === 'invite') {
    // Already invited, idempotent -- but re-federate the existing invite so a
    // retry reaches the invitee's server even when the original delivery
    // failed (or predates invite federation).
    const existingInvite = await getStateEvent(env.DB, roomId, 'm.room.member', inviteeId);
    if (existingInvite) await federateInvite(env, roomId, existingInvite);
    return { eventId: existingInvite?.event_id ?? '' };
  }

  // Create invite event
  const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');

  // MSC4291 (room version 12): the create event is implicit in the auth
  // chain and must not be listed explicitly.
  const inviteRoom = await getRoom(env.DB, roomId);
  const inviteRoomVersion = String(inviteRoom?.room_version ?? '10');
  const inviteCreateIsImplicit = isMsc4291RoomVersion(inviteRoomVersion);

  const authEvents: string[] = [];
  if (createEvent && !inviteCreateIsImplicit) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (inviterMembership) authEvents.push(inviterMembership.eventId);

  const { events: latestEvents = [] } = await getRoomEvents(env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map((e) => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'invite',
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: inviterId,
    type: 'm.room.member',
    state_key: inviteeId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Optimistic concurrency: re-read power levels just before writing.
  const powerLevelsNow = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  if ((powerLevelsEvent?.event_id ?? null) !== (powerLevelsNow?.event_id ?? null)) {
    return { error: Errors.conflict('Power levels changed during invite; retry') };
  }

  const eventId = await prepareAndStoreLocalEvent(env, roomId, event);
  await updateMembership(env.DB, roomId, inviteeId, 'invite', eventId);

  // Notify room members and the invitee about the invite
  await notifyUsersOfEvent(env, roomId, eventId, 'm.room.member');

  // Federate the invite to the invitee's server: they are not in the room
  // yet, so it travels via the federation invite endpoint rather than a
  // /send transaction.
  await federateInvite(env, roomId, event);

  // Bot auto-accept: the homeserver completes the join for invited bots —
  // they have no client session to accept with.
  try {
    const { getBotByUserId } = await import('../services/bots');
    const bot = await getBotByUserId(env.DB, inviteeId);
    if (bot) {
      await joinBotUserToRoom(env, roomId, inviteeId);
      console.log('[rooms] bot auto-accepted invite', { roomId, bot: inviteeId });
    }
  } catch (err) {
    console.warn('[rooms] bot auto-accept failed:', err);
  }

  return { eventId };
}

app.post('/_matrix/client/v3/rooms/:roomId/invite', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check inviter membership
  const inviterMembership = await getMembership(c.env.DB, roomId, userId);
  if (!inviterMembership || inviterMembership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  let inviteeId: string | undefined = body.user_id;

  // inviteBy3PID: resolve medium/address to an MXID, or store a
  // third_party_invite state event when it is not bound anywhere.
  if (!inviteeId) {
    if (!body.medium || !body.address) {
      return Errors.missingParam('user_id (or medium and address)').toResponse();
    }
    if (body.medium !== 'email' && body.medium !== 'msisdn') {
      return Errors.invalidParam('medium', 'medium must be "email" or "msisdn"').toResponse();
    }
    const resolved = await resolve3Pid(c.env, body.medium, body.address, body.id_server, body.id_access_token);
    if (!resolved) {
      return storeThirdPartyInvite(c, roomId, userId, inviterMembership.eventId, body.address);
    }
    inviteeId = resolved;
  }

  const result = await performRoomInvite(c.env, roomId, userId, inviteeId, inviterMembership);
  if ('error' in result) return result.error.toResponse();
  return c.json({});
});

// GET /_matrix/client/unstable/uk.half-shot.msc2666/query_mutual_rooms/:userId
// MSC2666 (advertised in /versions unstable_features): rooms that both the
// requesting user and the target user have joined.
app.get('/_matrix/client/unstable/uk.half-shot.msc2666/query_mutual_rooms/:userId', requireAuth(), async (c) => {
  const requester = c.get('userId');
  const target = c.req.param('userId');

  const targetUser = await getUserById(c.env.DB, target);
  if (!targetUser) {
    return Errors.notFound('User not found').toResponse();
  }

  const rows = await c.env.DB.prepare(
    `SELECT a.room_id FROM room_memberships a
     JOIN room_memberships b ON a.room_id = b.room_id
     WHERE a.user_id = ? AND a.membership = 'join'
       AND b.user_id = ? AND b.membership = 'join'`
  ).bind(requester, target).all<{ room_id: string }>();

  return c.json({ joined: rows.results.map(r => r.room_id) });
});

// GET /_matrix/client/v1/mutual_rooms - MSC2666 (stable since spec v1.19)
// Rooms where both the authenticated user and ?user_id= have membership
// 'join'. Batched by room_id cursor; `from` continues from a previous
// response's next_batch. An unknown target user is NOT an error: the spec
// requires an empty 200 so callers cannot probe for account existence.
const MUTUAL_ROOMS_BATCH_SIZE = 500;
app.get('/_matrix/client/v1/mutual_rooms', requireAuth(), async (c) => {
  const requester = c.get('userId');
  const target = c.req.query('user_id');
  const from = c.req.query('from');

  if (!target) {
    return Errors.missingParam('user_id').toResponse();
  }
  if (target === requester) {
    return Errors.invalidParam('user_id', 'Cannot check mutual rooms with yourself').toResponse();
  }
  if (!parseUserId(target)) {
    return Errors.invalidParam('user_id', 'The user ID provided was invalid').toResponse();
  }
  if (from !== undefined && from !== '' && !from.startsWith('!')) {
    return Errors.invalidParam('from', 'The from token provided was invalid').toResponse();
  }

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM room_memberships a
     JOIN room_memberships b ON a.room_id = b.room_id
     WHERE a.user_id = ? AND a.membership = 'join'
       AND b.user_id = ? AND b.membership = 'join'`
  ).bind(requester, target).first<{ total: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT a.room_id FROM room_memberships a
     JOIN room_memberships b ON a.room_id = b.room_id
     WHERE a.user_id = ? AND a.membership = 'join'
       AND b.user_id = ? AND b.membership = 'join'
       AND a.room_id > ?
     ORDER BY a.room_id ASC LIMIT ?`
  ).bind(requester, target, from ?? '', MUTUAL_ROOMS_BATCH_SIZE + 1)
    .all<{ room_id: string }>();

  const hasMore = rows.results.length > MUTUAL_ROOMS_BATCH_SIZE;
  const batch = rows.results.slice(0, MUTUAL_ROOMS_BATCH_SIZE);

  const response: {
    count: number;
    joined: string[];
    next_batch?: string;
  } = {
    count: countRow?.total ?? batch.length,
    joined: batch.map(r => r.room_id),
  };
  if (hasMore && batch.length > 0) {
    response.next_batch = batch[batch.length - 1].room_id;
  }

  return c.json(response);
});

// POST /_matrix/client/v3/rooms/:roomId/kick - Kick a user
app.post('/_matrix/client/v3/rooms/:roomId/kick', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id: targetId, reason } = body;
  if (!targetId) {
    return Errors.missingParam('user_id').toResponse();
  }

  // Check kicker membership
  const kickerMembership = await getMembership(c.env.DB, roomId, userId);
  if (!kickerMembership || kickerMembership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Check target membership
  const targetMembership = await getMembership(c.env.DB, roomId, targetId);
  if (!targetMembership || targetMembership.membership !== 'join') {
    return Errors.forbidden('User is not in the room').toResponse();
  }

  // Check power levels
  const createEventForPower = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = getEffectiveUserPowerLevel(powerLevels, userId, createEventForPower);
  const targetPower = getEffectiveUserPowerLevel(powerLevels, targetId, createEventForPower);
  const kickPower = powerLevels.kick ?? 50;

  if (userPower < kickPower || userPower <= targetPower) {
    return Errors.forbidden('Insufficient power level to kick').toResponse();
  }

  // Create leave event for target
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (kickerMembership) authEvents.push(kickerMembership.eventId);
  if (targetMembership) authEvents.push(targetMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'leave',
    reason,
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: targetId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Destinations must be captured BEFORE the target's membership row flips
  // to leave, and must include the target's server: it is still a room member
  // at the event's point in the DAG and its server must learn of the kick.
  const targetDomain = targetId.includes(':') ? targetId.slice(targetId.indexOf(':') + 1) : '';
  const kickRemoteServers = await getJoinedRemoteServers(c.env.DB, roomId, c.env.SERVER_NAME);
  const kickDestinations =
    targetDomain && targetDomain !== c.env.SERVER_NAME && !kickRemoteServers.includes(targetDomain)
      ? [...kickRemoteServers, targetDomain]
      : kickRemoteServers;

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(c.env.DB, roomId, targetId, 'leave', eventId);

  // Notify room members about the kick
  await notifyUsersOfEvent(c.env, roomId, eventId, 'm.room.member');

  await federateLocalStateEventToRemotes(c.env, event, roomId, kickDestinations);

  // MSC4267: a kicked local user has their room forgotten transparently.
  await autoForgetLeftRoom(c.env, roomId, targetId);

  return c.json({});
});

// POST /_matrix/client/v3/rooms/:roomId/ban - Ban a user
app.post('/_matrix/client/v3/rooms/:roomId/ban', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id: targetId, reason } = body;
  if (!targetId) {
    return Errors.missingParam('user_id').toResponse();
  }

  // Check banner membership
  const bannerMembership = await getMembership(c.env.DB, roomId, userId);
  if (!bannerMembership || bannerMembership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Check power levels
  const createEventForPower = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = getEffectiveUserPowerLevel(powerLevels, userId, createEventForPower);
  const targetPower = getEffectiveUserPowerLevel(powerLevels, targetId, createEventForPower);
  const banPower = powerLevels.ban ?? 50;

  if (userPower < banPower || userPower <= targetPower) {
    return Errors.forbidden('Insufficient power level to ban').toResponse();
  }

  // Create ban event
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');
  const targetMembership = await getMembership(c.env.DB, roomId, targetId);

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (bannerMembership) authEvents.push(bannerMembership.eventId);
  if (targetMembership) authEvents.push(targetMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'ban',
    reason,
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: targetId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  // Destinations before the target's row flips to ban; the target's server
  // must still learn of the ban.
  const banTargetDomain = targetId.includes(':') ? targetId.slice(targetId.indexOf(':') + 1) : '';
  const banRemoteServers = await getJoinedRemoteServers(c.env.DB, roomId, c.env.SERVER_NAME);
  const banDestinations =
    banTargetDomain && banTargetDomain !== c.env.SERVER_NAME && !banRemoteServers.includes(banTargetDomain)
      ? [...banRemoteServers, banTargetDomain]
      : banRemoteServers;

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(c.env.DB, roomId, targetId, 'ban', eventId);

  // Notify room members about the ban
  await notifyUsersOfEvent(c.env, roomId, eventId, 'm.room.member');

  await federateLocalStateEventToRemotes(c.env, event, roomId, banDestinations);

  // MSC4267: a banned local user has their room forgotten transparently.
  await autoForgetLeftRoom(c.env, roomId, targetId);

  return c.json({});
});

// POST /_matrix/client/v3/rooms/:roomId/unban - Unban a user
app.post('/_matrix/client/v3/rooms/:roomId/unban', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id: targetId, reason } = body;
  if (!targetId) {
    return Errors.missingParam('user_id').toResponse();
  }

  // Check unbanner membership
  const unbannerMembership = await getMembership(c.env.DB, roomId, userId);
  if (!unbannerMembership || unbannerMembership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Check target is actually banned
  const targetMembership = await getMembership(c.env.DB, roomId, targetId);
  if (!targetMembership || targetMembership.membership !== 'ban') {
    return Errors.forbidden('User is not banned').toResponse();
  }

  // Check power levels
  const powerLevelsEvent = await getStateEvent(c.env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = powerLevels.users?.[userId] ?? powerLevels.users_default ?? 0;
  const banPower = powerLevels.ban ?? 50;

  if (userPower < banPower) {
    return Errors.forbidden('Insufficient power level to unban').toResponse();
  }

  // Create leave event (unban sets membership to leave)
  const createEvent = await getStateEvent(c.env.DB, roomId, 'm.room.create');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (unbannerMembership) authEvents.push(unbannerMembership.eventId);
  if (targetMembership) authEvents.push(targetMembership.eventId);

  const { events: latestEvents } = await getRoomEvents(c.env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const memberContent: RoomMemberContent = {
    membership: 'leave',
    reason,
  };

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: targetId,
    content: memberContent,
    origin_server_ts: Date.now(),
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(c.env, roomId, event);
  await updateMembership(c.env.DB, roomId, targetId, 'leave', eventId);

  // Notify room members about the unban
  await notifyUsersOfEvent(c.env, roomId, eventId, 'm.room.member');

  const unbanDestinations = await getJoinedRemoteServers(c.env.DB, roomId, c.env.SERVER_NAME);
  await federateLocalStateEventToRemotes(c.env, event, roomId, unbanDestinations);

  // MSC4267: the unbanned local user lands in 'leave' — forget it, matching
  // the auto-forget behavior advertised via m.forget_forced_upon_leave.
  await autoForgetLeftRoom(c.env, roomId, targetId);

  return c.json({});
});

// MSC4267 (stable since spec v1.18): with the m.forget_forced_upon_leave
// capability advertised as enabled, the server forgets rooms the moment a
// local user's membership ends — self-leave, kick, ban, unban and the same
// transitions arriving over federation — exactly as if the user had called
// /forget. Remote users are never touched: their membership rows are this
// server's record of remote room state, not a local view preference.
async function autoForgetLeftRoom(env: Env, roomId: string, userId: string): Promise<void> {
  const domain = userId.includes(':') ? userId.slice(userId.indexOf(':') + 1) : '';
  if (!domain || domain !== env.SERVER_NAME) return;
  await env.DB.prepare(
    `DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?`
  ).bind(roomId, userId).run();
}

// POST /_matrix/client/v3/rooms/:roomId/forget - Forget a room
app.post('/_matrix/client/v3/rooms/:roomId/forget', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  // Check that user has left the room
  const membership = await getMembership(db, roomId, userId);
  if (membership && membership.membership === 'join') {
    return Errors.forbidden('Cannot forget room while still a member').toResponse();
  }

  // Remove membership record entirely
  await db.prepare(`
    DELETE FROM room_memberships WHERE room_id = ? AND user_id = ?
  `).bind(roomId, userId).run();

  return c.json({});
});

// Core redaction pipeline, shared by PUT /redact and (since spec v1.18 /
// MSC4169) by m.room.redaction events sent through the generic /send
// endpoint. Applies the same membership, target-existence and power checks
// in both shapes.
async function performRedaction(
  env: Env,
  roomId: string,
  userId: string,
  targetEventId: string,
  reason?: string,
  txnId?: string,
  opts?: { suspended?: boolean }
): Promise<{ eventId: string } | { error: MatrixApiError }> {
  // Check membership
  const membership = await getMembership(env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return { error: Errors.forbidden('Not a member of this room') };
  }

  // Server ACL: same self-enforcement as the other send cores.
  if (!(await isServerAllowedInRoom(env.DB, roomId, env.SERVER_NAME))) {
    return { error: Errors.forbidden("This server is denied by the room's server ACL") };
  }

  // Get the target event
  const targetEvent = await getEvent(env.DB, targetEventId);
  if (!targetEvent || targetEvent.room_id !== roomId) {
    return { error: Errors.notFound('Event not found') };
  }

  // Check power levels for redaction
  const powerLevelsEvent = await getStateEvent(env.DB, roomId, 'm.room.power_levels');
  const powerLevels = powerLevelsEvent?.content as any || {};
  const userPower = powerLevels.users?.[userId] ?? powerLevels.users_default ?? 0;
  const redactPower = powerLevels.redact ?? 50;

  // Users can redact their own messages, or need redact power level
  if (targetEvent.sender !== userId && userPower < redactPower) {
    return { error: Errors.forbidden('Insufficient power level to redact') };
  }

  // MSC4323: suspended accounts may redact only their own events. The
  // middleware lets m.room.redaction through /send and /redact; this is
  // the point where the target's sender is actually known.
  if (opts?.suspended && targetEvent.sender !== userId) {
    return { error: Errors.userSuspended() };
  }

  // Create redaction event
  const createEvent = await getStateEvent(env.DB, roomId, 'm.room.create');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (membership) authEvents.push(membership.eventId);

  const { events: latestEvents } = await getRoomEvents(env.DB, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  const redactionContent: any = {
    redacts: targetEventId,
  };
  if (reason) {
    redactionContent.reason = reason;
  }

  const event: PDU = {
    event_id: '',
    room_id: roomId,
    sender: userId,
    type: 'm.room.redaction',
    content: redactionContent,
    redacts: targetEventId,
    origin_server_ts: Date.now(),
    unsigned: { transaction_id: txnId },
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventId = await prepareAndStoreLocalEvent(env, roomId, event);

  // Mark the original event as redacted and store the pruned client view.
  // The original `content` column is untouched: federation hashes and
  // signatures are computed over it, and remote servers receive the
  // original PDU form.
  const roomRow = await getRoom(env.DB, roomId);
  await applyEventRedaction(
    env.DB,
    roomId,
    String(roomRow?.room_version ?? '10'),
    {
      eventId,
      sender: userId,
      originServerTs: event.origin_server_ts,
      content: redactionContent,
    },
    targetEventId
  );

  // Federate the redaction event so remote servers apply the redaction
  // too (the storage core only persists locally). Same wire pipeline as
  // message sends; destinations are already ACL-filtered.
  const redactionDestinations = await getJoinedRemoteServers(env.DB, roomId, env.SERVER_NAME);
  if (redactionDestinations.length > 0) {
    const prepared = await prepareOutboundPdu(env, event, String(roomRow?.room_version ?? '10'));
    if (prepared) {
      event.event_id = prepared.wireId;
      event.hashes = prepared.hashes as PDU['hashes'];
      event.signatures = prepared.signatures as PDU['signatures'];
      await queueFederationPdu(
        env, redactionDestinations, prepared.wire, event.event_id, roomId
      );
    }
  }

  // Notify room members about the redaction
  await notifyUsersOfEvent(env, roomId, eventId, 'm.room.redaction');

  return { eventId };
}

// PUT /_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId - Redact an event
app.put('/_matrix/client/v3/rooms/:roomId/redact/:eventId/:txnId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const targetEventId = c.req.param('eventId');
  const txnId = c.req.param('txnId');

  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional for redaction
  }

  const result = await performRedaction(
    c.env, roomId, userId, targetEventId, body.reason, txnId,
    { suspended: c.get('auth')?.suspended ?? false }
  );
  if ('error' in result) return result.error.toResponse();

  return c.json({ event_id: result.eventId });
});

// GET /_matrix/client/v3/rooms/:roomId/context/:eventId - Get context around an event
// NOTE: This endpoint is used by Element X NSE (Notification Service Extension) to fetch
// event content for rich push notifications. If you see this endpoint being called
// shortly after a push notification is sent, that's the NSE working correctly.
app.get('/_matrix/client/v3/rooms/:roomId/context/:eventId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const eventId = c.req.param('eventId');
  const limit = Math.min(parseInt(c.req.query('limit') || '10'), 100);
  const beforeParam = c.req.query('before');
  const afterParam = c.req.query('after');
  const clampSideLimit = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 0), 100);
  };
  const userAgent = c.req.header('User-Agent');

  // NSE Detection logging - /context is a key endpoint for push notification content
  // NSE typically requests small limit (1-5) for single event context
  const isLikelyNSE = limit <= 5;
  console.log('[rooms/context] Request:', {
    userId,
    roomId,
    eventId,
    limit,
    userAgent: userAgent?.substring(0, 100),
    isLikelyNSE,
    timestamp: new Date().toISOString(),
  });

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    console.log('[rooms/context] DENIED - not a member:', { userId, roomId, eventId });
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Get the target event
  const targetEvent = await getEvent(c.env.DB, eventId);
  if (!targetEvent || targetEvent.room_id !== roomId) {
    console.log('[rooms/context] Event not found:', { eventId, roomId, eventRoomId: targetEvent?.room_id });
    return Errors.notFound('Event not found').toResponse();
  }

  // Redacted targets serve their pruned content in the client view.
  const targetPruned = await c.env.DB.prepare(
    `SELECT redacted_content FROM events WHERE event_id = ?`
  ).bind(eventId).first<{ redacted_content: string | null }>();
  const targetForFormat = targetPruned?.redacted_content
    ? { ...targetEvent, redacted_content: targetPruned.redacted_content }
    : targetEvent;

  console.log('[rooms/context] Found event:', {
    eventId,
    eventType: targetEvent.type,
    sender: targetEvent.sender,
    timestamp: targetEvent.origin_server_ts,
  });

  // Get events before and after. before/after override the even split of
  // limit when supplied; either side may be requested independently.
  const halfLimit = Math.floor(limit / 2);
  const beforeLimit = clampSideLimit(beforeParam) ?? halfLimit;
  const afterLimit = clampSideLimit(afterParam) ?? halfLimit;

  const eventsBefore = await c.env.DB.prepare(`
    SELECT * FROM events WHERE room_id = ? AND origin_server_ts < ?
    ORDER BY origin_server_ts DESC LIMIT ?
  `).bind(roomId, targetEvent.origin_server_ts, beforeLimit).all();

  const eventsAfter = await c.env.DB.prepare(`
    SELECT * FROM events WHERE room_id = ? AND origin_server_ts > ?
    ORDER BY origin_server_ts ASC LIMIT ?
  `).bind(roomId, targetEvent.origin_server_ts, afterLimit).all();

  // Format events. getEvent returns already-parsed content while raw D1 rows
  // carry JSON text; accepting both avoids "[object Object]" parse 500s.
  const parseContent = (raw: unknown) => {
    if (raw == null) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
  const formatEvent = (e: any) => ({
    type: e.event_type,
    state_key: e.state_key,
    content: parseContent(e.redacted_content || e.content || '{}'),
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  });

  // Get current state
  const state = await getRoomState(c.env.DB, roomId);
  const stateEvents = state.map(e => ({
    type: e.type,
    state_key: e.state_key,
    content: parseContent(e.content),
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
  }));

  return c.json({
    event: formatEvent(targetForFormat),
    events_before: eventsBefore.results.reverse().map(formatEvent),
    events_after: eventsAfter.results.map(formatEvent),
    state: stateEvents,
    start: eventsBefore.results.length > 0 ? String(eventsBefore.results[0].origin_server_ts) : undefined,
    end: eventsAfter.results.length > 0 ? String(eventsAfter.results[eventsAfter.results.length - 1].origin_server_ts) : undefined,
  });
});

// GET /_matrix/client/v3/rooms/:roomId/joined_members - Get joined members with details
app.get('/_matrix/client/v3/rooms/:roomId/joined_members', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');

  // Check membership
  const membership = await getMembership(c.env.DB, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const members = await c.env.DB.prepare(`
    SELECT user_id, display_name, avatar_url
    FROM room_memberships
    WHERE room_id = ? AND membership = 'join'
  `).bind(roomId).all<{
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>();

  const joined: Record<string, { display_name?: string; avatar_url?: string }> = {};
  for (const member of members.results) {
    joined[member.user_id] = {
      display_name: member.display_name || undefined,
      avatar_url: member.avatar_url || undefined,
    };
  }

  return c.json({ joined });
});

// GET /_matrix/client/v3/rooms/:roomId/aliases - Get room aliases
app.get('/_matrix/client/v3/rooms/:roomId/aliases', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  // Check membership
  const membership = await getMembership(db, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  const aliases = await db.prepare(`
    SELECT alias FROM room_aliases WHERE room_id = ?
  `).bind(roomId).all<{ alias: string }>();

  return c.json({
    aliases: aliases.results.map(a => a.alias),
  });
});

// POST /_matrix/client/v3/join/:roomIdOrAlias - Join room by ID or alias
app.post('/_matrix/client/v3/join/:roomIdOrAlias', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomIdOrAlias = decodeURIComponent(c.req.param('roomIdOrAlias'));
  const db = c.env.DB;

  let roomId: string;
  let aliasServers: string[] | null = null;

  // Determine if it's an alias or room ID. Aliases may be local or hosted on
  // another server; remote aliases resolve via federation query/directory.
  if (roomIdOrAlias.startsWith('#')) {
    // Moderation policy lists (spec module): policy rules can name the
    // ALIAS itself, and a banned alias may be unresolvable on purpose —
    // check before attempting federation resolution.
    {
      const modRules = await getActivePolicyRules(db, c.env.CACHE);
      if (modRules.subscriptions > 0) {
        const bannedByAlias = isRoomBannedByPolicy(modRules, roomIdOrAlias);
        if (bannedByAlias) {
          return Errors.forbidden(
            `This room is banned by a moderation policy list (${bannedByAlias.reason || bannedByAlias.entity})`
          ).toResponse();
        }
      }
    }
    const resolved = await getRoomByAlias(db, roomIdOrAlias);
    if (resolved) {
      roomId = resolved;
    } else {
      const remote = await resolveRemoteAlias(c.env, roomIdOrAlias);
      if (!remote) {
        return Errors.notFound('Room alias not found').toResponse();
      }
      roomId = remote.roomId;
      aliasServers = remote.servers;
    }
  } else {
    roomId = roomIdOrAlias;
  }

  const room = await getRoom(db, roomId);

  // Moderation policy lists (spec module): banned rooms are not joinable
  // by our users; aliases are checked in both forms (the spec's rules can
  // name either).
  {
    const modRules = await getActivePolicyRules(c.env.DB, c.env.CACHE);
    if (modRules.subscriptions > 0) {
      const bannedRoom =
        isRoomBannedByPolicy(modRules, roomId) ??
        (roomIdOrAlias.startsWith('#')
          ? isRoomBannedByPolicy(modRules, roomIdOrAlias)
          : null);
      if (bannedRoom) {
        return Errors.forbidden(
          `This room is banned by a moderation policy list (${bannedRoom.reason || bannedRoom.entity})`
        ).toResponse();
      }
    }
  }

  // Remote rooms (incl. v12 suffix-less IDs and rooms unknown locally) must
  // complete the federation handshake with the resident server.
  const residentServer =
    getServerFromRoomId(roomId) ??
    (room ? await getRoomResidentServer(db, roomId) : null) ??
    (aliasServers ? aliasServers[0] : null);
  if (residentServer && residentServer !== c.env.SERVER_NAME) {
    const mem = room ? await getMembership(db, roomId, userId) : null;
    if (!mem || mem.membership === 'invite' || mem.membership === 'leave') {
      if (!room) await ensureRemoteRoomRow(db, roomId, userId);
      // Fallback join candidates beyond the resident/alias servers: the
      // inviter's server and other participating servers (the resident domain
      // can be dead while they serve make_join fine).
      const fallbackServers = await joinFallbackServers(
        db, roomId, c.env.SERVER_NAME, mem?.eventId
      );
      const sinceStreamOrdering = await joinStreamWatermark(db, roomId);
      const instance = await c.env.ROOM_JOIN_WORKFLOW.create({
        params: { roomId, userId, isRemote: true, remoteServer: residentServer, servers: [...(aliasServers ?? []), ...fallbackServers], backfill: true, sinceStreamOrdering },
      });
      try {
        const status = await instance.status();
        if (status.status === 'running' || status.status === 'queued') {
          return c.json({ room_id: roomId });
        }
        const output = status.output as { success?: boolean } | undefined;
        if (status.status === 'complete' && output?.success) {
          await syncRoomVersionFromCreate(db, roomId);
          return c.json({ room_id: roomId });
        }
        return Errors.unknown('Failed to join remote room').toResponse();
      } catch (err) {
        console.error('[rooms] Workflow error', { roomId, error: err });
        return Errors.unknown('Failed to join remote room').toResponse();
      }
    }
  }

  // Local rooms must exist; remote unknown rooms were handled above.
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check current membership
  const currentMembership = await getMembership(db, roomId, userId);

  // Check join rules
  const joinRulesEvent = await getStateEvent(db, roomId, 'm.room.join_rules');
  const joinRule = (joinRulesEvent?.content as any)?.join_rule || 'invite';

  const restrictedDecision = await evaluateLocalRestrictedJoin({
    env: c.env,
    roomId,
    roomVersion: room.room_version,
    userId,
    joinRule,
    hasInvite: currentMembership?.membership === 'invite',
  });
  if (restrictedDecision?.error) {
    return Errors.forbidden(
      joinRule === 'knock_restricted'
        ? `${restrictedDecision.error}. Knock to request access instead.`
        : restrictedDecision.error
    ).toResponse();
  }

  // Determine if user can join
  let canJoin = false;
  if (joinRule === 'public') {
    canJoin = true;
  } else if (currentMembership?.membership === 'invite') {
    canJoin = true;
  } else if (currentMembership?.membership === 'join') {
    return c.json({ room_id: roomId });
  } else if (restrictedDecision?.authorizedBy) {
    canJoin = true;
  }

  if (!canJoin) {
    return Errors.forbidden('Cannot join room').toResponse();
  }

  const createEvent = await getStateEvent(db, roomId, 'm.room.create');
  const powerLevelsEvent = await getStateEvent(db, roomId, 'm.room.power_levels');

  const authEvents: string[] = [];
  if (createEvent) authEvents.push(createEvent.event_id);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
  if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
  if (currentMembership) authEvents.push(currentMembership.eventId);
  if (restrictedDecision?.authEventId) authEvents.push(restrictedDecision.authEventId);

  const { events: latestEvents } = await getRoomEvents(db, roomId, undefined, 1);
  const prevEvents = latestEvents.map(e => e.event_id);

  // Deterministic event ID — see local-room join handler for rationale.
  const ts = Date.now();
  const eventId = await generateDeterministicEventId(
    c.env.SERVER_NAME, roomId, userId, 'join', ts, 1, room.room_version
  );

  const memberContent: RoomMemberContent = {
    membership: 'join',
    ...(restrictedDecision?.authorizedBy
      ? { join_authorised_via_users_server: restrictedDecision.authorizedBy }
      : {}),
  };

  const event: PDU = {
    event_id: eventId,
    room_id: roomId,
    sender: userId,
    type: 'm.room.member',
    state_key: userId,
    content: memberContent,
    origin_server_ts: ts,
    depth: (latestEvents[0]?.depth ?? 0) + 1,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  await storeEventIdempotent(db, event);
  await tryInsertJoinMembership(db, roomId, userId, eventId);

  // Federate the join to remote members so their servers can resolve later
  // events that auth-reference it.
  const joinDestinations = await getJoinedRemoteServers(db, roomId, c.env.SERVER_NAME);
  await federateLocalStateEventToRemotes(c.env, event, roomId, joinDestinations);

  return c.json({ room_id: roomId });
});

// Room alias endpoints
// GET /_matrix/client/v3/directory/room/:roomAlias
app.get('/_matrix/client/v3/directory/room/:roomAlias', async (c) => {
  const alias = decodeURIComponent(c.req.param('roomAlias'));

  const roomId = await getRoomByAlias(c.env.DB, alias);
  if (roomId) {
    return c.json({
      room_id: roomId,
      servers: [c.env.SERVER_NAME],
    });
  }

  // Remote aliases resolve via the alias server's federation directory.
  const remote = await resolveRemoteAlias(c.env, alias);
  if (!remote) {
    return Errors.notFound('Room alias not found').toResponse();
  }
  return c.json({ room_id: remote.roomId, servers: remote.servers });
});

// PUT /_matrix/client/v3/directory/room/:roomAlias
app.put('/_matrix/client/v3/directory/room/:roomAlias', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const alias = decodeURIComponent(c.req.param('roomAlias'));

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { room_id } = body;
  if (!room_id) {
    return Errors.missingParam('room_id').toResponse();
  }

  // Check if alias already exists
  const existing = await getRoomByAlias(c.env.DB, alias);
  if (existing) {
    return Errors.roomInUse().toResponse();
  }

  // Check if user has permission (is member of room)
  const membership = await getMembership(c.env.DB, room_id, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  await createRoomAlias(c.env.DB, alias, room_id, userId);
  return c.json({});
});

// DELETE /_matrix/client/v3/directory/room/:roomAlias
app.delete('/_matrix/client/v3/directory/room/:roomAlias', requireAuth(), async (c) => {
  // Note: userId could be used for permission checks in future
  void c.get('userId');
  const alias = decodeURIComponent(c.req.param('roomAlias'));

  const roomId = await getRoomByAlias(c.env.DB, alias);
  if (!roomId) {
    return Errors.notFound('Room alias not found').toResponse();
  }

  await deleteRoomAlias(c.env.DB, alias);
  return c.json({});
});

// ============================================
// Room Summary (MSC3266)
// ============================================

// GET /_matrix/client/v1/room_summary/:roomIdOrAlias - Get a summary of a room
// Allows previewing a room without joining it (if permitted by room settings)
app.get('/_matrix/client/v1/room_summary/:roomIdOrAlias', async (c) => {
  const roomIdOrAlias = decodeURIComponent(c.req.param('roomIdOrAlias'));
  const db = c.env.DB;

  let roomId = roomIdOrAlias;

  // Resolve alias to room_id if needed
  if (roomIdOrAlias.startsWith('#')) {
    const aliasResult = await db.prepare(
      `SELECT room_id FROM room_aliases WHERE alias = ?`
    ).bind(roomIdOrAlias).first<{ room_id: string }>();
    if (aliasResult) {
      roomId = aliasResult.room_id;
    } else {
      // Remote alias: resolve live via the alias server's federation
      // directory, exactly like the join path, so previews of moved
      // aliases (room IDs change) resolve to the current room.
      const remote = await resolveRemoteAlias(c.env, roomIdOrAlias);
      if (!remote) {
        return Errors.notFound('Room alias not found').toResponse();
      }
      roomId = remote.roomId;
    }
  }

  // Get room info
  const room = await db.prepare(
    `SELECT room_id, room_version, is_public FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_id: string; room_version: string; is_public: number }>();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get room state events we need
  const stateEvents = await db.prepare(`
    SELECT e.event_type, e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type IN (
      'm.room.name', 'm.room.topic', 'm.room.avatar',
      'm.room.join_rules', 'm.room.canonical_alias', 'm.room.encryption',
      'm.room.history_visibility', 'm.room.guest_access'
    )
  `).bind(roomId).all<{ event_type: string; content: string }>();

  // Get member count
  const memberCount = await db.prepare(
    `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`
  ).bind(roomId).first<{ count: number }>();

  // Build response
  const response: Record<string, unknown> = {
    room_id: roomId,
    num_joined_members: memberCount?.count || 0,
    room_version: room.room_version,
  };

  // Extract state
  let joinRule = 'invite';
  let historyVisibility = 'shared';
  let worldReadable = false;
  let guestCanJoin = false;

  for (const event of stateEvents.results || []) {
    const content = JSON.parse(event.content);
    switch (event.event_type) {
      case 'm.room.name':
        response.name = content.name;
        break;
      case 'm.room.topic':
        response.topic = content.topic;
        break;
      case 'm.room.avatar':
        response.avatar_url = content.url;
        break;
      case 'm.room.join_rules':
        joinRule = content.join_rule;
        response.join_rule = joinRule;
        break;
      case 'm.room.canonical_alias':
        response.canonical_alias = content.alias;
        break;
      case 'm.room.encryption':
        response.encryption = content.algorithm;
        break;
      case 'm.room.history_visibility':
        historyVisibility = content.history_visibility;
        worldReadable = historyVisibility === 'world_readable';
        break;
      case 'm.room.guest_access':
        guestCanJoin = content.guest_access === 'can_join';
        break;
    }
  }

  response.world_readable = worldReadable;
  response.guest_can_join = guestCanJoin;

  // Check user membership if authenticated (optional auth)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const { hashToken } = await import('../utils/crypto');
    const tokenHash = await hashToken(token);
    const tokenResult = await db.prepare(
      `SELECT user_id FROM access_tokens WHERE token_hash = ?`
    ).bind(tokenHash).first<{ user_id: string }>();

    if (tokenResult) {
      const membership = await db.prepare(
        `SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`
      ).bind(roomId, tokenResult.user_id).first<{ membership: string }>();
      response.membership = membership?.membership || 'leave';
    }
  }

  // Check if room summary is allowed based on join rules
  // For non-public rooms, only show summary if user is a member or if world_readable
  if (!room.is_public && !worldReadable && !response.membership) {
    // Don't reveal room existence for private rooms to non-members
    if (!['public', 'knock', 'knock_restricted'].includes(joinRule)) {
      return Errors.notFound('Room not found').toResponse();
    }
  }

  return c.json(response);
});

// ============================================
// Timestamp to Event (MSC3030)
// ============================================

// GET /_matrix/client/v1/rooms/:roomId/timestamp_to_event (spec) and the v3 legacy path
// Finds the closest event to a given timestamp
async function timestampToEventHandler(c: Context<AppEnv, '/_matrix/client/v1/rooms/:roomId/timestamp_to_event'>) {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  // Parse required parameters
  const tsParam = c.req.query('ts');
  const dirParam = c.req.query('dir');

  if (!tsParam) {
    return Errors.missingParam('ts').toResponse();
  }
  if (!dirParam) {
    return Errors.missingParam('dir').toResponse();
  }

  const ts = parseInt(tsParam, 10);
  if (isNaN(ts)) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'ts must be a valid integer timestamp in milliseconds',
    }, 400);
  }

  if (dirParam !== 'f' && dirParam !== 'b') {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: "dir must be 'f' (forward) or 'b' (backward)",
    }, 400);
  }

  // Check membership - user must be joined to the room
  const membership = await getMembership(db, roomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Query for the closest event
  let event: { event_id: string; origin_server_ts: number } | null = null;

  if (dirParam === 'f') {
    // Forward: find the closest event at or after the timestamp
    event = await db.prepare(`
      SELECT event_id, origin_server_ts
      FROM events
      WHERE room_id = ? AND origin_server_ts >= ?
      ORDER BY origin_server_ts ASC
      LIMIT 1
    `).bind(roomId, ts).first<{ event_id: string; origin_server_ts: number }>();
  } else {
    // Backward: find the closest event at or before the timestamp
    event = await db.prepare(`
      SELECT event_id, origin_server_ts
      FROM events
      WHERE room_id = ? AND origin_server_ts <= ?
      ORDER BY origin_server_ts DESC
      LIMIT 1
    `).bind(roomId, ts).first<{ event_id: string; origin_server_ts: number }>();
  }

  if (!event) {
    return Errors.notFound('No event found for the given timestamp').toResponse();
  }

  return c.json({
    event_id: event.event_id,
    origin_server_ts: event.origin_server_ts,
  });
}
app.get('/_matrix/client/v1/rooms/:roomId/timestamp_to_event', requireAuth(), timestampToEventHandler);
app.get('/_matrix/client/v3/rooms/:roomId/timestamp_to_event', requireAuth(), timestampToEventHandler);

// ============================================
// Room Upgrade
// ============================================

// Supported room versions
const SUPPORTED_ROOM_VERSIONS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', MSC4583_ROOM_VERSION];

// POST /_matrix/client/v3/rooms/:roomId/upgrade - Upgrade a room to a new version
app.post('/_matrix/client/v3/rooms/:roomId/upgrade', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const oldRoomId = c.req.param('roomId');
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  let body: { new_version: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.new_version) {
    return Errors.missingParam('new_version').toResponse();
  }

  // Validate room version
  if (!SUPPORTED_ROOM_VERSIONS.includes(body.new_version)) {
    return c.json({
      errcode: 'M_UNSUPPORTED_ROOM_VERSION',
      error: `Room version ${body.new_version} is not supported`,
    }, 400);
  }

  // Check if old room exists
  const oldRoom = await getRoom(db, oldRoomId);
  if (!oldRoom) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Check user is a member
  const membership = await getMembership(db, oldRoomId, userId);
  if (!membership || membership.membership !== 'join') {
    return Errors.forbidden('Not a member of this room').toResponse();
  }

  // Check user has permission to send m.room.tombstone events
  // User needs power level >= events['m.room.tombstone'] (default 100 for state events)
  const powerLevelsEvent = await getStateEvent(db, oldRoomId, 'm.room.power_levels', '');
  const powerLevels = powerLevelsEvent ? JSON.parse(typeof powerLevelsEvent.content === 'string' ? powerLevelsEvent.content : JSON.stringify(powerLevelsEvent.content)) : null;

  const oldCreateEvent = await getStateEvent(db, oldRoomId, 'm.room.create');
  const userPowerLevel = getEffectiveUserPowerLevel(powerLevels ?? {}, userId, oldCreateEvent);
  const tombstonePowerLevel = powerLevels?.events?.['m.room.tombstone'] ?? powerLevels?.state_default ?? 50;

  if (userPowerLevel < tombstonePowerLevel) {
    return Errors.forbidden('Insufficient power level to upgrade room').toResponse();
  }

  // Get current room state to copy to new room
  const currentState = await getRoomState(db, oldRoomId);
  const now = Date.now();

  const stateContent = (event: PDU): any =>
    typeof event.content === 'string' ? JSON.parse(event.content) : event.content;

  // Spec room upgrades: every user who was joined or invited in the old room
  // must be invited to the replacement. Membership rows are authoritative;
  // state events are a fallback for rooms whose membership table lags.
  const oldMembers = new Map<string, string>();
  try {
    for (const member of (await getRoomMembers(db, oldRoomId)) ?? []) {
      if (member.membership === 'join' || member.membership === 'invite') {
        oldMembers.set(member.userId, member.membership);
      }
    }
  } catch (err) {
    console.warn('[rooms] upgrade member lookup failed:', err);
  }
  for (const event of currentState) {
    if (event.type !== 'm.room.member' || !event.state_key) continue;
    const membership = stateContent(event)?.membership;
    if (membership === 'join' || membership === 'invite') {
      oldMembers.set(event.state_key, membership);
    }
  }

  // Get the last event ID from old room for predecessor
  const lastEvent = await db.prepare(`
    SELECT event_id FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1
  `).bind(oldRoomId).first<{ event_id: string }>();

  const predecessor = {
    room_id: oldRoomId,
    event_id: lastEvent?.event_id || '',
  };

  // MSC4291 (room version 12): derive the new room ID and create event ID
  // from the create event's reference hash.
  const prebuiltCreate = isMsc4291RoomVersion(body.new_version)
    ? await buildMsc4291CreateEvent(body.new_version, userId, predecessor)
    : null;

  // Generate new room ID
  const newRoomId = prebuiltCreate ? prebuiltCreate.roomId : await generateRoomId(serverName);

  // Create the new room
  await createRoom(db, newRoomId, body.new_version, userId, false);

  let depth = 0;
  const authEvents: string[] = [];
  const prevEvents: string[] = [];

  // Helper to create events in new room
  async function createNewRoomEvent(type: string, content: any, stateKey?: string): Promise<string> {
    const event: PDU = {
      event_id: '',
      room_id: newRoomId,
      sender: userId,
      type,
      state_key: stateKey,
      content,
      origin_server_ts: now + depth,
      depth: depth++,
      auth_events: [...authEvents],
      prev_events: [...prevEvents],
    };

    const eventId = await prepareAndStoreLocalEvent(c.env, newRoomId, event);

    if (stateKey !== undefined) {
      authEvents.push(eventId);
    }
    prevEvents.length = 0;
    prevEvents.push(eventId);

    return eventId;
  }

  // 1. Create m.room.create with predecessor
  if (prebuiltCreate) {
    const createPdu = {
      event_id: prebuiltCreate.eventId,
      room_id: newRoomId,
      ...prebuiltCreate.pduBase,
      hashes: prebuiltCreate.hashes,
    } as unknown as PDU;
    await storeEvent(db, createPdu);
    depth = 1;
    prevEvents.push(prebuiltCreate.eventId);
  } else {
    const createContent: RoomCreateContent = {
      creator: userId,
      room_version: body.new_version,
      predecessor,
    };
    await createNewRoomEvent('m.room.create', createContent, '');
  }

  // 2. Creator joins
  const joinEventId = await createNewRoomEvent('m.room.member', { membership: 'join' }, userId);
  await updateMembership(db, newRoomId, userId, 'join', joinEventId);

  // 3. Copy power levels (with adjustments)
  if (powerLevels) {
    // MSC4289: creators must not appear in the users map of v12 rooms.
    let plContent = powerLevels;
    if (isMsc4291RoomVersion(body.new_version) && plContent.users) {
      const users = { ...plContent.users };
      delete users[userId];
      plContent = { ...plContent, users };
    }
    await createNewRoomEvent('m.room.power_levels', plContent, '');
  } else {
    // Default power levels
    await createNewRoomEvent('m.room.power_levels', {
      users: isMsc4291RoomVersion(body.new_version) ? {} : { [userId]: 100 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
    }, '');
  }

  // 4. Copy ALL other current state generically. The new room gets its own
  // create and membership events, and the tombstone belongs to the old room;
  // everything else (server ACL, canonical alias, unknown/custom types, ...)
  // carries over so the replacement is not silently stripped down.
  const stateCopyExcluded = new Set(['m.room.create', 'm.room.member', 'm.room.tombstone', 'm.room.power_levels']);
  for (const event of currentState) {
    if (stateCopyExcluded.has(event.type)) continue;
    await createNewRoomEvent(event.type, stateContent(event), event.state_key ?? '');
  }

  // Defaults for the two state types the new room cannot be without.
  if (!currentState.some((e) => e.type === 'm.room.join_rules')) {
    await createNewRoomEvent('m.room.join_rules', { join_rule: 'invite' }, '');
  }
  if (!currentState.some((e) => e.type === 'm.room.history_visibility')) {
    await createNewRoomEvent('m.room.history_visibility', { history_visibility: 'shared' }, '');
  }

  // 5. Invite every joined/invited member of the old room through the normal
  // invite pipeline. Local invites get real membership events; remote invites
  // are federated with the v2 invite flow. Failures are best-effort.
  for (const memberId of oldMembers.keys()) {
    if (memberId === userId) continue; // the upgrader already joined above
    try {
      const result = await performRoomInvite(c.env, newRoomId, userId, memberId, {
        membership: 'join',
        eventId: joinEventId,
      });
      if ('error' in result) {
        console.warn(`[rooms] upgrade invite ${memberId} to ${newRoomId} refused:`, result.error.message);
      }
    } catch (err) {
      console.warn(`[rooms] upgrade invite ${memberId} to ${newRoomId} failed:`, err);
    }
  }

  // Now send tombstone to old room
  const oldRoomState = await getRoomState(db, oldRoomId);
  const oldPrevEvent = await db.prepare(`
    SELECT event_id, depth FROM events WHERE room_id = ? ORDER BY depth DESC LIMIT 1
  `).bind(oldRoomId).first<{ event_id: string; depth: number }>();

  const oldAuthEvents = oldRoomState
    .filter(e => ['m.room.create', 'm.room.power_levels', 'm.room.member'].includes(e.type))
    .filter(e => e.state_key === '' || e.state_key === userId)
    .map(e => e.event_id);

  const tombstoneEvent: PDU = {
    event_id: '',
    room_id: oldRoomId,
    sender: userId,
    type: 'm.room.tombstone',
    state_key: '',
    content: {
      body: 'This room has been replaced',
      replacement_room: newRoomId,
    },
    origin_server_ts: now,
    depth: (oldPrevEvent?.depth || 0) + 1,
    auth_events: oldAuthEvents,
    prev_events: oldPrevEvent ? [oldPrevEvent.event_id] : [],
  };

  const tombstoneEventId = await prepareAndStoreLocalEvent(c.env, oldRoomId, tombstoneEvent);

  // Freeze the old room: every user becomes powerless and no user may send
  // state, invites or ordinary events. Keeping the existing users map with
  // their original powers would still let high-power users post into the
  // tombstoned room, so zero it out explicitly.
  const frozenUsers: Record<string, number> = {};
  if (powerLevels?.users && typeof powerLevels.users === 'object' && !Array.isArray(powerLevels.users)) {
    for (const uid of Object.keys(powerLevels.users)) frozenUsers[uid] = 0;
  }
  for (const memberId of oldMembers.keys()) frozenUsers[memberId] = 0;
  const newPowerLevels = {
    ...(powerLevels ?? { users_default: 0, ban: 100, kick: 100, redact: 100 }),
    users: frozenUsers,
    events_default: 100,
    invite: 100,
    state_default: 100,
  };

  const restrictEvent: PDU = {
    event_id: '',
    room_id: oldRoomId,
    sender: userId,
    type: 'm.room.power_levels',
    state_key: '',
    content: newPowerLevels,
    origin_server_ts: now + 1,
    depth: (oldPrevEvent?.depth || 0) + 2,
    auth_events: oldAuthEvents,
    prev_events: [tombstoneEventId],
  };

  await prepareAndStoreLocalEvent(c.env, oldRoomId, restrictEvent);

  // Send the freeze through the normal state-event pipeline so remote servers
  // with joined members in the old room see the same power levels.
  const oldRemoteServers = await getJoinedRemoteServers(db, oldRoomId, serverName);
  await federateLocalStateEventToRemotes(c.env, restrictEvent, oldRoomId, oldRemoteServers);

  // Migrate local room aliases to point to new room
  const aliases = await db.prepare(`
    SELECT alias FROM room_aliases WHERE room_id = ?
  `).bind(oldRoomId).all<{ alias: string }>();

  for (const aliasRow of aliases.results) {
    await db.prepare(`
      UPDATE room_aliases SET room_id = ? WHERE alias = ?
    `).bind(newRoomId, aliasRow.alias).run();
  }

  return c.json({
    replacement_room: newRoomId,
  });
});

export default app;
