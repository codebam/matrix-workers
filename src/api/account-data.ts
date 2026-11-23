// Account Data API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#client-config
//
// Account data is arbitrary JSON that clients can store per-user or per-room.
// Common uses:
// - m.direct: Direct message room mappings
// - m.ignored_user_list: Blocked users
// - m.fully_read: Read marker position
// - im.vector.setting.*: Element-specific settings
// - m.secret_storage.*: Secret storage keys
//
// IMPORTANT: E2EE-related account data uses Durable Objects for strong consistency.
// This is critical during initial SSSS setup where client writes and immediately
// reads via sliding sync.

import { Hono } from 'hono';
import type { AppEnv, Env } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUserSync } from '../services/database';

const app = new Hono<AppEnv>();

// Helper to get the UserKeys Durable Object stub for a user
function getUserKeysDO(env: Env, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

// Get E2EE account data from Durable Object (strongly consistent)
export async function getE2EEAccountDataFromDO(env: Env, userId: string, eventType?: string): Promise<any> {
  const stub = getUserKeysDO(env, userId);
  const url = eventType
    ? `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    : 'http://internal/account-data/get';
  const response = await stub.fetch(new Request(url));

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    console.error('[account-data] DO get failed:', response.status, errorText, 'eventType:', eventType);
    throw new Error(`DO get failed: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

// Store E2EE account data in Durable Object (strongly consistent)
async function putE2EEAccountDataToDO(env: Env, userId: string, eventType: string, content: any): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(new Request('http://internal/account-data/put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: eventType, content }),
  }));

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    console.error('[account-data] DO put failed:', response.status, errorText, 'eventType:', eventType);
    throw new Error(`DO put failed: ${response.status} - ${errorText}`);
  }
}

// ============================================
// Helper Functions
// ============================================

