// Legacy sync endpoints (deprecated but still part of Matrix v1.17).
// https://spec.matrix.org/v1.17/client-server-api/#get_matrixclientv3initialsync
// https://spec.matrix.org/v1.17/client-server-api/#get_matrixclientv3events
// https://spec.matrix.org/v1.17/client-server-api/#get_matrixclientv3eventseventid
// https://spec.matrix.org/v1.17/client-server-api/#get_matrixclientv3roomsroomidinitialsync
//
// These predate /sync and use plain stream-position tokens. They are served
// from the same events table, so tokens interoperate with parseSyncToken's
// legacy numeric format.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import {
  getRoomState,
  getMembership,
  getLatestStreamPosition,
  getEventsByIds,
} from '../services/database';
import { getGlobalAccountData, getRoomAccountData } from './account-data';
import { parseSyncToken } from './sync';

const app = new Hono<AppEnv>();

interface ClientEvent {
  type: string;
  content: unknown;
  sender: string;
  origin_server_ts: number;
  event_id: string;
  room_id: string;
  state_key?: string;
  unsigned?: unknown;
}

interface StoredEventRow {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  redacted_content?: string | null;
  origin_server_ts: number;
  unsigned: string | null;
  stream_ordering: number;
}

function toClientEvent(row: StoredEventRow): ClientEvent {
  const event: ClientEvent = {
    type: row.event_type,
    // Redacted events serve their pruned content (stored when the
    // redaction landed); the original stays in `content` for federation.
    content: JSON.parse(row.redacted_content ?? row.content),
    sender: row.sender,
    origin_server_ts: row.origin_server_ts,
    event_id: row.event_id,
    room_id: row.room_id,
  };
  if (row.state_key !== null) event.state_key = row.state_key;
  if (row.unsigned) event.unsigned = JSON.parse(row.unsigned);
  return event;
}

// getRoomState returns the raw `content` column (redaction prunes into a
// separate column), so load the pruned bodies for the room's state events.
// Both invite stripped state and joined state use the same client-facing
// content rule as sliding sync: redacted_content when present, else content.
async function getStateRedactedContent(
  db: D1Database,
  roomId: string
): Promise<Map<string, string>> {
  const result = await db.prepare(
    `SELECT e.event_id, e.redacted_content FROM room_state rs
     JOIN events e ON rs.event_id = e.event_id
     WHERE rs.room_id = ? AND e.redacted_content IS NOT NULL`
  ).bind(roomId).all<{ event_id: string; redacted_content: string | null }>();
  const pruned = new Map<string, string>();
  for (const row of result.results) {
    if (row.redacted_content) pruned.set(row.event_id, row.redacted_content);
  }
  return pruned;
}

function stateContent(content: unknown, redactedContent?: string | null): unknown {
  if (redactedContent) {
    try {
      return JSON.parse(redactedContent);
    } catch {
      // Ignore malformed pruned content and fall back to the raw content.
    }
  }
  return content;
}

const EVENT_COLUMNS =
  'event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, redacted_content, stream_ordering';

// Newest-first page of a room's timeline (legacy /messages direction 'b').
async function getRoomTimeline(
  db: D1Database,
  roomId: string,
  limit: number
): Promise<{ chunk: ClientEvent[]; start: string; end: string }> {
  const rows = await db.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE room_id = ? AND stream_ordering > 0 ORDER BY stream_ordering DESC LIMIT ?`
  ).bind(roomId, limit).all<StoredEventRow>();

  const chunk = rows.results.map(toClientEvent);
  const start = rows.results[0]?.stream_ordering ?? 0;
  const end = rows.results[rows.results.length - 1]?.stream_ordering ?? start;
  return { chunk, start: String(start), end: String(end) };
}

async function isWorldReadable(db: D1Database, roomId: string): Promise<boolean> {
  const state = await getRoomState(db, roomId);
  const visibility = state.find(e => e.type === 'm.room.history_visibility');
  return (visibility?.content as { history_visibility?: string } | undefined)
    ?.history_visibility === 'world_readable';
}

interface RoomInfo {
  room_id: string;
  membership: string;
  state?: ClientEvent[];
  messages?: { chunk: ClientEvent[]; start: string; end: string };
  visibility?: 'public' | 'private';
  account_data?: { type: string; content: unknown }[];
  invite?: { invite_state: { events: ClientEvent[] } };
}

async function buildRoomInfo(
  db: D1Database,
  userId: string,
  roomId: string,
  membership: string,
  messageLimit: number
): Promise<RoomInfo> {
  const redacted = await getStateRedactedContent(db, roomId);
  const state = (await getRoomState(db, roomId)).map(e => ({
    type: e.type,
    // getRoomState drops redacted_content, so prefer the value fetched above;
    // also honour it when a caller supplies it on the state row itself.
    content: stateContent(
      e.content,
      redacted.get(e.event_id) ?? (e as typeof e & { redacted_content?: string | null }).redacted_content
    ),
    sender: e.sender,
    origin_server_ts: e.origin_server_ts,
    event_id: e.event_id,
    room_id: e.room_id,
    ...(e.state_key !== undefined ? { state_key: e.state_key } : {}),
  }));

  if (membership === 'invite') {
    return {
      room_id: roomId,
      membership,
      invite: { invite_state: { events: state } },
    };
  }

  const room = await db.prepare(
    `SELECT is_public FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ is_public: number }>();

  const messages = await getRoomTimeline(db, roomId, messageLimit);
  const accountData = await getRoomAccountData(db, userId, roomId);

  return {
    room_id: roomId,
    membership,
    state,
    messages,
    visibility: room?.is_public === 1 ? 'public' : 'private',
    account_data: accountData,
  };
}

