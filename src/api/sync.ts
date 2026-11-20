// Matrix sync endpoint

import { Hono } from 'hono';
import type { AppEnv, SyncResponse, JoinedRoom, InvitedRoom, LeftRoom, Env } from '../types';
import { requireAuth } from '../middleware/auth';
import {
  getUserRooms,
  getRoomState,
  getEventsSince,
  getLatestStreamPosition,
  getInvitePermission,
} from '../services/database';
import { getToDeviceMessages } from './to-device';
import {
  getGlobalAccountData,
  getRoomAccountData,
} from './account-data';
import { getReceiptsForRoom } from './receipts';
import { getTypingUsers } from './typing';

// ============================================
// Sync Filter Types and Helpers
// ============================================

interface EventFilter {
  types?: string[];
  not_types?: string[];
  senders?: string[];
  not_senders?: string[];
  limit?: number;
  /** MSC2732: only send the user's own + timeline senders' memberships. */
  lazy_load_members?: boolean;
  include_leave?: boolean;
}

interface RoomFilter {
  rooms?: string[];
  not_rooms?: string[];
  timeline?: EventFilter;
  state?: EventFilter;
  ephemeral?: EventFilter;
  account_data?: EventFilter;
  include_leave?: boolean;
}

interface SyncFilter {
  room?: RoomFilter;
  presence?: EventFilter;
  account_data?: EventFilter;
  event_format?: 'client' | 'federation';
  event_fields?: string[];
}

// Load a filter from KV storage or parse inline JSON
async function loadFilter(env: Env, userId: string, filterParam?: string): Promise<SyncFilter | null> {
  if (!filterParam) return null;

  // Check if it's inline JSON (starts with '{')
  if (filterParam.startsWith('{')) {
    try {
      return JSON.parse(filterParam);
    } catch {
      console.warn('[sync] Failed to parse inline filter JSON');
      return null;
    }
  }

  // Otherwise it's a filter ID - load from KV
  const filterJson = await env.CACHE.get(`filter:${userId}:${filterParam}`);
  if (!filterJson) {
    console.warn('[sync] Filter not found:', filterParam);
    return null;
  }

  try {
    return JSON.parse(filterJson);
  } catch {
    console.warn('[sync] Failed to parse stored filter JSON');
    return null;
  }
}

// Apply an event filter to a list of events
/** Exported for unit tests. */
export function applyEventFilter(events: any[], filter?: EventFilter): any[] {
  if (!filter) return events;

  let result = events.filter(event => {
    // Filter by type whitelist
    if (filter.types && filter.types.length > 0) {
      const matches = filter.types.some(pattern => {
        if (pattern.endsWith('*')) {
          return event.type.startsWith(pattern.slice(0, -1));
        }
        return event.type === pattern;
      });
      if (!matches) return false;
    }

    // Filter by type blacklist
    if (filter.not_types && filter.not_types.length > 0) {
      const excluded = filter.not_types.some(pattern => {
        if (pattern.endsWith('*')) {
          return event.type.startsWith(pattern.slice(0, -1));
        }
        return event.type === pattern;
      });
      if (excluded) return false;
    }

    // Filter by sender whitelist
    if (filter.senders && filter.senders.length > 0) {
      if (!filter.senders.includes(event.sender)) return false;
    }

    // Filter by sender blacklist
    if (filter.not_senders && filter.not_senders.length > 0) {
      if (filter.not_senders.includes(event.sender)) return false;
    }

    return true;
  });

  // Apply limit
  if (filter.limit && filter.limit > 0) {
    result = result.slice(0, filter.limit);
  }

  return result;
}

// Check if a room should be included based on room filter
/** Exported for unit tests. */
export function shouldIncludeRoom(roomId: string, filter?: RoomFilter): boolean {
  if (!filter) return true;

  // Room whitelist
  if (filter.rooms && filter.rooms.length > 0) {
    if (!filter.rooms.includes(roomId)) return false;
  }

  // Room blacklist
  if (filter.not_rooms && filter.not_rooms.length > 0) {
    if (filter.not_rooms.includes(roomId)) return false;
  }

  return true;
}

