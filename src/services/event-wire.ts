// Federation wire-format derivation, shared by the serving endpoints and the
// outbound send/invite paths.
//
// Room versions 3+ derive event IDs from the reference hash and reject PDUs
// carrying an explicit event_id. The redaction algorithm (and therefore the
// reference hash and signature) is room-version dependent: v1-10 keep only
// `creator` in m.room.create and drop `invite` from m.room.power_levels.
// Events stored before the version-aware signing fix carry v11-rule hashes
// for v10 rooms, so for locally-created legacy rooms we re-derive the whole
// room's wire form on serve/delivery: correct hashes/signatures/IDs with all
// intra-room references translated, in dependency order.

import type { Env } from '../types';
import type { PDU } from '../types/matrix';
import { calculateContentHash, signJson } from '../utils/crypto';
import {
  computeWireEventId,
  isMsc4291RoomVersion,
  redactEventForSigning,
  toWireEventObject,
} from '../utils/event-signing';
import { getServerSigningKey } from './federation-keys';
import { expectedAuthTypes } from './event-auth';

const AUTH_SEP = String.fromCharCode(0);

// Prepare a locally-created event for the federation wire: attach the
// content hash, derive the reference-hash event ID with the room version's
// redaction rules, and sign the redacted event. Returns null when no signing
// key is available (delivery is skipped; the event stays local-only).
export async function prepareOutboundPdu(
  env: Env,
  event: PDU,
  roomVersion?: string
): Promise<{
  wireId: string;
  hashes: Record<string, string>;
  signatures: Record<string, unknown>;
  wire: Record<string, unknown>;
} | null> {
  try {
    const source = toWireEventObject(event as unknown as Record<string, unknown>);
    // `unsigned` is local-only and must not travel on the wire.
    delete source['unsigned'];
    // MSC4291: the create event carries no room_id (its ID is derived from
    // the room ID), so neither the content hash nor the reference hash may
    // cover one.
    if (roomVersion && isMsc4291RoomVersion(roomVersion) && event.type === 'm.room.create') {
      delete source['room_id'];
    }
    const hashes = { sha256: await calculateContentHash(source) };
    const hashed = { ...source, hashes };
    const wireId = await computeWireEventId(hashed, roomVersion);

    const signingKey = await getServerSigningKey(env.DB);
    if (!signingKey) {
      console.warn('[event-wire] No signing key available; skipping federation delivery');
      return null;
    }
    const signed = await signJson(
      redactEventForSigning(hashed, roomVersion),
      env.SERVER_NAME,
      signingKey.keyId,
      signingKey.privateKeyJwk
    );
    const signatures = (signed as { signatures?: Record<string, unknown> }).signatures || {};
    return { wireId, hashes, signatures, wire: { ...hashed, signatures } };
  } catch (err) {
    console.error('[event-wire] prepareOutboundPdu failed:', err);
    return null;
  }
}

export interface RoomWire {
  idMap: Map<string, string>;
  wireById: Map<string, Record<string, unknown>>;
}