// GET /_matrix/client/v3/initialSync
app.get('/_matrix/client/v3/initialSync', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const limitParam = parseInt(c.req.query('limit') || '10', 10);
  const messageLimit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, 100)
    : 10;
  const archived = c.req.query('archived') === 'true';

  const memberships = await db.prepare(
    `SELECT room_id, membership FROM room_memberships WHERE user_id = ?`
  ).bind(userId).all<{ room_id: string; membership: string }>();

  const rooms: RoomInfo[] = [];
  for (const row of memberships.results) {
    if (row.membership === 'leave' || row.membership === 'ban') {
      if (!archived) continue;
    }
    rooms.push(await buildRoomInfo(db, userId, row.room_id, row.membership, messageLimit));
  }

  const end = await getLatestStreamPosition(db);
  const accountData = await getGlobalAccountData(db, userId);

  return c.json({
    end: String(end),
    presence: [],
    account_data: accountData,
    rooms,
  });
});

// GET /_matrix/client/v3/rooms/:roomId/initialSync
app.get('/_matrix/client/v3/rooms/:roomId/initialSync', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  const membership = await getMembership(db, roomId, userId);
  if (!membership) {
    return Errors.forbidden('You are not a member of this room').toResponse();
  }

  const info = await buildRoomInfo(db, userId, roomId, membership.membership, 10);
  return c.json(info);
});

// GET /_matrix/client/v3/events - legacy event stream (optionally room-scoped)
app.get('/_matrix/client/v3/events', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  const fromToken = c.req.query('from');
  const from = parseSyncToken(fromToken).events;
  const timeout = Math.min(Math.max(parseInt(c.req.query('timeout') || '0', 10) || 0, 0), 30000);
  const roomId = c.req.query('room_id');

  let roomIds: string[];
  if (roomId) {
    const membership = await getMembership(db, roomId, userId);
    if (membership?.membership !== 'join' && !(await isWorldReadable(db, roomId))) {
      return Errors.forbidden('You are not a member of this room').toResponse();
    }
    roomIds = [roomId];
  } else {
    const joined = await db.prepare(
      `SELECT room_id FROM room_memberships WHERE user_id = ? AND membership = 'join'`
    ).bind(userId).all<{ room_id: string }>();
    roomIds = joined.results.map(r => r.room_id);
  }

  const queryEvents = async (): Promise<StoredEventRow[]> => {
    if (roomIds.length === 0) return [];
    if (roomIds.length === 1) {
      const rows = await db.prepare(
        `SELECT ${EVENT_COLUMNS} FROM events
         WHERE room_id = ? AND stream_ordering > ?
         ORDER BY stream_ordering ASC LIMIT 100`
      ).bind(roomIds[0], from).all<StoredEventRow>();
      return rows.results;
    }
    const placeholders = roomIds.map(() => '?').join(', ');
    const rows = await db.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE room_id IN (${placeholders}) AND stream_ordering > ?
       ORDER BY stream_ordering ASC LIMIT 100`
    ).bind(...roomIds, from).all<StoredEventRow>();
    return rows.results;
  };

  let rows = await queryEvents();

  // Long-poll like /sync: wait on the Sync DO, then re-read once.
  if (rows.length === 0 && timeout > 0 && c.env.SYNC) {
    const syncDO = c.env.SYNC;
    const stub = syncDO.get(syncDO.idFromName(userId));
    const waitResponse = await stub.fetch(new Request('http://internal/wait-for-events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeout: Math.min(timeout, 25000) }),
    }));
    const waitResult = await waitResponse.json() as { hasEvents?: boolean };
    if (waitResult.hasEvents) {
      rows = await queryEvents();
    }
  }

  const chunk = rows.map(toClientEvent);
  const start = fromToken ?? String(from);
  const end = rows.length > 0
    ? String(rows[rows.length - 1].stream_ordering)
    : start;

  return c.json({ start, end, chunk });
});

// GET /_matrix/client/v3/events/:eventId - legacy single-event fetch
app.get('/_matrix/client/v3/events/:eventId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const db = c.env.DB;

  const events = await getEventsByIds(db, [eventId]);
  const event = events[0];
  if (!event) {
    return Errors.notFound('Event not found').toResponse();
  }

  const membership = await getMembership(db, event.room_id, userId);
  if (membership?.membership !== 'join' && !(await isWorldReadable(db, event.room_id))) {
    // Spec answers 404 for both missing events and inaccessible ones.
    return Errors.notFound('Event not found').toResponse();
  }

  const clientEvent: ClientEvent = {
    type: event.type,
    content: event.content,
    sender: event.sender,
    origin_server_ts: event.origin_server_ts,
    event_id: event.event_id,
    room_id: event.room_id,
  };
  if (event.state_key !== undefined) clientEvent.state_key = event.state_key;
  if (event.unsigned) clientEvent.unsigned = event.unsigned;
  return c.json(clientEvent);
});

export default app;