// Helper to get one-time key counts for a device
async function getOneTimeKeyCounts(
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<Record<string, number>> {
  const counts = await db.prepare(`
    SELECT algorithm, COUNT(*) as count
    FROM one_time_keys
    WHERE user_id = ? AND device_id = ? AND claimed = 0
    GROUP BY algorithm
  `).bind(userId, deviceId).all<{ algorithm: string; count: number }>();

  const result: Record<string, number> = {};
  for (const row of counts.results) {
    result[row.algorithm] = row.count;
  }
  return result;
}

// Helper to get unused fallback key types for a device
async function getUnusedFallbackKeyTypes(
  db: D1Database,
  userId: string,
  deviceId: string
): Promise<string[]> {
  const keys = await db.prepare(`
    SELECT DISTINCT algorithm
    FROM fallback_keys
    WHERE user_id = ? AND device_id = ? AND used = 0
  `).bind(userId, deviceId).all<{ algorithm: string }>();

  return keys.results.map(row => row.algorithm);
}

// Helper to get device list changes (users whose keys have changed since last sync)
async function getDeviceListChanges(
  db: D1Database,
  userId: string,
  sincePosition: number
): Promise<{ changed: string[]; left: string[] }> {
  // Get users in shared rooms whose device keys have changed
  // Note: We now include the user's own changes as well, because
  // cross-signing signature uploads need to trigger key refresh
  const otherUsersChanged = await db.prepare(`
    SELECT DISTINCT dkc.user_id
    FROM device_key_changes dkc
    WHERE dkc.stream_position > ?
      AND dkc.user_id != ?
      AND EXISTS (
        SELECT 1 FROM room_memberships rm1
        JOIN room_memberships rm2 ON rm1.room_id = rm2.room_id
        WHERE rm1.user_id = ? AND rm1.membership = 'join'
          AND rm2.user_id = dkc.user_id AND rm2.membership = 'join'
      )
  `).bind(sincePosition, userId, userId).all<{ user_id: string }>();

  // Check if the user's own keys have changed (for cross-signing signatures)
  const selfChanged = await db.prepare(`
    SELECT COUNT(*) as count
    FROM device_key_changes dkc
    WHERE dkc.stream_position > ?
      AND dkc.user_id = ?
  `).bind(sincePosition, userId).first<{ count: number }>();

  const changedUsers = otherUsersChanged.results.map(row => row.user_id);

  // Include self in changed list if own keys updated (for cross-signing verification)
  if (selfChanged && selfChanged.count > 0) {
    changedUsers.push(userId);
  }

  // For left, we'd track users who left shared rooms, but for simplicity return empty for now
  return {
    changed: changedUsers,
    left: [],
  };
}

const app = new Hono<AppEnv>();

// GET /_matrix/client/v3/sync - Sync with server
// Parse composite sync token:
//   "s{events}_td{to_device}"                      (legacy composite)
//   "s{events}_td{to_device}_ad{account_data}_dk{device_keys}"  (current)
//   plain number                                    (legacy)
// The account-data and device-keys streams have their own counters (see the
// stream_positions table); omitting their positions would compare them against
// the events position, which redelivers their changes on every sync.
/** Exported for unit tests. */
export function parseSyncToken(token: string | undefined): {
  events: number;
  toDevice: number;
  accountData?: number;
  deviceKeys?: number;
} {
  if (!token) {
    return { events: 0, toDevice: 0 };
  }

  // Composite format, with optional per-stream positions for account data
  // and device keys: s84_td119_ad33_dk7
  const match = token.match(/^s(\d+)_td(\d+)(?:_ad(\d+)_dk(\d+))?$/);
  if (match) {
    const parsed: { events: number; toDevice: number; accountData?: number; deviceKeys?: number } = {
      events: parseInt(match[1]),
      toDevice: parseInt(match[2]),
    };
    if (match[3] !== undefined) parsed.accountData = parseInt(match[3]);
    if (match[4] !== undefined) parsed.deviceKeys = parseInt(match[4]);
    return parsed;
  }

  // Legacy format: plain number (use for both streams for backwards compat)
  const num = parseInt(token);
  if (!isNaN(num)) {
    return { events: num, toDevice: num };
  }

  return { events: 0, toDevice: 0 };
}

// Build composite sync token. The account-data / device-keys suffix is only
// emitted when either position is non-zero, so accounts that never wrote to
// those streams keep the compact legacy format.
/** Exported for unit tests. */
export function buildSyncToken(
  eventsPos: number,
  toDevicePos: number,
  accountDataPos: number = 0,
  deviceKeysPos: number = 0
): string {
  const base = `s${eventsPos}_td${toDevicePos}`;
  if (accountDataPos === 0 && deviceKeysPos === 0) {
    return base;
  }
  return `${base}_ad${accountDataPos}_dk${deviceKeysPos}`;
}

// Read the current value of a named stream counter (see stream_positions;
// written by account-data.ts / keys.ts / to-device.ts). Missing rows and
// absent tables both mean "position 0" — e.g. in minimal test doubles.
async function getStreamPosition(db: D1Database, streamName: string): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT position FROM stream_positions WHERE stream_name = ?`)
      .bind(streamName)
      .first<{ position: number }>();
    return row?.position ?? 0;
  } catch {
    return 0;
  }
}

app.get('/_matrix/client/v3/sync', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const deviceId = c.get('deviceId');

  // Parse query parameters
  const since = c.req.query('since');
  const fullState = c.req.query('full_state') === 'true';
  const useStateAfter =
    c.req.query('use_state_after') === 'true' ||
    c.req.query('org.matrix.msc4222.use_state_after') === 'true';
  const filterParam = c.req.query('filter');

  // Load filter if specified
  const filter = await loadFilter(c.env, userId, filterParam);
  if (filterParam && !filter) {
    console.log('[sync] Using no filter (filter not found or invalid)');
  }

  // Parse composite sync token (separate positions per stream)
  const {
    events: sincePosition,
    toDevice: sinceToDevice,
    accountData: sinceAccountData,
    deviceKeys: sinceDeviceKeys,
  } = parseSyncToken(since);
  // A token was supplied iff this is an incremental sync. Position values
  // alone are not enough: accounts with no room events always sit at s0, and
  // treating their incremental syncs as initial ones redelivers every
  // account-data / device-list change on every request.
  const hasSinceToken = since !== undefined;
  // Legacy tokens carry no account-data / device-keys positions; fall back to
  // the events position so their behaviour is unchanged during the transition.
  const sinceAccountDataPos = sinceAccountData ?? sincePosition;
  const sinceDeviceKeysPos = sinceDeviceKeys ?? sincePosition;

  // Get current position
  const currentPosition = await getLatestStreamPosition(c.env.DB);

  // Snapshot the per-stream counters BEFORE any response data is read, and
  // use these snapshots — never fresher reads — for next_batch. A write that
  // lands while this response is being assembled (in particular during the
  // DO long-poll wait below) must NOT be consumed by next_batch unless it is
  // actually delivered in this response: clients such as js-sdk's
  // `setAccountData` resolve only when their write is echoed back over sync,
  // so a token that advances past an undelivered change hangs them forever.
  // Under-advancing is safe (the change is redelivered next sync).
  const [currentAccountDataPos, currentDeviceKeysPos] = await Promise.all([
    getStreamPosition(c.env.DB, 'account_data'),
    getStreamPosition(c.env.DB, 'device_keys'),
  ]);

  // Track to-device position for next_batch
  let currentToDevicePos = sinceToDevice;

  // If no changes and timeout, wait (using Durable Objects for long-polling)
  // For now, just return immediately

  // Build sync response (next_batch will be set at the end)
  const response: SyncResponse = {
    next_batch: '', // Set below
    rooms: {
      join: {},
      invite: {},
      leave: {},
    },
    presence: {
      events: [],
    },
    account_data: {
      events: [],
    },
    to_device: {
      events: [],
    },
    device_one_time_keys_count: {},
    device_unused_fallback_key_types: [],
  };

  // Get to-device messages (E2E encryption key exchange, verification, etc.)
  if (deviceId) {
    // Pass the to-device specific position for proper acknowledgment
    const toDeviceResult = await getToDeviceMessages(c.env.DB, userId, deviceId, String(sinceToDevice));
    response.to_device!.events = toDeviceResult.events;

    // Update to-device position for next_batch
    currentToDevicePos = parseInt(toDeviceResult.nextBatch) || sinceToDevice;

    // Get E2E encryption key counts for this device
    response.device_one_time_keys_count = await getOneTimeKeyCounts(c.env.DB, userId, deviceId);
    response.device_unused_fallback_key_types = await getUnusedFallbackKeyTypes(c.env.DB, userId, deviceId);

    // Debug E2EE state for first sync
    if (!hasSinceToken) {
      console.log('[sync] Initial sync E2EE state for', userId, ':', {
        otk_counts: response.device_one_time_keys_count,
        fallback_types: response.device_unused_fallback_key_types,
        to_device_count: response.to_device!.events.length,
      });
    }
  }

  // Get device list changes (users whose keys have changed since last sync)
  if (hasSinceToken) {
    const deviceListChanges = await getDeviceListChanges(c.env.DB, userId, sinceDeviceKeysPos);
    if (deviceListChanges.changed.length > 0 || deviceListChanges.left.length > 0) {
      response.device_lists = deviceListChanges;
    }
  } else {
    // For initial sync, include the user's own ID in device_lists.changed
    // This tells Element X to fetch device keys immediately, which is important
    // for cross-signing verification to work correctly after first login
    response.device_lists = {
      changed: [userId],
      left: [],
    };
    console.log('[sync] Initial sync - including self in device_lists.changed to trigger key fetch');
  }

  // Get global account data
  // For initial sync (no since token), get all account data
  // For incremental sync, only get changed account data since last sync
  let globalAccountData = await getGlobalAccountData(
    c.env.DB,
    userId,
    hasSinceToken ? sinceAccountDataPos : undefined
  );
  // Apply account_data filter to global account data
  globalAccountData = applyEventFilter(globalAccountData, filter?.account_data);
  response.account_data!.events = globalAccountData;

  // Debug: Log global account_data that will be returned (for initial sync)
  if (!hasSinceToken) {
    console.log('[sync] Initial sync account_data for', userId, ':',
      globalAccountData.length > 0 ? globalAccountData.map(e => e.type) : 'none');
  }

  // Get user's joined rooms
  const joinedRoomIds = await getUserRooms(c.env.DB, userId, 'join');
  for (const roomId of joinedRoomIds) {
    // Check if room should be included based on filter
    if (!shouldIncludeRoom(roomId, filter?.room)) {
      continue;
    }

    const joinedRoom: JoinedRoom = {
      timeline: {
        events: [],
        limited: false,
      },
      state: {
        events: [],
      },
      ephemeral: {
        events: [],
      },
      account_data: {
        events: [],
      },
    };

    // Get events since last sync
    const events = await getEventsSince(c.env.DB, roomId, sincePosition);
    const isInitial = !hasSinceToken || fullState;

    // Separate state and timeline events
    let stateEvents: any[] = [];
    let timelineEvents: any[] = [];

    for (const event of events) {
      const clientEvent = {
        type: event.type,
        state_key: event.state_key,
        content: event.content,
        sender: event.sender,
        origin_server_ts: event.origin_server_ts,
        event_id: event.event_id,
        room_id: event.room_id,
        unsigned: event.unsigned,
      };

      if (event.state_key !== undefined) {
        // State event - always in the state section. On initial sync keep it
        // out of the timeline so clients don't render years of old state as
        // messages; incremental syncs still surface state changes inline.
        stateEvents.push(clientEvent);
        if (!isInitial) timelineEvents.push(clientEvent);
      } else {
        timelineEvents.push(clientEvent);
      }
    }

    // A room joined within this window must carry its full state even on an
    // INCREMENTAL sync: the join's state snapshot is stored outside the
    // timeline (negative stream positions — invisible to the `> since`
    // window), so a client with a running session would otherwise learn the
    // room exists but never receive its name/topic/avatar and render it as
    // "Unnamed Room". Initial syncs already include full state below.
    if (!isInitial) {
      const joinedInWindow = events.some(
        (e) =>
          e.type === 'm.room.member' &&
          e.state_key === userId &&
          (e.content as { membership?: string } | undefined)?.membership === 'join'
      );
      if (joinedInWindow) {
        const state = await getRoomState(c.env.DB, roomId);
        for (const event of state) {
          const clientEvent = {
            type: event.type,
            state_key: event.state_key,
            content: event.content,
            sender: event.sender,
            origin_server_ts: event.origin_server_ts,
            event_id: event.event_id,
            room_id: event.room_id,
          };
          if (!stateEvents.find(e => e.event_id === event.event_id)) {
            stateEvents.push(clientEvent);
          }
        }
      }
    }

    // Include full state if requested or initial sync
    if (fullState || !hasSinceToken) {
      const state = await getRoomState(c.env.DB, roomId);
      for (const event of state) {
        const clientEvent = {
          type: event.type,
          state_key: event.state_key,
          content: event.content,
          sender: event.sender,
          origin_server_ts: event.origin_server_ts,
          event_id: event.event_id,
          room_id: event.room_id,
        };
        // Only add if not already in state events from timeline
        if (!stateEvents.find(e => e.event_id === event.event_id)) {
          stateEvents.push(clientEvent);
        }
      }
    }

    // Apply filters to state and timeline events
    stateEvents = applyEventFilter(stateEvents, filter?.room?.state);
    timelineEvents = applyEventFilter(timelineEvents, filter?.room?.timeline);

    // MSC2732 lazy loading: clients (Element Web by default) ask for only
    // their own membership plus the memberships of timeline senders, instead
    // of every member of every room — a 4,000-member room would otherwise
    // ship a multi-hundred-KB initial sync and choke fresh logins. The rest
    // of the members are fetched on demand via the members API.
    if (filter?.room?.state?.lazy_load_members) {
      const timelineSenders = new Set(timelineEvents.map(e => e.sender));
      timelineSenders.add(userId);
      stateEvents = stateEvents.filter(e => {
        if (e.type !== 'm.room.member') return true;
        return e.state_key !== undefined && timelineSenders.has(e.state_key);
      });
    }

    // On initial sync return only a recent timeline window so clients show the
    // latest messages and backfill older history on demand, instead of walking
    // the room's entire history.
    const timelineLimit = filter?.room?.timeline?.limit ?? 20;
    if (isInitial && timelineEvents.length > timelineLimit) {
      timelineEvents = timelineEvents.slice(-timelineLimit);
      joinedRoom.timeline!.limited = true;
    }

    joinedRoom.timeline!.events = timelineEvents;
    joinedRoom.timeline!.prev_batch = sincePosition.toString();

    // MSC4222 (opt-in via ?org.matrix.msc4222.use_state_after=true): the room
    // state AFTER the timeline window rides INSIDE the timeline object
    // (rooms.join.<id>.timeline.state_after). A previous implementation
    // deleted the room's `state` section and emitted a room-level
    // `state_after` key that is not in the sync schema — clients requesting
    // the flag (Element Web by default) received stateless rooms and
    // rendered them as "Empty room" with a join prompt. The classic `state`
    // section (state at the START of the timeline) is kept: non-opted-in
    // clients are unchanged, and opted-in clients that still read `state`
    // keep working.
    if (useStateAfter) {
      let afterState = await getRoomState(c.env.DB, roomId);
      if (filter?.room?.state?.lazy_load_members) {
        const afterSenders = new Set(timelineEvents.map(e => e.sender));
        afterSenders.add(userId);
        afterState = afterState.filter(e => {
          if (e.type !== 'm.room.member') return true;
          return e.state_key !== undefined && afterSenders.has(e.state_key);
        });
      }
      joinedRoom.timeline!.state_after = {
        events: afterState.map((e) => ({
          type: e.type,
          state_key: e.state_key,
          content: e.content,
          sender: e.sender,
          origin_server_ts: e.origin_server_ts,
          event_id: e.event_id,
          room_id: e.room_id,
        })),
      };
    }
    joinedRoom.state!.events = stateEvents;

    // Get room-level account data
    let roomAccountData = await getRoomAccountData(
      c.env.DB,
      userId,
      roomId,
      hasSinceToken ? sinceAccountDataPos : undefined
    );
    // Apply account_data filter to room account data
    roomAccountData = applyEventFilter(roomAccountData, filter?.room?.account_data);
    joinedRoom.account_data!.events = roomAccountData;

    // Get read receipts for this room (from Room Durable Object)
    // Pass userId to filter m.read.private receipts (only visible to owner)
    const receipts = await getReceiptsForRoom(c.env, roomId, userId);
    if (Object.keys(receipts.content).length > 0) {
      joinedRoom.ephemeral!.events.push(receipts);
    }

    // Get typing indicators for this room (from Room Durable Object)
    const typingUsers = await getTypingUsers(c.env, roomId);
    if (typingUsers.length > 0) {
      joinedRoom.ephemeral!.events.push({
        type: 'm.typing',
        content: { user_ids: typingUsers }
      });
    }

    // Apply ephemeral filter
    joinedRoom.ephemeral!.events = applyEventFilter(
      joinedRoom.ephemeral!.events,
      filter?.room?.ephemeral
    );

    response.rooms!.join![roomId] = joinedRoom;
  }

  // Get invited rooms
  const invitedRoomIds = await getUserRooms(c.env.DB, userId, 'invite');
  for (const roomId of invitedRoomIds) {
    // Check if room should be included based on filter
    if (!shouldIncludeRoom(roomId, filter?.room)) {
      continue;
    }

    const state = await getRoomState(c.env.DB, roomId);

    // MSC4155: an 'ignore' decision accepts the invite but withholds it from
    // the recipient's sync. The inviter is the sender of the invitee's own
    // m.room.member event.
    const inviteEvent = state.find(
      (e) => e.type === 'm.room.member' && e.state_key === userId
    );
    if (
      inviteEvent &&
      (await getInvitePermission(c.env.DB, userId, inviteEvent.sender)) === 'ignore'
    ) {
      continue;
    }

    // Strip state for invited rooms
    let strippedState = state.map(event => ({
      type: event.type,
      state_key: event.state_key!,
      content: event.content,
      sender: event.sender,
    }));

    // Apply state filter to invited room state
    strippedState = applyEventFilter(strippedState, filter?.room?.state);

    const invitedRoom: InvitedRoom = {
      invite_state: {
        events: strippedState,
      },
    };

    response.rooms!.invite![roomId] = invitedRoom;
  }

  // Get left rooms (rooms the user left since last sync). Deliberately not
  // gated on the include_leave filter flag: a room left on another device
  // otherwise lingers in an open session (every room endpoint 403s) until a
  // full client reload. Bounded by the leave event's stream position vs
  // `since`, so each client sees a given leave exactly once.
  if (sincePosition > 0) {
    const leftRoomIds = await getUserRooms(c.env.DB, userId, 'leave');
    for (const roomId of leftRoomIds) {
      // Check if room should be included based on filter
      if (!shouldIncludeRoom(roomId, filter?.room)) {
        continue;
      }

      // Only include if membership changed since last sync
      const events = await getEventsSince(c.env.DB, roomId, sincePosition);
      const leaveEvent = events.find(
        e => e.type === 'm.room.member' && e.state_key === userId
      );

      if (leaveEvent) {
        const leftRoom: LeftRoom = {
          timeline: {
            events: [
              {
                type: leaveEvent.type,
                state_key: leaveEvent.state_key,
                content: leaveEvent.content,
                sender: leaveEvent.sender,
                origin_server_ts: leaveEvent.origin_server_ts,
                event_id: leaveEvent.event_id,
                room_id: leaveEvent.room_id,
              },
            ],
          },
        };

        response.rooms!.leave![roomId] = leftRoom;
      }
    }
  }

  // Check if there are any changes to return
  const hasRoomChanges = Object.keys(response.rooms!.join!).some(roomId => {
    const room = response.rooms!.join![roomId];
    return room.timeline!.events.length > 0
      || (room.state?.events.length ?? 0) > 0
      || (room.timeline?.state_after?.events.length ?? 0) > 0;
  });
  const hasInvites = Object.keys(response.rooms!.invite!).length > 0;
  const hasLeaves = Object.keys(response.rooms!.leave!).length > 0;
  const hasToDevice = response.to_device!.events.length > 0;
  const hasAccountData = response.account_data!.events.length > 0;
  const hasChanges = hasRoomChanges || hasInvites || hasLeaves || hasToDevice || hasAccountData;

  // Parse timeout from query params (default 0 for no wait, max 30s)
  const timeout = Math.min(parseInt(c.req.query('timeout') || '0'), 30000);

  // If no changes and timeout > 0, wait for events via Durable Object
  if (!hasChanges && timeout > 0 && hasSinceToken) {
    console.log('[sync] Entering DO wait for', userId, 'timeout:', timeout);
    const syncDO = c.env.SYNC;
    const doId = syncDO.idFromName(userId);
    const stub = syncDO.get(doId);

    // Wait for up to 25s (leave buffer for response)
    const waitTimeout = Math.min(timeout, 25000);
    const waitResponse = await stub.fetch(new Request('http://internal/wait-for-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout: waitTimeout }),
    }));

    const waitResult = await waitResponse.json() as { hasEvents: boolean };
    console.log('[sync] DO wait result for', userId, ':', waitResult);

    if (waitResult.hasEvents) {
      console.log('[sync] Woken up early - events arrived for', userId);
      // New events arrived - return empty response with SAME next_batch
      // Client will immediately sync again and get the new events
      // We intentionally do NOT advance next_batch here, so the client
      // re-syncs from the same position and actually sees the events
    }
  } else if (timeout > 0 && hasSinceToken) {
    console.log('[sync] Skipping DO wait for', userId, '- hasChanges:', hasChanges,
      'roomChanges:', hasRoomChanges, 'invites:', hasInvites, 'leaves:', hasLeaves,
      'toDevice:', hasToDevice, 'accountData:', hasAccountData);
  }

  // Build composite next_batch token with separate positions for each stream.
  // Deliberately uses the positions snapshotted at the START of this handler
  // (before any data was read), so next_batch can never skip a change that
  // landed mid-response and was therefore not delivered (see the snapshot
  // comment above; a skipped change is lost forever once the token passes it).
  if (!response.next_batch) {
    response.next_batch = buildSyncToken(
      currentPosition,
      currentToDevicePos,
      currentAccountDataPos,
      currentDeviceKeysPos
    );
  }

  return c.json(response);
});

export default app;
