// Restricted joins (MSC3083 / MSC3787, spec v1.19): shared allow-list and
// authorising-user evaluation for both the federation (make_join) and local
// client join paths, plus the state resync used by federation /refresh_room.

import type { Env, PDU, RoomJoinRulesContent, RoomPowerLevelsContent } from '../types';
import { getMembership, getRoomState, storeEventIdempotent, updateMembership } from './database';
import { getEffectiveUserPowerLevel } from './event-auth';
import { federationGet } from './federation-keys';
import { computeWireEventId } from '../utils/event-signing';
import { serverNameFromId } from './server-acl';
import { getRoomVersion } from './room-versions';

export interface RestrictedJoinDecision {
  /** Local user whose power level authorises the join, when eligible. */
  authorizedBy?: string;
  /** State event ID of the authorising user (for the join's auth_events). */
  authEventId?: string;
  error?: string;
}

interface EvaluateParams {
  db: D1Database;
  cache: KVNamespace;
  localServerName: string;
  roomId: string;
  userId: string;
  roomState: PDU[];
  roomVersion: string;
}

function isJoinMembershipEvent(ev: PDU, userId: string): boolean {
  return (
    ev.type === 'm.room.member' &&
    ev.state_key === userId &&
    (ev.content as { membership?: string } | undefined)?.membership === 'join'
  );
}

/**
 * Is the joiner currently joined to an allowed room? Local memberships are
 * authoritative when we hold that room; otherwise ask one of its `via`
 * servers for current state. A verification failure is simply "not eligible"
 * — the caller turns that into M_FORBIDDEN.
 */