// Derive the wire form of every event in a room for room versions 3+:
// reference-hash IDs, intra-room references translated, auth_events reduced
// to the receiving server's expected selection, hashes/signatures recomputed
// with the room version's redaction rules so served bytes hash back to the
// served IDs. Returns null for room versions 1-2 (explicit event_id wire).
export async function deriveRoomWireEvents(
  env: Env,
  roomId: string,
  roomVersion: string
): Promise<RoomWire | null> {
  const num = parseInt(roomVersion, 10);
  if (Number.isFinite(num) && num < 3) return null;
  const msc4291 = isMsc4291RoomVersion(roomVersion);

  const idMap = new Map<string, string>();
  const wireById = new Map<string, Record<string, unknown>>();

  const createRow = await env.DB.prepare(
    `SELECT e.event_id FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
  ).bind(roomId).first<{ event_id: string }>();
  const createEventId = createRow?.event_id;

  const all = await env.DB.prepare(
    `SELECT event_id, room_id, sender, event_type, state_key, content,
     origin_server_ts, depth, auth_events, prev_events, hashes, signatures
     FROM events WHERE room_id = ?
     ORDER BY depth ASC, stream_ordering ASC`
  ).bind(roomId).all();

  const refTargets = new Map<string, { type: string; stateKey: string }>();

  // Current state, used to augment auth_events with the types the receiving
  // server's auth rules require (e.g. join_rules for member joins) when the
  // stored event predates that rule.
  // State-at-event-time from the DAG itself (latest event per state slot
  // with smaller depth). Using CURRENT state here would change an event's
  // derived ID whenever a later membership lands, dangling the auth refs of
  // joins peers already stored.
  const history = new Map<string, Array<{ id: string; depth: number }>>();
  for (const r of all.results as any[]) {
    if (r.state_key === null || r.state_key === undefined) continue;
    const key = r.event_type + AUTH_SEP + r.state_key;
    const list = history.get(key) ?? [];
    list.push({ id: r.event_id, depth: r.depth });
    history.set(key, list);
  }
  for (const list of history.values()) list.sort((a, b) => a.depth - b.depth);
  const stateAtDepth = (key: string, depth: number): string | undefined => {
    const list = history.get(key);
    if (!list) return undefined;
    let found: string | undefined;
    for (const entry of list) {
      if (entry.depth >= depth) break;
      found = entry.id;
    }
    return found;
  };

  // Single pass in dependency order: auth/prev references always point at
  // earlier events, so each event's final wire form (and derived ID) is
  // settled before any event that references it.
  for (const row of all.results as any[]) {
    let reducedAuth: string[] = [];
    const event: PDU = {
      event_id: row.event_id,
      room_id: row.room_id,
      sender: row.sender,
      type: row.event_type,
      content: JSON.parse(row.content),
      origin_server_ts: row.origin_server_ts,
      depth: row.depth,
      auth_events: JSON.parse(row.auth_events),
      prev_events: JSON.parse(row.prev_events),
      hashes: row.hashes ? JSON.parse(row.hashes) : undefined,
      signatures: row.signatures ? JSON.parse(row.signatures) : undefined,
    };
    // `state_key` exists only on state events; adding it as null would change
    // the canonical JSON and produce a phantom reference hash.
    if (row.state_key !== null && row.state_key !== undefined) {
      event.state_key = row.state_key;
    }
    // MSC4291: the create event is implicit, never listed. Older versions
    // require it in auth_events.
    if (msc4291 && createEventId) {
      event.auth_events = event.auth_events.filter((id) => id !== createEventId);
    }

    for (const key of ['auth_events', 'prev_events'] as const) {
      event[key] = event[key].map((id) => (idMap.has(id) ? idMap.get(id)! : id));
    }

    // Reduce auth_events to the receiving server's expected selection; the
    // create is kept for pre-v12 versions and never listed for v12.
    if (row.event_type !== 'm.room.create') {
      const expected = expectedAuthTypes(
        row.event_type,
        row.sender,
        row.state_key ?? undefined,
        event.content as Record<string, unknown>
      );
      const kept: string[] = [];
      const seen = new Set<string>();
      const push = (id: unknown): void => {
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id);
          kept.push(id);
        }
      };
      for (const ref of event.auth_events) {
        const target = refTargets.get(ref);
        if (!target) {
          push(ref);
          continue;
        }
        if (target.type === 'm.room.create') {
          if (!msc4291) push(ref);
          continue;
        }
        if (expected.has(target.type + AUTH_SEP + target.stateKey)) push(ref);
      }
      // Augment with required auth types missing from the stored event.
      // Only state that predates the event (depth guard): current state for
      // a membership slot may be a *later* membership, which must never
      // become an auth ref of an earlier event.
      for (const key of expected) {
        const priorId = stateAtDepth(key, row.depth);
        if (!priorId || priorId === row.event_id) continue;
        push(idMap.get(priorId) ?? priorId);
      }
      if (!msc4291 && createEventId) push(idMap.get(createEventId) ?? createEventId);
      reducedAuth = kept;
      event.auth_events = kept;
    }

    // Derivation recomputes the content hash and adds our signature; any
    // signatures already on the event (e.g. a joining server's own signature
    // on its join) are preserved by the merge inside signing.
    const prepared = await prepareOutboundPdu(env, event, roomVersion);
    if (!prepared) continue;
    idMap.set(row.event_id, prepared.wireId);
    wireById.set(row.event_id, prepared.wire);
    wireById.set(prepared.wireId, prepared.wire);
    const info = { type: row.event_type as string, stateKey: (row.state_key ?? '') as string };
    refTargets.set(row.event_id, info);
    refTargets.set(prepared.wireId, info);
    // Peers' stored events reference the pre-augmentation derived form;
    // map that older wire ID onto the current one so their refs resolve.
    const oldPrepared = await prepareOutboundPdu(
      env,
      { ...event, auth_events: reducedAuth } as PDU,
      roomVersion
    );
    if (oldPrepared && oldPrepared.wireId !== prepared.wireId) {
      idMap.set(oldPrepared.wireId, prepared.wireId);
      wireById.set(oldPrepared.wireId, prepared.wire);
      refTargets.set(oldPrepared.wireId, info);
    }
  }

  return { idMap, wireById };
}

// Build the send_join response: current room state plus the transitive auth
// chain, every event in wire form (derived ID, no explicit event_id field,
// hashes and signatures intact).
export function buildWireJoinState(
  wire: RoomWire,
  stateIds: string[]
): { state: Record<string, unknown>[]; authChain: Record<string, unknown>[] } {
  const stateSet = new Set<string>();
  for (const id of stateIds) {
    stateSet.add(id);
    const derived = wire.idMap.get(id);
    if (derived) stateSet.add(derived);
  }
  const state = stateIds
    .map((id) => wire.wireById.get(id))
    .filter(Boolean) as Record<string, unknown>[];

  const chainIds = new Set<string>();
  const queue: string[] = [];
  for (const ev of state) {
    for (const ref of (ev.auth_events as string[] | undefined) ?? []) queue.push(ref);
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (chainIds.has(id) || stateSet.has(id) || !wire.wireById.has(id)) continue;
    chainIds.add(id);
    const ev = wire.wireById.get(id)!;
    for (const ref of (ev.auth_events as string[] | undefined) ?? []) queue.push(ref);
  }

  return {
    state,
    authChain: [...chainIds]
      .map((id) => wire.wireById.get(id))
      .filter(Boolean) as Record<string, unknown>[],
  };
}

// v3-v10 rooms whose create we authored: pre-fix stored events used v11
// redaction rules, so their hashes/IDs/signatures must be re-derived and
// references translated. Remote-created legacy rooms keep the fast
// as-stored path.
export async function legacyWireForRoom(
  env: Env,
  roomId: string,
  roomVersion: string
): Promise<RoomWire | null> {
  if (isMsc4291RoomVersion(roomVersion)) return null;
  const num = parseInt(roomVersion, 10);
  if (!Number.isFinite(num) || num < 3 || num > 10) return null;
  try {
    const create = await env.DB.prepare(
      `SELECT e.sender FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
    ).bind(roomId).first<{ sender: string }>();
    if (!create || typeof create.sender !== 'string' || !create.sender.endsWith(`:${env.SERVER_NAME}`)) {
      return null;
    }
    const wire = await deriveRoomWireEvents(env, roomId, roomVersion);
    // Derivation is best-effort: without a usable signing key (or on any
    // storage error) fall back to the as-stored serving path.
    if (!wire || wire.wireById.size === 0) return null;
    return wire;
  } catch (err) {
    console.warn('[event-wire] legacy derivation unavailable, serving as-stored:', err);
    return null;
  }
}

