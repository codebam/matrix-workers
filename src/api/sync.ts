// Matrix sync endpoint

import { Hono } from 'hono';
import type {
  AppEnv,
  SyncResponse,
  JoinedRoom,
  InvitedRoom,
  LeftRoom,
  KnockedRoom,
  StrippedStateEvent,
  RoomSummary,
  PresenceEvent,
  PresenceState,
  PDU,
  Env,
} from '../types';
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
  getStickyEventsForRooms,
  type StickyClientEvent,
} from './account-data';
import { getReceiptsForRoom } from './receipts';
import { getTypingUsers } from './typing';

// Stripped state a knocking user is allowed to see before they join (Matrix
// v1.19 /sync rooms.knock). Their own membership event is added separately.
const KNOCK_STRIPPED_STATE_TYPES = [
  'm.room.create',
  'm.room.join_rules',
  'm.room.name',
  'm.room.avatar',
  'm.room.canonical_alias',
  'm.room.encryption',
];

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
  /** Spec filter.event_format: 'client' strips federation-only PDU fields. */
  event_format?: 'client' | 'federation';
  /** Spec filter.event_fields: project each event to these top-level fields. */
  event_fields?: string[];
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

  // Spec event_format / event_fields: the filter may be set globally (on the
  // filter object) or on an individual room/event section; either way the
  // projection happens here, after matching and limiting.
  if (!filter.event_format && !(filter.event_fields && filter.event_fields.length > 0)) {
    return result;
  }
  return result.map(event => projectEvent(event, filter));
}

// Fields that only exist on federation-format PDUs. Client sync events must
// not carry them; federation format keeps whatever the event already has.
const FEDERATION_ONLY_EVENT_FIELDS = [
  'auth_events',
  'prev_events',
  'depth',
  'hashes',
  'signatures',
] as const;

function projectEvent(event: any, filter: EventFilter): any {
  let projected = event;
  if (filter.event_format === 'client') {
    if (FEDERATION_ONLY_EVENT_FIELDS.some(field => field in projected)) {
      projected = { ...event };
      for (const field of FEDERATION_ONLY_EVENT_FIELDS) delete projected[field];
    }
  }
  if (filter.event_fields && filter.event_fields.length > 0) {
    const picked: Record<string, unknown> = {};
    for (const field of filter.event_fields) {
      if (Object.prototype.hasOwnProperty.call(projected, field)) {
        picked[field] = projected[field];
      }
    }
    projected = picked;
  }
  return projected;
}

// The spec puts event_format / event_fields at the top level of the filter,
// while the section filters carry the type/sender rules. Merge the two so a
// single applyEventFilter call handles both.
function withEventFormat(filter: SyncFilter | null, section?: EventFilter): EventFilter | undefined {
  if (!filter) return section;
  if (!section && !filter.event_format && !filter.event_fields) return undefined;
  const merged: EventFilter = { ...(section ?? {}) };
  if (filter.event_format) merged.event_format = filter.event_format;
  if (filter.event_fields) merged.event_fields = filter.event_fields;
  return merged;
}