async function getNextStreamPosition(db: D1Database, streamName: string): Promise<number> {
  await db.prepare(`
    UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
  `).bind(streamName).run();

  const result = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = ?
  `).bind(streamName).first<{ position: number }>();

  return result?.position || 1;
}

async function recordAccountDataChange(
  db: D1Database,
  userId: string,
  roomId: string,
  eventType: string
): Promise<void> {
  const streamPosition = await getNextStreamPosition(db, 'account_data');

  await db.prepare(`
    INSERT INTO account_data_changes (user_id, room_id, event_type, stream_position)
    VALUES (?, ?, ?, ?)
  `).bind(userId, roomId, eventType, streamPosition).run();
}

// ============================================
// MSC4354 / MSC4480 sticky events
// ============================================

// Sticky events are normal room PDUs with a top-level `sticky.duration_ms`
// (MSC4354). MSC4480 is the sliding-sync extension that delivers them. We
// reuse the existing account_data table under a reserved event-type prefix so
// no new table or migration is needed. Sticky rows are keyed by the sender's
// user_id and the room_id, which makes them room-scoped and visible to every
// joined user, as MSC4354 requires.
export const STICKY_EVENT_TYPE_PREFIX = 'org.matrix.msc4354.sticky.';
const STICKY_EVENT_TYPE_LIKE = `${STICKY_EVENT_TYPE_PREFIX}%`;
const MAX_STICKY_DURATION_MS = 3_600_000;
const DEFAULT_STICKY_LIMIT = 100;

export interface StickyEventRecord {
  event_id: string;
  type: string;
  sender: string;
  room_id: string;
  origin_server_ts: number;
  received_ts: number;
  duration_ms: number;
  content: Record<string, unknown>;
}

export interface StickyClientEvent {
  type: string;
  event_id: string;
  sender: string;
  room_id: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  sticky: { duration_ms: number };
  // Unstable duplicates are emitted for the legacy account-data-backed store
  // only; sticky events stored as real PDUs (spec v1.20) omit them.
  msc4354_sticky?: { duration_ms: number };
  unsigned: {
    sticky_duration_remaining_ms: number;
    msc4354_sticky_duration_ttl_ms?: number;
  };
}

/** True for reserved sticky event_types; callers must hide these from account_data. */
export function isStickyEventType(eventType: string): boolean {
  return eventType.startsWith(STICKY_EVENT_TYPE_PREFIX);
}

/** MSC4354 requires a strictly positive integer sticky_duration_ms. */
export function parseStickyDuration(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed > 0) return parsed;
  }
  return null;
}

function stickyExpiresAt(record: StickyEventRecord): number {
  // MSC4354: start = min(received_ts, origin_server_ts); end is capped at 1h.
  const start = Math.min(record.received_ts, record.origin_server_ts);
  return start + Math.min(record.duration_ms, MAX_STICKY_DURATION_MS);
}

/** Exported for tests. Returns null once the event is no longer sticky. */
export function toStickyClientEvent(
  record: StickyEventRecord,
  now: number = Date.now()
): StickyClientEvent | null {
  const remaining = stickyExpiresAt(record) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return {
    type: record.type,
    event_id: record.event_id,
    sender: record.sender,
    room_id: record.room_id,
    origin_server_ts: record.origin_server_ts,
    content: record.content,
    sticky: { duration_ms: record.duration_ms },
    msc4354_sticky: { duration_ms: record.duration_ms },
    unsigned: {
      sticky_duration_remaining_ms: remaining,
      msc4354_sticky_duration_ttl_ms: remaining,
    },
  };
}

/** Write a sticky event and record it on the account_data stream for /sync. */
export async function putStickyEvent(
  db: D1Database,
  args: {
    userId: string;
    roomId: string;
    eventType: string;
    txnId: string;
    durationMs: number;
    content: Record<string, unknown>;
    eventId?: string;
    originServerTs?: number;
    receivedTs?: number;
  }
): Promise<StickyEventRecord> {
  const now = Date.now();
  const rawId = args.eventId ?? `msc4354_${args.userId}_${args.roomId}_${args.txnId}`;
  const eventId = rawId.startsWith('$') ? rawId : `$${rawId}`;
  const record: StickyEventRecord = {
    event_id: eventId,
    type: args.eventType,
    sender: args.userId,
    room_id: args.roomId,
    origin_server_ts: args.originServerTs ?? now,
    received_ts: args.receivedTs ?? now,
    duration_ms: args.durationMs,
    content: args.content,
  };
  const accountDataType = `${STICKY_EVENT_TYPE_PREFIX}${eventId}`;

  await db.prepare(`
    INSERT INTO account_data (user_id, room_id, event_type, content)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
      content = excluded.content
  `).bind(args.userId, args.roomId, accountDataType, JSON.stringify(record)).run();

  // Reuses the account_data stream: no extra sequence column or migration.
  await recordAccountDataChange(db, args.userId, args.roomId, accountDataType);
  return record;
}

interface StickyRow {
  user_id: string;
  room_id: string;
  event_type: string;
  content: string;
  stream_position?: number;
}

function decodeStickyRow(row: StickyRow): StickyEventRecord | null {
  try {
    const parsed = JSON.parse(row.content) as StickyEventRecord;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.duration_ms !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Unexpired sticky events for the given rooms, oldest first, capped per room.
 * `since` is an account_data stream position; changes recorded by
 * putStickyEvent are delivered exactly once as the token advances.
 */
export async function getStickyEventsForRooms(
  db: D1Database,
  roomIds: string[],
  opts: { since?: number; limit?: number; now?: number } = {}
): Promise<Record<string, StickyClientEvent[]>> {
  const byRoom: Record<string, StickyClientEvent[]> = {};
  if (roomIds.length === 0) return byRoom;

  const now = opts.now ?? Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_STICKY_LIMIT, DEFAULT_STICKY_LIMIT));
  const rows: StickyRow[] = [];

  // Stay below D1's bind-variable limit (see the presence query in sync.ts).
  for (let i = 0; i < roomIds.length; i += 90) {
    const chunk = roomIds.slice(i, i + 90);
    const placeholders = chunk.map(() => '?').join(',');
    if (opts.since !== undefined) {
      const result = await db.prepare(`
        SELECT ad.user_id, ad.room_id, ad.event_type, ad.content,
               MAX(adc.stream_position) AS stream_position
        FROM account_data ad
        INNER JOIN account_data_changes adc ON
          ad.user_id = adc.user_id AND ad.room_id = adc.room_id AND ad.event_type = adc.event_type
        WHERE ad.room_id IN (${placeholders}) AND ad.event_type LIKE ?
        GROUP BY ad.user_id, ad.room_id, ad.event_type, ad.content
        HAVING MAX(adc.stream_position) > ?
      `).bind(...chunk, STICKY_EVENT_TYPE_LIKE, opts.since).all<StickyRow>();
      rows.push(...result.results);
    } else {
      const result = await db.prepare(`
        SELECT user_id, room_id, event_type, content FROM account_data
        WHERE room_id IN (${placeholders}) AND event_type LIKE ?
      `).bind(...chunk, STICKY_EVENT_TYPE_LIKE).all<StickyRow>();
      rows.push(...result.results);
    }
  }

  rows.sort((a, b) => {
    const ra = decodeStickyRow(a);
    const rb = decodeStickyRow(b);
    return (ra?.received_ts ?? 0) - (rb?.received_ts ?? 0) || a.event_type.localeCompare(b.event_type);
  });

  for (const row of rows) {
    const record = decodeStickyRow(row);
    if (!record) continue;
    const event = toStickyClientEvent(record, now);
    if (!event) continue;
    const roomId = row.room_id;
    if (!byRoom[roomId]) byRoom[roomId] = [];
    if (byRoom[roomId].length >= limit) continue;
    if (byRoom[roomId].some(existing => existing.event_id === event.event_id)) continue;
    byRoom[roomId].push(event);
  }
  return byRoom;
}


/**
 * Spec v1.20 (MSC4354): unexpired sticky events that exist as real room PDUs.
 *
 * These live in the timeline like any other message event; this helper exists
 * so `/sync` can also surface the ones that fall outside the timeline window
 * (history visibility MUST NOT be applied to unexpired sticky events, so the
 * query is deliberately unfiltered).
 */
export async function getStickyPduEventsForRooms(
  db: D1Database,
  roomIds: string[],
  opts: { now?: number; limitPerRoom?: number } = {}
): Promise<Record<string, StickyClientEvent[]>> {
  const byRoom: Record<string, StickyClientEvent[]> = {};
  if (roomIds.length === 0) return byRoom;

  const now = opts.now ?? Date.now();
  const perRoom = Math.max(1, Math.min(opts.limitPerRoom ?? DEFAULT_STICKY_LIMIT, DEFAULT_STICKY_LIMIT));

  // Stay below D1's bind-variable limit.
  for (let i = 0; i < roomIds.length; i += 90) {
    const chunk = roomIds.slice(i, i + 90);
    const placeholders = chunk.map(() => '?').join(',');
    let rows: Array<{
      event_id: string;
      room_id: string;
      sender: string;
      event_type: string;
      content: string;
      origin_server_ts: number;
      received_ts: number | null;
      sticky: string;
    }>;
    try {
      const result = await db.prepare(`
        SELECT event_id, room_id, sender, event_type, content,
               origin_server_ts, received_ts, sticky, stream_ordering
        FROM events
        WHERE room_id IN (${placeholders})
          AND sticky IS NOT NULL AND sticky != ''
          AND stream_ordering > 0
        ORDER BY stream_ordering DESC
        LIMIT ?
      `).bind(...chunk, perRoom * chunk.length).all<{
        event_id: string;
        room_id: string;
        sender: string;
        event_type: string;
        content: string;
        origin_server_ts: number;
        received_ts: number | null;
        sticky: string;
      }>();
      rows = result.results ?? [];
    } catch (error) {
      console.warn('[sticky] PDU sticky lookup failed:', error);
      continue;
    }

    for (const row of rows) {
      let sticky: { duration_ms?: unknown };
      try {
        sticky = JSON.parse(row.sticky) as { duration_ms?: unknown };
      } catch {
        continue;
      }
      if (!sticky || typeof sticky.duration_ms !== 'number') continue;

      const durationMs = Math.min(
        Math.max(sticky.duration_ms, 0),
        MAX_STICKY_DURATION_MS
      );
      if (durationMs <= 0) continue;
      const start = Math.min(row.received_ts ?? row.origin_server_ts, row.origin_server_ts);
      const remaining = start + durationMs - now;
      if (remaining <= 0) continue;

      const list = (byRoom[row.room_id] ??= []);
      if (list.length >= perRoom) continue;
      list.push({
        type: row.event_type,
        event_id: row.event_id,
        sender: row.sender,
        room_id: row.room_id,
        origin_server_ts: row.origin_server_ts,
        content: JSON.parse(row.content) as Record<string, unknown>,
        sticky: { duration_ms: sticky.duration_ms },
        unsigned: { sticky_duration_remaining_ms: remaining },
      });
    }
  }

  return byRoom;
}

export async function getStickyEventsForRoom(
  db: D1Database,
  roomId: string,
  opts: { now?: number } = {}
): Promise<StickyClientEvent[]> {
  const byRoom = await getStickyEventsForRooms(db, [roomId], opts);
  return byRoom[roomId] ?? [];
}

// ============================================
// Global Account Data
// ============================================

// Helper to check if event type should use KV for faster access
function isKVAccountData(eventType: string): boolean {
  return eventType.startsWith('m.secret_storage') ||
         eventType.startsWith('m.cross_signing') ||
         eventType === 'm.megolm_backup.v1';
}

// GET /_matrix/client/v3/user/:userId/account_data/:type
app.get('/_matrix/client/v3/user/:userId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only access their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    }, 403);
  }

  // For E2EE types, read from Durable Object (strongly consistent)
  if (isKVAccountData(eventType)) {
    // Try DO first (strongly consistent)
    try {
      const doData = await getE2EEAccountDataFromDO(c.env, targetUserId, eventType);
      if (doData !== null && doData !== undefined) {
        console.log('[account_data] Retrieved from DO:', eventType);
        return c.json(doData);
      }
    } catch (error) {
      console.error('[account_data] DO unavailable, trying fallbacks:', error);
    }

    // Fallback 1: KV (backup storage)
    try {
      const kvData = await c.env.ACCOUNT_DATA.get(`global:${targetUserId}:${eventType}`);
      if (kvData) {
        console.log('[account_data] Retrieved from KV:', eventType);
        return c.json(JSON.parse(kvData));
      }
    } catch (err) {
      console.error('[account_data] KV fallback failed:', err);
    }
  }

  // Fallback 2: D1
  const data = await db.prepare(`
    SELECT content FROM account_data
    WHERE user_id = ? AND event_type = ? AND room_id = ''
  `).bind(targetUserId, eventType).first<{ content: string }>();

  if (!data) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    }, 404);
  }

  try {
    return c.json(JSON.parse(data.content));
  } catch {
    return c.json({});
  }
});

// PUT /_matrix/client/v3/user/:userId/account_data/:type
app.put('/_matrix/client/v3/user/:userId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only modify their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    }, 403);
  }

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Debug logging for ALL account_data PUT requests
  const contentStr = JSON.stringify(content);
  console.log('[account_data] PUT', eventType, 'for user:', targetUserId, 'content length:', contentStr.length);

  // Extra detailed logging for secret storage related events
  if (eventType.startsWith('m.secret_storage') || eventType.startsWith('m.cross_signing') || eventType.startsWith('m.megolm')) {
    console.log('[account_data] E2EE content:', contentStr);
  }

  // Log SSSS content for debugging but ALWAYS store it
  // Per Matrix spec MSC-1946, m.secret_storage.default_key SHOULD have a "key" property
  // but the server should NOT validate/reject - that causes client-side issues where
  // Element X thinks SSSS setup failed when it actually just got silently rejected
  if (eventType === 'm.secret_storage.default_key') {
    if (!content || typeof content !== 'object' || !content.key || typeof content.key !== 'string') {
      console.warn('[account_data] WARNING: m.secret_storage.default_key has unusual content:', contentStr);
      // Still store it - the client may be doing partial setup or recovery
    } else {
      console.log('[account_data] Valid m.secret_storage.default_key with key:', content.key);
    }
  }

  // Log m.secret_storage.key.* but ALWAYS store it
  if (eventType.startsWith('m.secret_storage.key.')) {
    if (!content || typeof content !== 'object' || !content.algorithm || typeof content.algorithm !== 'string') {
      console.warn('[account_data] WARNING:', eventType, 'has unusual content:', contentStr);
      // Still store it - the client may be doing partial setup
    } else {
      console.log('[account_data] Valid', eventType, 'with algorithm:', content.algorithm);
    }
  }

  // For E2EE types, write to Durable Object FIRST (strongly consistent)
  // This is critical for SSSS setup where client writes then immediately reads via sync
  if (isKVAccountData(eventType)) {
    try {
      await putE2EEAccountDataToDO(c.env, targetUserId, eventType, content);
      console.log('[account_data] Stored in Durable Object:', eventType);
    } catch (error) {
      console.error('[account_data] Failed to store in DO:', error);
      return c.json({
        errcode: 'M_UNKNOWN',
        error: 'Failed to store E2EE data',
      }, 503);
    }

    // Also write to KV as backup/cache
    await c.env.ACCOUNT_DATA.put(
      `global:${targetUserId}:${eventType}`,
      JSON.stringify(content)
    );
  }

  // Also store in D1 as backup
  await db.prepare(`
    INSERT INTO account_data (user_id, room_id, event_type, content)
    VALUES (?, '', ?, ?)
    ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
      content = excluded.content
  `).bind(targetUserId, eventType, JSON.stringify(content)).run();

  // Record change for sync
  await recordAccountDataChange(db, targetUserId, '', eventType);

  // Wake this user's in-flight /sync long-poll so the write is echoed back
  // promptly. js-sdk's `setAccountData` only resolves once its write comes
  // back over sync; without this the caller waits for the long-poll timeout.
  // (Correctness does not depend on the wake: the next_batch snapshot fix in
  // sync.ts guarantees the change is delivered on the next sync either way.)
  // Best-effort like notifyUsersOfEvent — it never fails the write.
  await notifyUserSync(c.env, targetUserId, 'account_data');

  return c.json({});
});

// ============================================
// Room Account Data
// ============================================

// GET /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.get('/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only access their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot access other users account data',
    }, 403);
  }

  // Verify user is in the room
  const membership = await db.prepare(`
    SELECT membership FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, targetUserId).first<{ membership: string }>();

  if (!membership || membership.membership !== 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User not in room',
    }, 403);
  }

  const data = await db.prepare(`
    SELECT content FROM account_data
    WHERE user_id = ? AND room_id = ? AND event_type = ?
  `).bind(targetUserId, roomId, eventType).first<{ content: string }>();

  if (!data) {
    return c.json({
      errcode: 'M_NOT_FOUND',
      error: 'Account data not found',
    }, 404);
  }

  try {
    return c.json(JSON.parse(data.content));
  } catch {
    return c.json({});
  }
});