// Serving-side derivation: v12 rooms always (MSC4291 wire form), legacy
// locally-created rooms when their stored forms need correction.
export async function wireForRoom(
  env: Env,
  roomId: string,
  roomVersion: string
): Promise<RoomWire | null> {
  try {
    if (isMsc4291RoomVersion(roomVersion)) {
      const wire = await deriveRoomWireEvents(env, roomId, roomVersion);
      return wire && wire.wireById.size > 0 ? wire : null;
    }
    return await legacyWireForRoom(env, roomId, roomVersion);
  } catch (err) {
    console.warn('[event-wire] derivation unavailable, serving as-stored:', err);
    return null;
  }
}

// Add the auth event types the receiving server's auth rules require but the
// event lacks (e.g. join_rules for member joins), using current/planned state.
// Never self-reference: a membership event's auth needs the *previous*
// membership, not the current state slot (which is the event itself).
export function augmentAuthEvents(
  event: PDU,
  stateTargets: Map<string, string>,
  msc4291: boolean,
  createId?: string
): void {
  const expected = expectedAuthTypes(
    event.type,
    event.sender,
    event.state_key,
    (event.content ?? {}) as Record<string, unknown>
  );
  const refs = event.auth_events ?? [];
  const have = new Set(refs);
  const add = (id: string): void => {
    if (!have.has(id)) {
      have.add(id);
      refs.push(id);
    }
  };
  for (const key of expected) {
    const storedId = stateTargets.get(key);
    if (!storedId || storedId === event.event_id) continue;
    add(storedId);
  }
  if (!msc4291 && createId) add(createId);
  event.auth_events = refs;
}