async function joinedAllowedRoom(params: EvaluateParams, roomId: string, via: string[]): Promise<boolean> {
  const { db, cache, localServerName, userId } = params;

  try {
    const membership = await getMembership(db, roomId, userId);
    if (membership?.membership === 'join') return true;
  } catch {
    // No membership table / no row: fall through to state and federation.
  }

  try {
    const state = await getRoomState(db, roomId);
    if (state.some((ev) => isJoinMembershipEvent(ev, userId))) return true;
    // We hold this room's state: a missing join row is authoritative.
    if (state.length > 0) return false;
  } catch {
    // State unavailable: the via servers are the remaining evidence.
  }

  for (const server of via) {
    if (!server || server === localServerName) continue;
    try {
      // State IDs establish which state snapshot the peer is serving; the
      // full state response then carries the membership contents we need.
      const idsResponse = await federationGet(
        server,
        `/_matrix/federation/v1/state_ids/${encodeURIComponent(roomId)}`,
        localServerName,
        db,
        cache
      );
      if (!idsResponse.ok) continue;
      const idsBody = (await idsResponse.json()) as { pdu_ids?: unknown };
      const eventIds = Array.isArray(idsBody.pdu_ids) ? idsBody.pdu_ids : [];
      if (eventIds.length === 0) continue;

      const stateResponse = await federationGet(
        server,
        `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}?event_id=${encodeURIComponent(String(eventIds[0]))}`,
        localServerName,
        db,
        cache
      );
      if (!stateResponse.ok) continue;
      const stateBody = (await stateResponse.json()) as { pdus?: unknown };
      const pdus = Array.isArray(stateBody.pdus) ? (stateBody.pdus as PDU[]) : [];
      if (pdus.some((ev) => isJoinMembershipEvent(ev, userId))) return true;
    } catch (err) {
      console.warn('[restricted-joins] allowed-room state fetch failed', {
        roomId, server, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return false;
}

/**
 * Evaluate a restricted / knock_restricted join with no invite. The joiner
 * must be joined to at least one `allow` room, and a joined LOCAL member with
 * invite power must be available to authorise the join on this server.
 */
export async function evaluateRestrictedJoin(params: EvaluateParams): Promise<RestrictedJoinDecision> {
  const behavior = getRoomVersion(params.roomVersion);
  if (!behavior?.restrictedJoinsSupported) {
    return { error: 'Restricted joins are not supported in this room version' };
  }

  const joinRules = params.roomState.find((ev) => ev.type === 'm.room.join_rules');
  const content = (joinRules?.content ?? {}) as unknown as RoomJoinRulesContent;
  if (content.join_rule !== 'restricted' && content.join_rule !== 'knock_restricted') {
    return { error: 'This room does not use a restricted join rule' };
  }
  if (content.join_rule === 'knock_restricted' && !behavior.knockRestrictedSupported) {
    return { error: 'knock_restricted requires room version 10 or later' };
  }

  const allow = Array.isArray(content.allow) ? content.allow : [];
  let eligible = false;
  for (const entry of allow) {
    if (!entry || typeof entry.room_id !== 'string' || !entry.room_id) continue;
    const via = Array.isArray(entry.via)
      ? entry.via.filter((value): value is string => typeof value === 'string' && !!value)
      : [];
    if (await joinedAllowedRoom(params, entry.room_id, via)) {
      eligible = true;
      break;
    }
  }
  if (!eligible) {
    return { error: 'You are not a member of any room allowed by this room’s join rule' };
  }

  // The authorising user must be joined here, on our server, and hold at
  // least the invite power level (room v8 auth rule).
  const powerLevelsEvent = params.roomState.find((ev) => ev.type === 'm.room.power_levels');
  const powerLevels = (powerLevelsEvent?.content ?? {}) as RoomPowerLevelsContent;
  const createEvent = params.roomState.find((ev) => ev.type === 'm.room.create');
  const inviteLevel = powerLevels.invite ?? 0;
  for (const ev of params.roomState) {
    if (ev.type !== 'm.room.member' || typeof ev.state_key !== 'string') continue;
    const userId = ev.state_key;
    if (serverNameFromId(userId) !== params.localServerName) continue;
    if ((ev.content as { membership?: string } | undefined)?.membership !== 'join') continue;
    if (getEffectiveUserPowerLevel(powerLevels, userId, createEvent) < inviteLevel) continue;
    return { authorizedBy: userId, authEventId: ev.event_id };
  }
  return { error: 'No local member can authorise this restricted join' };
}

/** Store one PDU from a remote state snapshot using the backfill-safe pipeline. */
async function storeRemoteStateEvent(
  env: Env,
  roomId: string,
  roomVersion: string,
  raw: unknown
): Promise<boolean> {
  if (!raw || typeof raw !== 'object') return false;
  const ev = raw as Record<string, unknown>;
  if (typeof ev['type'] !== 'string') return false;
  try {
    const normalized: Record<string, unknown> = { ...ev };
    if (typeof normalized['event_id'] !== 'string' || !normalized['event_id']) {
      normalized['event_id'] = await computeWireEventId(normalized, roomVersion);
    }
    if (ev['type'] === 'm.room.create' && typeof normalized['room_id'] !== 'string') {
      normalized['room_id'] = `!${String(normalized['event_id']).slice(1)}`;
    }
    await storeEventIdempotent(env.DB, normalized as unknown as PDU, { stateOnly: true });

    const stateKey = ev['state_key'];
    if (ev['type'] === 'm.room.member' && typeof stateKey === 'string') {
      const membership = (ev['content'] as { membership?: string } | undefined)?.membership;
      if (membership === 'join' || membership === 'invite' || membership === 'leave' ||
          membership === 'ban' || membership === 'knock') {
        await updateMembership(env.DB, roomId, stateKey, membership, String(normalized['event_id']));
      }
    }
    return true;
  } catch (err) {
    console.warn('[restricted-joins] skipping remote state event', {
      roomId, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Refresh our copy of a room's current state from the `via` servers given by
 * a federation /refresh_room request. Returns the number of stored PDUs.
 */
export async function refreshRestrictedRoomState(
  env: Env,
  roomId: string,
  viaServers: string[],
  roomVersion: string
): Promise<number> {
  let stored = 0;
  for (const server of [...new Set(viaServers)]) {
    if (!server || server === env.SERVER_NAME) continue;
    try {
      const response = await federationGet(
        server,
        `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}`,
        env.SERVER_NAME,
        env.DB,
        env.CACHE
      );
      if (!response.ok) continue;
      const body = (await response.json()) as { pdus?: unknown };
      const pdus = Array.isArray(body.pdus) ? body.pdus : [];
      for (const pdu of pdus) {
        if (await storeRemoteStateEvent(env, roomId, roomVersion, pdu)) stored++;
      }
      if (stored > 0) break;
    } catch (err) {
      console.warn('[restricted-joins] room state refresh failed', {
        roomId, server, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return stored;
}
