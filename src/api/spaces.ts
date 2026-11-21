// Spaces API
// Implements: https://spec.matrix.org/v1.12/client-server-api/#spaces
//
// Spaces are a way to organize rooms into hierarchical groups

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';

const app = new Hono<AppEnv>();

// ============================================
// Types
// ============================================

interface SpaceChild {
  room_id: string;
  room_type?: string;
  name?: string;
  topic?: string;
  canonical_alias?: string;
  num_joined_members: number;
  avatar_url?: string;
  join_rule?: string;
  world_readable: boolean;
  guest_can_join: boolean;
  children_state: any[];
}

// ============================================
// Endpoints
// ============================================

// GET /_matrix/client/v1/rooms/:roomId/hierarchy - Get space hierarchy
app.get('/_matrix/client/v1/rooms/:roomId/hierarchy', requireAuth(), async (c) => {
  // Note: userId could be used for permission checks in future
  void c.get('userId');
  const roomId = c.req.param('roomId');
  const db = c.env.DB;

  // Check if room exists
  const room = await db.prepare(`
    SELECT room_id FROM rooms WHERE room_id = ?
  `).bind(roomId).first();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get pagination params. next_batch is a room_id: resume strictly after
  // that room in the same (state_key) order. Unrecognized tokens keep the
  // first-page behaviour.
  const from = c.req.query('from');
  const resumeAfter = from?.startsWith('!') ? from : undefined;
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const maxDepth = parseInt(c.req.query('max_depth') || '1');
  const suggestedOnly = c.req.query('suggested_only') === 'true';

  // Get space children from m.space.child state events. ORDER BY makes the
  // room_id cursor stable between pages.
  const childEvents = await db.prepare(`
    SELECT rs.state_key, e.content
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.space.child'
    ORDER BY rs.state_key ASC
  `).bind(roomId).all<{ state_key: string; content: string }>();

  let spaceRoom: SpaceChild | undefined;

  // Add the space itself only on the first page, so walking next_batch never
  // emits it twice. When the token is the space itself, start at child 1.
  if (!resumeAfter) {
    const spaceInfo = await getRoomInfo(db, roomId, c.env.SERVER_NAME);
    if (spaceInfo) {
      spaceRoom = {
        ...spaceInfo,
        children_state: childEvents.results.map(ce => ({
          type: 'm.space.child',
          state_key: ce.state_key,
          content: JSON.parse(ce.content),
          sender: '', // Would need to fetch from event
          origin_server_ts: 0,
        })),
      };
    }
  }
  const afterRoomId = resumeAfter === roomId ? undefined : resumeAfter;

  const childRooms: SpaceChild[] = [];

  // Process each child
  for (const child of childEvents.results) {
    const childRoomId = child.state_key;
    if (afterRoomId && childRoomId <= afterRoomId) continue;

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
      const childInfo = await getRoomInfo(db, childRoomId, c.env.SERVER_NAME);
      if (childInfo) {
        // Get grandchildren if within depth
        let childrenState: any[] = [];
        if (maxDepth > 1) {
          const grandchildEvents = await db.prepare(`
            SELECT rs.state_key, e.content
            FROM room_state rs
            JOIN events e ON rs.event_id = e.event_id
            WHERE rs.room_id = ? AND rs.event_type = 'm.space.child'
          `).bind(childRoomId).all<{ state_key: string; content: string }>();

          childrenState = grandchildEvents.results.map(gce => ({
            type: 'm.space.child',
            state_key: gce.state_key,
            content: JSON.parse(gce.content),
          }));
        }

        childRooms.push({
          ...childInfo,
          children_state: childrenState,
        });
      }
    } catch {
      // Skip invalid child entries
    }
  }

  // Paginate the filtered child list (skipped/deleted children never become
  // visible gaps in the cursor), after the space itself on the first page.
  // A non-numeric limit stays the legacy empty-page behaviour (slice(0, NaN)).
  const childBudget = Number.isNaN(limit) ? 0 : Math.max(0, limit - (spaceRoom ? 1 : 0));
  const pageChildren = childRooms.slice(0, childBudget);
  const rooms = Number.isNaN(limit) ? [] : [...(spaceRoom ? [spaceRoom] : []), ...pageChildren];
  const hasMore = !Number.isNaN(limit) && childRooms.length > pageChildren.length;
  // Keep the legacy index for non-positive limits (invalid input still 500s).
  const nextBatchIndex = limit > 0 ? Math.min(limit, rooms.length) - 1 : limit - 1;

  return c.json({
    rooms,
    next_batch: hasMore || rooms.length > limit ? rooms[nextBatchIndex].room_id : undefined,
  });
});

// Helper function to get room info (exported for unit tests)
export async function getRoomInfo(
  db: D1Database,
  roomId: string,
  _serverName: string
): Promise<SpaceChild | null> {
  // Get room
  const room = await db.prepare(`
    SELECT room_id, is_public FROM rooms WHERE room_id = ?
  `).bind(roomId).first<{ room_id: string; is_public: number }>();

  if (!room) {
    return null;
  }

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

  // Get room type (for spaces)
  const createEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'
  `).bind(roomId).first<{ content: string }>();

  // Get member count
  const memberCount = await db.prepare(`
    SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'
  `).bind(roomId).first<{ count: number }>();

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
      const content = JSON.parse(historyEvent.content);
      historyVisibility = content.history_visibility;
    } catch {}
  }

  let guestAccess = 'forbidden';
  if (guestEvent) {
    try {
      const content = JSON.parse(guestEvent.content);
      guestAccess = content.guest_access;
    } catch {}
  }

  return {
    room_id: roomId,
    room_type: roomType,
    name: nameEvent ? JSON.parse(nameEvent.content).name : undefined,
    topic: topicEvent ? JSON.parse(topicEvent.content).topic : undefined,
    canonical_alias: aliasEvent ? JSON.parse(aliasEvent.content).alias : undefined,
    num_joined_members: memberCount?.count || 0,
    avatar_url: avatarEvent ? JSON.parse(avatarEvent.content).url : undefined,
    join_rule: joinRuleEvent ? JSON.parse(joinRuleEvent.content).join_rule : 'invite',
    world_readable: historyVisibility === 'world_readable',
    guest_can_join: guestAccess === 'can_join',
    children_state: [],
  };
}

export default app;