// PDU-only fields are not part of the client event shape; keep them out of
// the response unless the client explicitly asked for federation format.
function federationEventFields(event: PDU): Record<string, unknown> {
  return {
    depth: event.depth,
    auth_events: event.auth_events,
    prev_events: event.prev_events,
    ...(event.hashes ? { hashes: event.hashes } : {}),
    ...(event.signatures ? { signatures: event.signatures } : {}),
  };
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

// A user belongs to another server when the MXID's domain differs from ours.
// We only advertise device_lists.left for those users: local users remain
// reachable through the local /keys API and must not be dropped.
function isRemoteUser(userId: string, serverName: string): boolean {
  const colon = userId.indexOf(':');
  return colon > 0 && userId.slice(colon + 1) !== serverName;
}

// device_lists.left: users we no longer share a room with because the CALLER
// left or was banned from rooms since the token. Reuses the rooms.leave
// detection mechanism (getUserRooms + membership events since `since`), and
// reads the room's membership rows for the users who were in those rooms.
// Remote membership rows survive the departure locally, so they can be
// enumerated from room_memberships without another table. Exported for tests.
export async function getDeviceListRemovals(
  db: D1Database,
  userId: string,
  sincePosition: number,
  serverName: string
): Promise<string[]> {
  if (sincePosition <= 0 || !serverName) return [];

  const [leftRoomIds, bannedRoomIds] = await Promise.all([
    getUserRooms(db, userId, 'leave'),
    getUserRooms(db, userId, 'ban'),
  ]);
  const roomIds = [...new Set([...leftRoomIds, ...bannedRoomIds])];
  const left: string[] = [];
  const seen = new Set<string>();

  for (const roomId of roomIds) {
    const events = await getEventsSince(db, roomId, sincePosition);
    const departure = events.find(event => {
      if (event.type !== 'm.room.member' || event.state_key !== userId) return false;
      const membership = (event.content as { membership?: unknown } | undefined)?.membership;
      return membership === 'leave' || membership === 'ban';
    });
    if (!departure) continue;

    const members = await db.prepare(`
      SELECT user_id FROM room_memberships
      WHERE room_id = ? AND user_id != ? AND membership IN ('join', 'leave', 'ban')
    `).bind(roomId, userId).all<{ user_id: string }>();

    for (const member of members.results) {
      if (!isRemoteUser(member.user_id, serverName) || seen.has(member.user_id)) continue;
      seen.add(member.user_id);
      left.push(member.user_id);
    }
  }

  return left;
}

// Helper to get device list changes (users whose keys have changed since last sync)
async function getDeviceListChanges(
  db: D1Database,
  userId: string,
  sinceDeviceKeysPosition: number,
  sinceEventsPosition: number,
  serverName: string
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
  `).bind(sinceDeviceKeysPosition, userId, userId).all<{ user_id: string }>();

  // Check if the user's own keys have changed (for cross-signing signatures)
  const selfChanged = await db.prepare(`
    SELECT COUNT(*) as count
    FROM device_key_changes dkc
    WHERE dkc.stream_position > ?
      AND dkc.user_id = ?
  `).bind(sinceDeviceKeysPosition, userId).first<{ count: number }>();

  const changedUsers = otherUsersChanged.results.map(row => row.user_id);

  // Include self in changed list if own keys updated (for cross-signing verification)
  if (selfChanged && selfChanged.count > 0) {
    changedUsers.push(userId);
  }

  return {
    changed: changedUsers,
    left: await getDeviceListRemovals(db, userId, sinceEventsPosition, serverName),
  };
}

// Redacted state events serve their pruned content in stripped state (used by
// both invite_state and knock_state). The redaction pipeline stores the pruned
// JSON on events.redacted_content, keyed by event_id.
async function getPrunedContentMap(
  db: D1Database,
  roomId: string
): Promise<Map<string, Record<string, unknown>>> {
  const redactedRows = await db.prepare(
    `SELECT event_id, redacted_content FROM events WHERE room_id = ? AND redacted_content IS NOT NULL`
  ).bind(roomId).all<{ event_id: string; redacted_content: string }>();

  return new Map(
    redactedRows.results.map(r => [r.event_id, JSON.parse(r.redacted_content)] as const)
  );
}

// rooms.join.<roomId>.summary. Spec: heroes are only needed for rooms with no
// m.room.name, so named rooms omit the whole summary object. Heroes mirror the
// sliding-sync logic: up to five other joined members.
async function getRoomSummary(
  db: D1Database,
  roomId: string,
  userId: string
): Promise<RoomSummary | undefined> {
  const named = await db.prepare(`
    SELECT event_id FROM room_state WHERE room_id = ? AND event_type = 'm.room.name'
  `).bind(roomId).all<{ event_id: string }>();
  if (named.results.length > 0) return undefined;

  const [counts, heroes] = await Promise.all([
    db.prepare(`
      SELECT membership, COUNT(*) as count FROM room_memberships
      WHERE room_id = ? AND membership IN ('join', 'invite')
      GROUP BY membership
    `).bind(roomId).all<{ membership: string; count: number }>(),
    db.prepare(`
      SELECT user_id, display_name, avatar_url FROM room_memberships
      WHERE room_id = ? AND membership = 'join' AND user_id != ?
      LIMIT 5
    `).bind(roomId, userId).all<{
      user_id: string;
      display_name: string | null;
      avatar_url: string | null;
    }>(),
  ]);

  let joined = 0;
  let invited = 0;
  for (const row of counts.results) {
    if (row.membership === 'join') joined = row.count;
    if (row.membership === 'invite') invited = row.count;
  }

  return {
    'm.heroes': heroes.results.map(h => h.user_id),
    'm.joined_member_count': joined,
    'm.invited_member_count': invited,
  };
}

const PRESENCE_TIMEOUT_MS = 5 * 60 * 1000;

interface PresenceSyncRow {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ts: number | null;
  currently_active?: number | boolean | null;
}

function toPresenceEvent(row: PresenceSyncRow, now: number): PresenceEvent {
  const lastActiveTs = row.last_active_ts ?? 0;
  const isActive = lastActiveTs > 0 && now - lastActiveTs < PRESENCE_TIMEOUT_MS;
  const effectivePresence: PresenceState =
    row.presence === 'online' && !isActive ? 'unavailable' : row.presence as PresenceState;
  // PUT and inbound EDUs both stamp currently_active on the row. Rows written
  // before that column existed fall back to the activity heuristic.
  const storedActive =
    row.currently_active == null ? isActive : Boolean(row.currently_active);
  return {
    type: 'm.presence' as const,
    sender: row.user_id,
    content: {
      presence: effectivePresence,
      ...(row.status_msg ? { status_msg: row.status_msg } : {}),
      last_active_ago: Math.max(0, now - lastActiveTs),
      currently_active: storedActive && effectivePresence === 'online',
    },
  };
}

// Presence for legacy /sync. Initial sync (no cursor) sends the current state
// of the caller and everyone sharing a room. Incremental sync sends only rows
// whose stream_position is newer than the presence cursor in `since`; the
// shared-room predicate mirrors getDeviceListChanges in this file so a user we
// no longer share a room with never receives our presence (or vice versa).
// event_id / origin_server_ts are not stored for presence, so they are omitted
// rather than invented.
/** Exported for unit tests. */
export async function getPresenceEventsForSync(
  db: D1Database,
  userId: string,
  roomIds: string[],
  sincePresence?: number
): Promise<PresenceEvent[]> {
  const now = Date.now();

  if (sincePresence === undefined) {
    const userIds = new Set<string>([userId]);
    for (const roomId of roomIds) {
      const members = await db.prepare(`
        SELECT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join'
      `).bind(roomId).all<{ user_id: string }>();
      for (const member of members.results) userIds.add(member.user_id);
    }

    // Chunk the IN clause below D1's 100 bind-variable limit (500 placeholders
    // threw "too many SQL variables" and broke initial /sync after a cache
    // clear on rooms with many members).
    const ids = [...userIds];
    const rows: PresenceSyncRow[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await db.prepare(`
        SELECT user_id, presence, status_msg, last_active_ts, currently_active
        FROM presence WHERE user_id IN (${placeholders})
      `).bind(...chunk).all<PresenceSyncRow>();
      rows.push(...result.results);
    }
    return rows.map(row => toPresenceEvent(row, now));
  }

  const result = await db.prepare(`
    SELECT p.user_id, p.presence, p.status_msg, p.last_active_ts, p.currently_active
    FROM presence p
    WHERE p.stream_position > ?
      AND (
        p.user_id = ?
        OR EXISTS (
          SELECT 1 FROM room_memberships rm1
          JOIN room_memberships rm2 ON rm1.room_id = rm2.room_id
          WHERE rm1.user_id = ? AND rm1.membership = 'join'
            AND rm2.user_id = p.user_id AND rm2.membership = 'join'
        )
      )
    ORDER BY p.stream_position ASC
  `).bind(sincePresence, userId, userId).all<PresenceSyncRow>();
  return result.results.map(row => toPresenceEvent(row, now));
}

/** Legacy name kept for callers/tests that only need initial presence. */
export const getInitialPresenceEvents = (
  db: D1Database,
  userId: string,
  roomIds: string[]
): Promise<PresenceEvent[]> => getPresenceEventsForSync(db, userId, roomIds);

const app = new Hono<AppEnv>();

// GET /_matrix/client/v3/sync - Sync with server
// Parse composite sync token:
//   "s{events}_td{to_device}"                      (legacy composite)
//   "s{events}_td{to_device}_ad{account_data}_dk{device_keys}"  (current)
//   "..._pr{presence}"                             (presence cursor, optional)
//   plain number                                    (legacy)
// The account-data, device-keys and presence streams have their own counters
// (see the stream_positions table); omitting their positions would compare
// them against the events position, which redelivers their changes on every
// sync. Tokens without _pr (issued before 030) are treated as presence 0: rows
// backfilled by the migration carry position 0, so only genuinely new changes
// are replayed once.
/** Exported for unit tests. */
export function parseSyncToken(token: string | undefined): {
  events: number;
  toDevice: number;
  accountData?: number;
  deviceKeys?: number;
  presence?: number;
} {
  if (!token) {
    return { events: 0, toDevice: 0 };
  }

  // Composite format, with optional per-stream positions for account data,
  // device keys and presence: s84_td119_ad33_dk7_pr2
  const match = token.match(/^s(\d+)_td(\d+)(?:_ad(\d+)_dk(\d+))?(?:_pr(\d+))?$/);
  if (match) {
    const parsed: {
      events: number;
      toDevice: number;
      accountData?: number;
      deviceKeys?: number;
      presence?: number;
    } = {
      events: parseInt(match[1]),
      toDevice: parseInt(match[2]),
    };
    if (match[3] !== undefined) parsed.accountData = parseInt(match[3]);
    if (match[4] !== undefined) parsed.deviceKeys = parseInt(match[4]);
    if (match[5] !== undefined) parsed.presence = parseInt(match[5]);
    return parsed;
  }

  // Legacy format: plain number (use for both streams for backwards compat)
  const num = parseInt(token);
  if (!isNaN(num)) {
    return { events: num, toDevice: num };
  }

  return { events: 0, toDevice: 0 };
}

// Build composite sync token. The account-data / device-keys and presence
// suffixes are only emitted when their position is non-zero, so accounts that
// never wrote to those streams keep the compact legacy format. `_pr` may appear
// on its own (without `_ad`/`_dk`) to avoid churning tokens for accounts with
// no account-data or device-key changes.
/** Exported for unit tests. */
export function buildSyncToken(
  eventsPos: number,
  toDevicePos: number,
  accountDataPos: number = 0,
  deviceKeysPos: number = 0,
  presencePos: number = 0
): string {
  let token = `s${eventsPos}_td${toDevicePos}`;
  if (accountDataPos !== 0 || deviceKeysPos !== 0) {
    token += `_ad${accountDataPos}_dk${deviceKeysPos}`;
  }
  if (presencePos !== 0) {
    token += `_pr${presencePos}`;
  }
  return token;
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
  const federationFormat = filter?.event_format === 'federation';

  // Parse composite sync token (separate positions per stream)
  const {
    events: sincePosition,
    toDevice: sinceToDevice,
    accountData: sinceAccountData,
    deviceKeys: sinceDeviceKeys,
    presence: sincePresence,
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
  const [currentAccountDataPos, currentDeviceKeysPos, currentPresencePos] = await Promise.all([
    getStreamPosition(c.env.DB, 'account_data'),
    getStreamPosition(c.env.DB, 'device_keys'),
    getStreamPosition(c.env.DB, 'presence'),
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
      knock: {},
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
    const deviceListChanges = await getDeviceListChanges(
      c.env.DB,
      userId,
      sinceDeviceKeysPos,
      sincePosition,
      c.env.SERVER_NAME
    );
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
  globalAccountData = applyEventFilter(globalAccountData, withEventFormat(filter, filter?.account_data));
  response.account_data!.events = globalAccountData;

  // Debug: Log global account_data that will be returned (for initial sync)
  if (!hasSinceToken) {
    console.log('[sync] Initial sync account_data for', userId, ':',
      globalAccountData.length > 0 ? globalAccountData.map(e => e.type) : 'none');
  }

  // Get user's joined rooms
  const joinedRoomIds = await getUserRooms(c.env.DB, userId, 'join');

  // MSC4354: sticky events are stored outside the timeline tables, so they
  // never enter `getEventsSince`; they ride in their own `sticky` room section.
  // A failure here must never break the rest of sync.
  type StickyJoinedRoom = JoinedRoom & {
    sticky?: { events: StickyClientEvent[] };
    msc4354_sticky?: { events: StickyClientEvent[] };
  };
  let stickyByRoom: Record<string, StickyClientEvent[]> = {};
  try {
    stickyByRoom = await getStickyEventsForRooms(c.env.DB, joinedRoomIds, {
      since: hasSinceToken ? sinceAccountDataPos : undefined,
    });
  } catch (error) {
    console.error('[sync] Failed to load sticky events:', error);
  }

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
        ...(federationFormat ? federationEventFields(event) : {}),
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
            ...(federationFormat ? federationEventFields(event) : {}),
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
          ...(federationFormat ? federationEventFields(event) : {}),
        };
        // Only add if not already in state events from timeline
        if (!stateEvents.find(e => e.event_id === event.event_id)) {
          stateEvents.push(clientEvent);
        }
      }
    }

    // Apply filters to state and timeline events
    stateEvents = applyEventFilter(stateEvents, withEventFormat(filter, filter?.room?.state));
    timelineEvents = applyEventFilter(timelineEvents, withEventFormat(filter, filter?.room?.timeline));

    // MSC2732 lazy loading: clients (Element Web by default) ask for only
    // their own membership plus the memberships of timeline senders, instead
    // of every member of every room — a 4,000-member room would otherwise
    // ship a multi-hundred-KB initial sync and choke fresh logins. The rest
    // of the members are fetched on demand via the members API.
    // MSC4354: a sticky event appearing in neither timeline nor sticky section
    // is dropped here; the rest are deduplicated against the timeline so a
    // given event is never rendered twice in one response.
    const stickyEvents = (stickyByRoom[roomId] ?? []).filter(
      sticky => !timelineEvents.some(event => event.event_id === sticky.event_id)
    );

    if (filter?.room?.state?.lazy_load_members) {
      const timelineSenders = new Set(timelineEvents.map(e => e.sender));
      // MSC4354: sticky senders count as timeline senders for lazy loading.
      for (const sticky of stickyEvents) timelineSenders.add(sticky.sender);
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
    if (stickyEvents.length > 0) {
      const withSticky = joinedRoom as StickyJoinedRoom;
      // Stable and unstable section names are both emitted while MSC4354 is
      // not part of the spec proper; clients may read either.
      withSticky.sticky = { events: stickyEvents };
      withSticky.msc4354_sticky = { events: stickyEvents };
    }
    // prev_batch must point at the START of the returned timeline window so
    // clients paginate backwards into older history. Using sincePosition
    // here (0 on initial sync) made /messages?from=0 return the NEWEST events
    // again — today's messages got prepended in front of yesterday's and
    // clients appeared to have almost no history after a cache clear.
    let prevBatch = sincePosition;
    if (timelineEvents.length > 0) {
      try {
        const oldest = await c.env.DB.prepare(
          `SELECT stream_ordering FROM events WHERE event_id = ?`
        ).bind(timelineEvents[0].event_id).first<{ stream_ordering: number }>();
        if (oldest?.stream_ordering != null) prevBatch = oldest.stream_ordering;
      } catch {
        // A position lookup must never fail the whole sync; fall back to the
        // stream token already available.
      }
    }
    joinedRoom.timeline!.prev_batch = prevBatch.toString();

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
          ...(federationFormat ? federationEventFields(e) : {}),
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
    roomAccountData = applyEventFilter(
      roomAccountData,
      withEventFormat(filter, filter?.room?.account_data)
    );
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
      withEventFormat(filter, filter?.room?.ephemeral)
    );

    const summary = await getRoomSummary(c.env.DB, roomId, userId);
    if (summary) joinedRoom.summary = summary;

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

    // MSC4155/MSC4380: an 'ignore' decision accepts the invite but withholds
    // it from the recipient's sync; a 'block' decision does the same for
    // invites that predate the toggle (new ones are rejected outright). The
    // inviter is the sender of the invitee's own m.room.member event.
    const inviteEvent = state.find(
      (e) => e.type === 'm.room.member' && e.state_key === userId
    );
    if (
      inviteEvent &&
      (await getInvitePermission(c.env.DB, userId, inviteEvent.sender)) !== 'allow'
    ) {
      continue;
    }

    // Redacted state events serve their pruned content in stripped state.
    const prunedContent = await getPrunedContentMap(c.env.DB, roomId);

    // Strip state for invited rooms
    let strippedState = state.map(event => ({
      type: event.type,
      state_key: event.state_key!,
      content: prunedContent.get(event.event_id) ?? event.content,
      sender: event.sender,
    }));

    // Apply state filter to invited room state
    strippedState = applyEventFilter(strippedState, withEventFormat(filter, filter?.room?.state));

    const invitedRoom: InvitedRoom = {
      invite_state: {
        events: strippedState,
      },
    };

    response.rooms!.invite![roomId] = invitedRoom;
  }

  // Get knocked rooms: rooms where this user's knock is still pending. A
  // retracted knock is a 'leave' membership, so it drops out here (and may
  // surface in rooms.leave instead).
  const knockedRoomIds = await getUserRooms(c.env.DB, userId, 'knock');
  for (const roomId of knockedRoomIds) {
    if (!shouldIncludeRoom(roomId, filter?.room)) {
      continue;
    }

    const state = await getRoomState(c.env.DB, roomId);
    const prunedContent = await getPrunedContentMap(c.env.DB, roomId);

    let strippedState: StrippedStateEvent[] = state
      .filter(event =>
        KNOCK_STRIPPED_STATE_TYPES.includes(event.type) ||
        (event.type === 'm.room.member' && event.state_key === userId)
      )
      .map(event => ({
        type: event.type,
        state_key: event.state_key!,
        content: prunedContent.get(event.event_id) ?? event.content,
        sender: event.sender,
      }));

    strippedState = applyEventFilter(strippedState, withEventFormat(filter, filter?.room?.state));

    const knockedRoom: KnockedRoom = {
      knock_state: {
        events: strippedState,
      },
    };

    response.rooms!.knock![roomId] = knockedRoom;
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

  // Presence: initial sync gets current state; incremental syncs get only
  // rows stamped after the presence cursor in `since`. A token without _pr
  // (pre-030) defaults to 0, so backfilled rows are not replayed as deltas.
  const presenceEvents = await getPresenceEventsForSync(
    c.env.DB,
    userId,
    Object.keys(response.rooms!.join!),
    hasSinceToken ? sincePresence ?? 0 : undefined
  );
  response.presence!.events = applyEventFilter(
    presenceEvents,
    withEventFormat(filter, filter?.presence)
  );

  // Check if there are any changes to return
  const hasRoomChanges = Object.keys(response.rooms!.join!).some(roomId => {
    const room = response.rooms!.join![roomId];
    return room.timeline!.events.length > 0
      || (room.state?.events.length ?? 0) > 0
      || (room.timeline?.state_after?.events.length ?? 0) > 0;
  });
  const hasInvites = Object.keys(response.rooms!.invite!).length > 0;
  const hasKnocks = Object.keys(response.rooms!.knock!).length > 0;
  const hasLeaves = Object.keys(response.rooms!.leave!).length > 0;
  const hasToDevice = response.to_device!.events.length > 0;
  const hasAccountData = response.account_data!.events.length > 0;
  const hasPresence = response.presence!.events.length > 0;
  const hasSticky = Object.values(stickyByRoom).some(events => events.length > 0);
  const hasChanges =
    hasRoomChanges || hasInvites || hasKnocks || hasLeaves || hasToDevice || hasAccountData ||
    hasPresence || hasSticky;

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
      'roomChanges:', hasRoomChanges, 'invites:', hasInvites, 'knocks:', hasKnocks,
      'leaves:', hasLeaves, 'toDevice:', hasToDevice, 'accountData:', hasAccountData);
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
      currentDeviceKeysPos,
      currentPresencePos
    );
  }

  return c.json(response);
});

export default app;