// PUT /_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type
app.put('/_matrix/client/v3/user/:userId/rooms/:roomId/account_data/:type', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const eventType = decodeURIComponent(c.req.param('type'));
  const db = c.env.DB;

  // Users can only modify their own account data
  if (requestingUserId !== targetUserId) {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'Cannot modify other users account data',
    }, 403);
  }

  // Verify user is in the room
  const membership = await db.prepare(`
    SELECT membership FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, targetUserId).first<{ membership: string }>();

  if (!membership || membership.membership !== 'join') {
    return c.json({
      errcode: 'M_FORBIDDEN',
      error: 'User not in room',
    }, 403);
  }

  let content: any;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Store account data
  await db.prepare(`
    INSERT INTO account_data (user_id, room_id, event_type, content)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
      content = excluded.content
  `).bind(targetUserId, roomId, eventType, JSON.stringify(content)).run();

  // Record change for sync
  await recordAccountDataChange(db, targetUserId, roomId, eventType);

  return c.json({});
});

// ============================================
// MSC4354 / MSC4480 sticky event endpoints
// ============================================

async function requireJoinedRoom(
  db: D1Database,
  roomId: string,
  userId: string
): Promise<boolean> {
  const membership = await db.prepare(`
    SELECT membership FROM room_memberships
    WHERE room_id = ? AND user_id = ?
  `).bind(roomId, userId).first<{ membership: string }>();
  return membership?.membership === 'join';
}

async function handlePutStickyEvent(c: any): Promise<Response> {
  const userId = c.get('userId') as string;
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const eventType = decodeURIComponent(c.req.param('eventType'));
  const txnId = decodeURIComponent(c.req.param('txnId'));
  const db = c.env.DB as D1Database;

  if (!eventType || !(await requireJoinedRoom(db, roomId, userId))) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'User not in room' }, 403);
  }

  // MSC4354's unstable query parameter, with the stable name accepted too.
  const durationMs = parseStickyDuration(
    c.req.query('org.matrix.msc4354.sticky_duration_ms') ?? c.req.query('sticky_duration_ms')
  );
  if (durationMs === null) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'sticky_duration_ms must be a strictly positive integer',
    }, 400);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Errors.badJson().toResponse();
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Errors.badJson().toResponse();
  }

  const content = (body.content && typeof body.content === 'object' && !Array.isArray(body.content))
    ? body.content as Record<string, unknown>
    : body;
  const eventId = typeof body.event_id === 'string' ? body.event_id : undefined;
  const originServerTs = typeof body.origin_server_ts === 'number'
    ? body.origin_server_ts
    : Date.now();

  await putStickyEvent(db, {
    userId,
    roomId,
    eventType,
    txnId,
    durationMs,
    content,
    eventId,
    originServerTs,
  });

  // Best-effort wake of this user's long-poll so the write is echoed promptly.
  try {
    await notifyUserSync(c.env, userId, 'account_data');
  } catch (error) {
    console.error('[account-data] sticky notify failed:', error);
  }

  return c.json({});
}

async function handleGetStickyEvents(c: any): Promise<Response> {
  const userId = c.get('userId') as string;
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB as D1Database;

  if (!(await requireJoinedRoom(db, roomId, userId))) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'User not in room' }, 403);
  }

  const events = await getStickyEventsForRoom(db, roomId);
  return c.json({ events });
}

// MSC4354 owns the sticky-event identifiers; MSC4480 is the sliding-sync
// extension, so both unstable namespaces are accepted for the client endpoint.
for (const prefix of ['org.matrix.msc4354', 'org.matrix.msc4480']) {
  app.put(
    `/_matrix/client/unstable/${prefix}/rooms/:roomId/sticky/:eventType/:txnId`,
    requireAuth(),
    handlePutStickyEvent
  );
  app.get(
    `/_matrix/client/unstable/${prefix}/rooms/:roomId/sticky`,
    requireAuth(),
    handleGetStickyEvents
  );
}

// ============================================
// Batch Account Data (for sync)
// ============================================

export async function getGlobalAccountData(
  db: D1Database,
  userId: string,
  since?: number
): Promise<{ type: string; content: any }[]> {
  let query: string;
  const params: any[] = [userId];

  if (since !== undefined) {
    // Get only changed account data since the given position
    query = `
      SELECT ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id = '' AND adc.stream_position > ?
        AND ad.event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
      GROUP BY ad.event_type
    `;
    params.push(since);
  } else {
    // Get all account data
    query = `
      SELECT event_type, content FROM account_data
      WHERE user_id = ? AND room_id = ''
        AND event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    event_type: string;
    content: string;
  }>();

  return results.results.map(row => ({
    type: row.event_type,
    content: JSON.parse(row.content || '{}'),
  }));
}

export async function getRoomAccountData(
  db: D1Database,
  userId: string,
  roomId: string,
  since?: number
): Promise<{ type: string; content: any }[]> {
  let query: string;
  const params: any[] = [userId, roomId];

  if (since !== undefined) {
    query = `
      SELECT ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id = ? AND adc.stream_position > ?
        AND ad.event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
      GROUP BY ad.event_type
    `;
    params.push(since);
  } else {
    query = `
      SELECT event_type, content FROM account_data
      WHERE user_id = ? AND room_id = ?
        AND event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    event_type: string;
    content: string;
  }>();

  return results.results.map(row => ({
    type: row.event_type,
    content: JSON.parse(row.content || '{}'),
  }));
}

export async function getAllRoomAccountData(
  db: D1Database,
  userId: string,
  roomIds: string[],
  since?: number
): Promise<Record<string, { type: string; content: any }[]>> {
  if (roomIds.length === 0) return {};

  const placeholders = roomIds.map(() => '?').join(',');
  const params: any[] = [userId, ...roomIds];

  let query: string;

  if (since !== undefined) {
    query = `
      SELECT ad.room_id, ad.event_type, ad.content
      FROM account_data ad
      INNER JOIN account_data_changes adc ON
        ad.user_id = adc.user_id AND
        ad.event_type = adc.event_type AND
        ad.room_id = adc.room_id
      WHERE ad.user_id = ? AND ad.room_id IN (${placeholders}) AND adc.stream_position > ?
        AND ad.event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
      GROUP BY ad.room_id, ad.event_type
    `;
    params.push(since);
  } else {
    query = `
      SELECT room_id, event_type, content FROM account_data
      WHERE user_id = ? AND room_id IN (${placeholders})
        AND event_type NOT LIKE 'org.matrix.msc4354.sticky.%'
    `;
  }

  const results = await db.prepare(query).bind(...params).all<{
    room_id: string;
    event_type: string;
    content: string;
  }>();

  const byRoom: Record<string, { type: string; content: any }[]> = {};

  for (const row of results.results) {
    if (!byRoom[row.room_id]) {
      byRoom[row.room_id] = [];
    }
    byRoom[row.room_id].push({
      type: row.event_type,
      content: JSON.parse(row.content || '{}'),
    });
  }

  return byRoom;
}

// ============================================
// Get current stream position
// ============================================

export async function getAccountDataStreamPosition(db: D1Database): Promise<number> {
  const result = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = 'account_data'
  `).first<{ position: number }>();

  return result?.position || 0;
}

export default app;
