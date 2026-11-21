// Admin API endpoints

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { getUserById, createRegistrationToken, listRegistrationTokens, revokeRegistrationToken, storeEventIdempotent, updateMembership, getRoom } from '../services/database';
import { invalidatePolicyRulesCache } from '../services/moderation-policy';
import { generateLoginToken, generateOpaqueId, generateRegistrationToken } from '../utils/ids';
import { base64UrlDecode, hashToken, verifySignature } from '../utils/crypto';
import { inboundWireEventIdCandidates } from '../utils/event-signing';
import { federationGet } from '../services/federation-keys';
import { encryptSecret } from './oidc-auth';
import { fetchOIDCDiscovery } from '../services/oidc';
import { logAdminAction } from '../services/admin-audit';
import federation from './federation';
import versions from './versions';

const app = new Hono<AppEnv>();

// Admin authentication middleware
const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get('userId');
  if (!userId) {
    return Errors.unauthorized('Admin access required').toResponse();
  }

  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.admin) {
    return Errors.forbidden('Admin privileges required').toResponse();
  }

  return next();
});

// Helper to get AdminDurableObject instance
function getAdminDO(env: import('../types').Env) {
  const id = env.ADMIN.idFromName('global');
  return env.ADMIN.get(id);
}

// Invalidate stats cache after data-modifying operations
async function invalidateStatsCache(env: import('../types').Env) {
  const adminDO = getAdminDO(env);
  await adminDO.fetch('http://internal/invalidate-cache');
}

// GET /admin/api/stats - Server statistics (via AdminDurableObject for caching)
app.get('/admin/api/stats', requireAuth(), requireAdmin, async (c) => {
  const refresh = c.req.query('refresh') === 'true';
  const adminDO = getAdminDO(c.env);

  const url = new URL('/stats', 'http://internal');
  if (refresh) {
    url.searchParams.set('refresh', 'true');
  }

  const response = await adminDO.fetch(url.toString());
  const stats = await response.json() as Record<string, unknown>;

  // Add server info
  return c.json({
    ...stats,
    server: {
      name: c.env.SERVER_NAME,
      version: c.env.SERVER_VERSION,
    },
  });
});

// GET /admin/api/stats/history - Time-series statistics for dashboard charts
app.get('/admin/api/stats/history', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const period = c.req.query('period') || '7d';

  // Parse period and calculate date range
  let days: number;
  if (period === '30d') {
    days = 30;
  } else {
    days = 7; // Default to 7d
  }

  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;

  // Generate array of dates for the period (to fill in gaps with zeros)
  const dateKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000);
    dateKeys.push(date.toISOString().split('T')[0]); // YYYY-MM-DD format
  }

  // Query events grouped by day
  // D1/SQLite: divide by 86400000 (ms per day) to get day buckets
  const eventsQuery = await db.prepare(`
    SELECT DATE(origin_server_ts / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM events
    WHERE origin_server_ts >= ?
    GROUP BY DATE(origin_server_ts / 1000, 'unixepoch')
    ORDER BY date
  `).bind(startTime).all<{ date: string; count: number }>();

  // Query user registrations grouped by day
  const registrationsQuery = await db.prepare(`
    SELECT DATE(created_at / 1000, 'unixepoch') as date, COUNT(*) as count
    FROM users
    WHERE created_at >= ?
    GROUP BY DATE(created_at / 1000, 'unixepoch')
    ORDER BY date
  `).bind(startTime).all<{ date: string; count: number }>();

  // Convert query results to maps for easy lookup
  const eventsMap = new Map<string, number>();
  for (const row of eventsQuery.results) {
    eventsMap.set(row.date, row.count);
  }

  const registrationsMap = new Map<string, number>();
  for (const row of registrationsQuery.results) {
    registrationsMap.set(row.date, row.count);
  }

  // Build the response data array, filling in zeros for missing dates
  const data = dateKeys.map(date => ({
    date,
    events: eventsMap.get(date) || 0,
    registrations: registrationsMap.get(date) || 0,
  }));

  return c.json({
    period: period === '30d' ? '30d' : '7d',
    data,
  });
});

// GET /admin/api/users - List all users
app.get('/admin/api/users', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);
  const search = c.req.query('search');

  let query = `
    SELECT user_id, localpart, display_name, avatar_url, is_guest, is_deactivated, admin, created_at, locked, suspended
    FROM users
  `;
  const params: any[] = [];

  if (search) {
    query += ' WHERE localpart LIKE ? OR display_name LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const users = await db.prepare(query).bind(...params).all();

  // Get total count
  let countQuery = 'SELECT COUNT(*) as count FROM users';
  if (search) {
    countQuery += ' WHERE localpart LIKE ? OR display_name LIKE ?';
  }
  const total = search
    ? await db.prepare(countQuery).bind(`%${search}%`, `%${search}%`).first<{ count: number }>()
    : await db.prepare(countQuery).first<{ count: number }>();

  return c.json({
    users: users.results,
    total: total?.count || 0,
    limit,
    offset,
  });
});

// GET /admin/api/users/:userId - Get user details
app.get('/admin/api/users/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  const user = await db.prepare(`
    SELECT user_id, localpart, display_name, avatar_url, is_guest, is_deactivated, admin, created_at, updated_at, locked, suspended
    FROM users WHERE user_id = ?
  `).bind(userId).first();

  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  // Get user's devices
  const devices = await db.prepare(
    'SELECT device_id, display_name, last_seen_ts, last_seen_ip FROM devices WHERE user_id = ?'
  ).bind(userId).all();

  // Get user's rooms
  const rooms = await db.prepare(`
    SELECT rm.room_id, rm.membership, r.room_id as room_exists
    FROM room_memberships rm
    LEFT JOIN rooms r ON rm.room_id = r.room_id
    WHERE rm.user_id = ?
  `).bind(userId).all();

  return c.json({
    ...user,
    devices: devices.results,
    rooms: rooms.results,
  });
});

// PUT /admin/api/users/:userId - Update user
app.put('/admin/api/users/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { display_name, admin, deactivated } = body;

  // Build update query
  const updates: string[] = [];
  const params: any[] = [];

  if (display_name !== undefined) {
    updates.push('display_name = ?');
    params.push(display_name);
  }
  if (admin !== undefined) {
    updates.push('admin = ?');
    params.push(admin ? 1 : 0);
  }
  if (deactivated !== undefined) {
    updates.push('is_deactivated = ?');
    params.push(deactivated ? 1 : 0);
  }

  if (updates.length === 0) {
    return Errors.missingParam('No fields to update').toResponse();
  }

  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(userId);

  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`).bind(...params).run();

  await logAdminAction(c, {
    action: 'user.update',
    target: userId,
    details: {
      display_name: display_name !== undefined,
      admin: admin !== undefined ? !!admin : undefined,
      deactivated: deactivated !== undefined ? !!deactivated : undefined,
    },
  });

  return c.json({ success: true });
});

// DELETE /admin/api/users/:userId - Deactivate user
app.delete('/admin/api/users/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  // Deactivate instead of delete (preserve history)
  await db.prepare(
    'UPDATE users SET is_deactivated = 1, updated_at = ? WHERE user_id = ?'
  ).bind(Date.now(), userId).run();

  // Revoke all access tokens
  await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  await logAdminAction(c, { action: 'user.deactivate', target: userId });

  return c.json({ success: true });
});

// POST /admin/api/users/:userId/reset-password - Reset user password
app.post('/admin/api/users/:userId/reset-password', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { password } = body;
  if (!password) {
    await logAdminAction(c, {
      action: 'user.reset_password',
      target: userId,
      success: false,
      details: { reason: 'missing_password' },
    });
    return Errors.missingParam('password').toResponse();
  }

  // Import hash function
  const { hashPassword } = await import('../utils/crypto');
  const passwordHash = await hashPassword(password);

  await db.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?'
  ).bind(passwordHash, Date.now(), userId).run();

  // Revoke all access tokens to force re-login
  await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();

  await logAdminAction(c, { action: 'user.reset_password', target: userId });

  return c.json({ success: true });
});

// ============================================================================
// MSC4323 (stable since spec v1.18): standard account lock/suspend admin
// endpoints. Authorisation is always checked before any account lookup so
// callers cannot enumerate users; locked/suspended state never touches
// sessions or credentials.
// ============================================================================

// Shared validation for the four moderation endpoints. Returns either the
// target row or an error response; ordering follows the spec: 403 for
// non-admins (handled by requireAdmin), then 400 for non-local user IDs,
// then 404 for unknown/deactivated users, then 403 for self/other-admin
// targets on PUT.
async function moderationTarget(
  c: { env: import('../types').Env; get: (key: string) => unknown },
  userId: string,
  opts: { forWrite: boolean }
): Promise<
  | {
      row: {
        user_id: string;
        admin: number;
        is_deactivated: number;
        locked: number;
        suspended: number;
      };
    }
  | { error: Response }
> {
  const db = c.env.DB;
  const requester = c.get('userId');
  const serverName = c.env.SERVER_NAME;

  const userMatch = userId.match(/^@([^:]+):(.+)$/);
  if (!userMatch || userMatch[2] !== serverName) {
    return {
      error: Errors.invalidParam('userId', 'User does not belong to the local server.').toResponse(),
    };
  }

  const row = await db
    .prepare(
      `SELECT user_id, admin, is_deactivated, locked, suspended FROM users WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      user_id: string;
      admin: number;
      is_deactivated: number;
      locked: number;
      suspended: number;
    }>();

  if (!row || row.is_deactivated === 1) {
    return { error: Errors.notFound('User not found.').toResponse() };
  }

  if (opts.forWrite && (userId === requester || row.admin === 1)) {
    return {
      error: Errors.forbidden('Cannot moderate yourself or another administrator.').toResponse(),
    };
  }

  return { row };
}

// GET /_matrix/client/v1/admin/lock/:userId - Lock status of a local user
app.get('/_matrix/client/v1/admin/lock/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const target = await moderationTarget(c, userId, { forWrite: false });
  if ('error' in target) return target.error;

  return c.json({ locked: target.row.locked === 1 });
});

// PUT /_matrix/client/v1/admin/lock/:userId - Set lock status
app.put('/_matrix/client/v1/admin/lock/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));

  let body: { locked?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
  if (typeof body.locked !== 'boolean') {
    return Errors.missingParam('locked').toResponse();
  }

  const target = await moderationTarget(c, userId, { forWrite: true });
  if ('error' in target) return target.error;

  await c.env.DB.prepare(
    `UPDATE users SET locked = ?, updated_at = ? WHERE user_id = ?`
  ).bind(body.locked ? 1 : 0, Date.now(), userId).run();

  await logAdminAction(c, {
    action: 'user.lock',
    target: userId,
    details: { locked: body.locked },
  });

  // Sessions are intentionally left intact (soft logout semantics).
  return c.json({ locked: body.locked });
});

// ============================================================================
// Moderation policy lists (spec module): server-side subscriptions.
//
// A subscription points the server at a policy room, joined by a
// dedicated local system user (@moderation:<server>, created on first
// use with an unknowable random password). m.ban rules in that room's
// m.policy.rule.{user,room,server} state are enforced at our invite/
// join/PDU gates (see src/services/moderation-policy.ts).
// ============================================================================

async function getOrCreateModerationUser(
  db: D1Database,
  serverName: string
): Promise<string> {
  const userId = `@moderation:${serverName}`;
  const existing = await db
    .prepare('SELECT user_id FROM users WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: string }>();
  if (existing) return userId;

  // Random, discarded credential: the account only acts server-side via
  // workflows, never logs in.
  const randomPassword = crypto.randomUUID() + crypto.randomUUID();
  const { hashPassword } = await import('../utils/crypto');
  const passwordHash = await hashPassword(randomPassword);
  await db.prepare(
    `INSERT INTO users (user_id, localpart, password_hash, display_name, admin, created_at, updated_at)
     VALUES (?, 'moderation', ?, 'Moderation Policy Subscriber', 0, ?, ?)`
  ).bind(userId, passwordHash, Date.now(), Date.now()).run();
  return userId;
}

// GET /admin/api/policy-lists - List subscriptions with rule counts
app.get('/admin/api/policy-lists', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const rows = await db
    .prepare(
      `SELECT room_id, enabled, subscriber_user_id, added_at, added_by
       FROM policy_list_subscriptions ORDER BY added_at DESC`
    )
    .all<{
      room_id: string;
      enabled: number;
      subscriber_user_id: string;
      added_at: number;
      added_by: string;
    }>();

  const lists = [];
  for (const row of rows.results) {
    let ruleCount = 0;
    try {
      const counted = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM room_state rs
           JOIN events e ON rs.event_id = e.event_id
           WHERE rs.room_id = ? AND rs.event_type IN
             ('m.policy.rule.user', 'm.policy.rule.room', 'm.policy.rule.server')`
        )
        .bind(row.room_id)
        .first<{ count: number }>();
      ruleCount = counted?.count ?? 0;
    } catch {
      // rules unreadable (room state not synced yet)
    }
    lists.push({ ...row, enabled: row.enabled === 1, rule_count: ruleCount });
  }

  return c.json({ lists, total: lists.length });
});

// POST /admin/api/policy-lists - Subscribe to a policy room
app.post('/admin/api/policy-lists', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const requester = c.get('userId');

  let body: { room_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
  const roomId = body.room_id;
  if (!roomId || !roomId.startsWith('!')) {
    return Errors.invalidParam('room_id', 'A room ID (!...) is required').toResponse();
  }

  // The dedicated subscriber user keeps state flowing to us.
  const subscriber = await getOrCreateModerationUser(db, c.env.SERVER_NAME);

  const room = await getRoom(db, roomId);
  const roomServer = roomId.includes(':') ? roomId.slice(roomId.indexOf(':') + 1) : null;
  const isRemoteRoom = Boolean(roomServer && roomServer !== c.env.SERVER_NAME);

  await db.prepare(
    `INSERT INTO policy_list_subscriptions (room_id, enabled, subscriber_user_id, added_at, added_by)
     VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET enabled = 1, subscriber_user_id = excluded.subscriber_user_id`
  ).bind(roomId, subscriber, Date.now(), requester).run();

  // Join the policy room so the rules actually flow to us. Local rooms
  // with public join rules can be joined directly; remote rooms (or
  // invite-only rooms) go through the join workflow — invite-only lists
  // need an invite for @moderation:<server> first.
  if (!room || isRemoteRoom) {
    const targetServer = roomServer ?? c.env.SERVER_NAME;
    try {
      await c.env.ROOM_JOIN_WORKFLOW.create({
        params: {
          roomId,
          userId: subscriber,
          isRemote: isRemoteRoom,
          remoteServer: targetServer,
          backfill: true,
        },
      });
    } catch (wfErr) {
      console.warn('[admin] policy list join workflow failed:', wfErr);
    }
  } else {
    try {
      const { joinBotUserToRoom } = await import('./rooms');
      await joinBotUserToRoom(c.env, roomId, subscriber);
    } catch (joinErr) {
      console.warn('[admin] policy list local join failed:', joinErr);
    }
  }

  await invalidatePolicyRulesCache(c.env.CACHE).catch(() => {});
  await logAdminAction(c, { action: 'policy_list.subscribe', target: roomId });

  return c.json({
    success: true,
    room_id: roomId,
    subscriber_user_id: subscriber,
    note: isRemoteRoom
      ? 'Joining in the background; invite-only lists require an invite for the subscriber user first.'
      : 'Subscribed; rules are enforced within the cache TTL.',
  });
});

// DELETE /admin/api/policy-lists/:roomId - Unsubscribe (rules stop
// applying; the subscriber's membership is left alone — it is harmless
// and leaving remote rooms requires a federated leave event).
app.delete('/admin/api/policy-lists/:roomId', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const roomId = c.req.param('roomId');

  const result = await db.prepare(
    `UPDATE policy_list_subscriptions SET enabled = 0 WHERE room_id = ?`
  ).bind(roomId).run();
  if ((result.meta?.changes ?? 0) === 0) {
    return Errors.notFound('Subscription not found').toResponse();
  }

  await invalidatePolicyRulesCache(c.env.CACHE).catch(() => {});
  await logAdminAction(c, { action: 'policy_list.unsubscribe', target: roomId });
  return c.json({ success: true });
});

// GET /_matrix/client/v1/admin/suspend/:userId - Suspension status
app.get('/_matrix/client/v1/admin/suspend/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const target = await moderationTarget(c, userId, { forWrite: false });
  if ('error' in target) return target.error;

  return c.json({ suspended: target.row.suspended === 1 });
});

// PUT /_matrix/client/v1/admin/suspend/:userId - Set suspension status
app.put('/_matrix/client/v1/admin/suspend/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));

  let body: { suspended?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }
  if (typeof body.suspended !== 'boolean') {
    return Errors.missingParam('suspended').toResponse();
  }

  const target = await moderationTarget(c, userId, { forWrite: true });
  if ('error' in target) return target.error;

  await c.env.DB.prepare(
    `UPDATE users SET suspended = ?, updated_at = ? WHERE user_id = ?`
  ).bind(body.suspended ? 1 : 0, Date.now(), userId).run();

  await logAdminAction(c, {
    action: 'user.suspend',
    target: userId,
    details: { suspended: body.suspended },
  });

  return c.json({ suspended: body.suspended });
});

// GET /admin/api/rooms - List all rooms
app.get('/admin/api/rooms', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

  const rooms = await db.prepare(`
    SELECT r.room_id, r.room_version, r.is_public, r.creator_id, r.created_at,
           (SELECT COUNT(*) FROM room_memberships WHERE room_id = r.room_id AND membership = 'join') as member_count,
           (SELECT COUNT(*) FROM events WHERE room_id = r.room_id) as event_count
    FROM rooms r
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  // Get room names
  const roomsWithNames = await Promise.all(rooms.results.map(async (room: any) => {
    const nameEvent = await db.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
    `).bind(room.room_id).first<{ content: string }>();

    return {
      ...room,
      name: nameEvent ? JSON.parse(nameEvent.content).name : null,
    };
  }));

  const total = await db.prepare('SELECT COUNT(*) as count FROM rooms').first<{ count: number }>();

  return c.json({
    rooms: roomsWithNames,
    total: total?.count || 0,
    limit,
    offset,
  });
});

// GET /admin/api/rooms/:roomId - Get room details
app.get('/admin/api/rooms/:roomId', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;

  const room = await db.prepare(`
    SELECT room_id, room_version, is_public, creator_id, created_at
    FROM rooms WHERE room_id = ?
  `).bind(roomId).first();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get room state
  const state = await db.prepare(`
    SELECT e.event_type, e.state_key, e.content, e.sender, e.origin_server_ts
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ?
  `).bind(roomId).all();

  // Get members
  const members = await db.prepare(`
    SELECT user_id, membership, display_name, avatar_url
    FROM room_memberships WHERE room_id = ?
  `).bind(roomId).all();

  // Get aliases
  const aliases = await db.prepare(
    'SELECT alias FROM room_aliases WHERE room_id = ?'
  ).bind(roomId).all();

  // Parse state
  const stateMap: Record<string, any> = {};
  for (const s of state.results as any[]) {
    stateMap[`${s.event_type}|${s.state_key}`] = {
      type: s.event_type,
      state_key: s.state_key,
      content: JSON.parse(s.content),
      sender: s.sender,
    };
  }

  return c.json({
    ...room,
    name: stateMap['m.room.name|']?.content?.name,
    topic: stateMap['m.room.topic|']?.content?.topic,
    avatar_url: stateMap['m.room.avatar|']?.content?.url,
    join_rule: stateMap['m.room.join_rules|']?.content?.join_rule,
    members: members.results,
    member_count: members.results.length,
    aliases: aliases.results.map((a: any) => a.alias),
    state: state.results.map((s: any) => ({
      ...s,
      content: JSON.parse(s.content),
    })),
  });
});

// DELETE /admin/api/rooms/:roomId - Delete room
app.delete('/admin/api/rooms/:roomId', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;

  // Delete in order (foreign key constraints)
  await db.prepare('DELETE FROM room_aliases WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM room_memberships WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM room_state WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM events WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM rooms WHERE room_id = ?').bind(roomId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  await logAdminAction(c, { action: 'room.delete', target: roomId });

  return c.json({ success: true });
});

// GET /admin/api/federation/status - Get federation status
app.get('/admin/api/federation/status', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const serverName = c.env.SERVER_NAME;

  // Get known servers count
  const serversCount = await db.prepare('SELECT COUNT(*) as count FROM servers').first<{ count: number }>();

  // Get signing key info
  let signingKeyId = null;
  try {
    const keyData = await c.env.CACHE.get('server_signing_key');
    if (keyData) {
      const parsed = JSON.parse(keyData);
      signingKeyId = parsed.keyId || `ed25519:${serverName.split('.')[0]}`;
    }
  } catch (e) {
    // Key might not be cached
  }

  return c.json({
    server_name: serverName,
    federation_enabled: true,
    signing_key_id: signingKeyId || `ed25519:a_${serverName.replace(/\./g, '_').substring(0, 4)}`,
    known_servers_count: serversCount?.count || 0,
  }, 200, { 'Cache-Control': 'no-store' });
});

// GET /admin/api/federation/test - Run federation self-tests
app.get('/admin/api/federation/test', requireAuth(), requireAdmin, async (c) => {
  const serverName = c.env.SERVER_NAME;
  const tests: Array<{ name: string; passed: boolean; message: string }> = [];

  // Self-tests run in-process. A same-zone fetch() to a route-based URL is
  // not permitted on Cloudflare and falls through to the website Worker, so
  // the public fetch path cannot verify this server (it returned 404/Network
  // error under path routing). Mirrors the key-check endpoint's approach.
  // Test 1: Check .well-known/matrix/server
  try {
    const resp = await versions.request('http://localhost/.well-known/matrix/server', {}, c.env);
    if (resp.ok) {
      const data = await resp.json() as any;
      tests.push({
        name: '.well-known/matrix/server',
        passed: true,
        message: `Delegates to ${data['m.server'] || serverName}`,
      });
    } else {
      tests.push({
        name: '.well-known/matrix/server',
        passed: false,
        message: `HTTP ${resp.status}`,
      });
    }
  } catch (e: any) {
    tests.push({
      name: '.well-known/matrix/server',
      passed: false,
      message: e.message || 'Failed to fetch',
    });
  }

  // Test 2: Check /_matrix/key/v2/server
  try {
    const resp = await federation.request('http://localhost/_matrix/key/v2/server', {}, c.env);
    if (resp.ok) {
      const data = await resp.json() as any;
      const hasSigningKeys = data.verify_keys && Object.keys(data.verify_keys).length > 0;
      tests.push({
        name: 'Server signing keys',
        passed: hasSigningKeys,
        message: hasSigningKeys ? `${Object.keys(data.verify_keys).length} key(s) published` : 'No signing keys found',
      });
    } else {
      tests.push({
        name: 'Server signing keys',
        passed: false,
        message: `HTTP ${resp.status}`,
      });
    }
  } catch (e: any) {
    tests.push({
      name: 'Server signing keys',
      passed: false,
      message: e.message || 'Failed to fetch',
    });
  }

  // Test 3: Check /_matrix/federation/v1/version
  try {
    const resp = await federation.request('http://localhost/_matrix/federation/v1/version', {}, c.env);
    if (resp.ok) {
      const data = await resp.json() as any;
      tests.push({
        name: 'Federation API',
        passed: true,
        message: `Server: ${data.server?.name || 'Unknown'} ${data.server?.version || ''}`,
      });
    } else {
      tests.push({
        name: 'Federation API',
        passed: false,
        message: `HTTP ${resp.status}`,
      });
    }
  } catch (e: any) {
    tests.push({
      name: 'Federation API',
      passed: false,
      message: e.message || 'Failed to fetch',
    });
  }

  // Test 4: Check .well-known/matrix/client
  try {
    const resp = await versions.request('http://localhost/.well-known/matrix/client', {}, c.env);
    if (resp.ok) {
      const data = await resp.json() as any;
      tests.push({
        name: '.well-known/matrix/client',
        passed: true,
        message: `Homeserver: ${data['m.homeserver']?.base_url || 'configured'}`,
      });
    } else {
      tests.push({
        name: '.well-known/matrix/client',
        passed: false,
        message: `HTTP ${resp.status}`,
      });
    }
  } catch (e: any) {
    tests.push({
      name: '.well-known/matrix/client',
      passed: false,
      message: e.message || 'Failed to fetch',
    });
  }

  const allPassed = tests.every(t => t.passed);

  return c.json({
    success: allPassed,
    server_name: serverName,
    tests,
  }, 200, { 'Cache-Control': 'no-store' });
});

// GET /admin/api/federation/key-check - Tester-equivalent validation of our own
// server key response. Mirrors the gomatrixserverlib CheckKeys semantics the
// Matrix Federation Tester applies: every published verify_key must be a valid
// ed25519 key AND carry a matching signature, otherwise strict peers reject
// the whole response (AllEd25519ChecksOK = false).
// The check runs against our /_matrix/key/v2/server handler in-process, so
// regressions are caught before the public network path is involved.
app.get('/admin/api/federation/key-check', requireAuth(), requireAdmin, async (c) => {
  const serverName = c.env.SERVER_NAME;

  const res = await federation.request('http://localhost/_matrix/key/v2/server', {}, c.env);
  if (!res.ok) {
    return c.json({
      AllChecksOK: false,
      MatchingServerName: false,
      FutureValidUntilTS: false,
      HasEd25519Key: false,
      AllEd25519ChecksOK: null,
      Ed25519Checks: {},
      error: `/_matrix/key/v2/server responded HTTP ${res.status}`,
    });
  }

  const body = (await res.json()) as Record<string, unknown>;
  const verifyKeys = (body.verify_keys ?? {}) as Record<string, { key?: string }>;

  const ed25519Checks: Record<string, { ValidEd25519: boolean; MatchingSignature: boolean }> = {};
  let hasEd25519Key = false;
  let allEd25519ChecksOK = true;

  for (const [keyId, keyData] of Object.entries(verifyKeys)) {
    if (keyId.split(':', 2)[0] !== 'ed25519') continue;
    hasEd25519Key = true;

    let validEd25519 = false;
    if (typeof keyData.key === 'string') {
      try {
        validEd25519 = base64UrlDecode(keyData.key).length === 32;
      } catch {
        validEd25519 = false;
      }
    }

    const matchingSignature =
      validEd25519 && typeof keyData.key === 'string'
        ? await verifySignature(body, serverName, keyId, keyData.key)
        : false;

    ed25519Checks[keyId] = { ValidEd25519: validEd25519, MatchingSignature: matchingSignature };
    if (!matchingSignature) allEd25519ChecksOK = false;
  }

  const matchingServerName = body.server_name === serverName;
  const futureValidUntilTS =
    (typeof body.valid_until_ts === 'number' ? body.valid_until_ts : 0) > Date.now();

  return c.json({
    AllChecksOK: matchingServerName && futureValidUntilTS && hasEd25519Key && allEd25519ChecksOK,
    MatchingServerName: matchingServerName,
    FutureValidUntilTS: futureValidUntilTS,
    HasEd25519Key: hasEd25519Key,
    AllEd25519ChecksOK: hasEd25519Key ? allEd25519ChecksOK : null,
    Ed25519Checks: ed25519Checks,
  });
});

// GET /admin/api/federation/servers - List known federation servers
app.get('/admin/api/federation/servers', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;

  const servers = await db.prepare(`
    SELECT server_name, valid_until_ts, last_successful_fetch, retry_count
    FROM servers
    ORDER BY last_successful_fetch DESC
  `).all();

  return c.json({ servers: servers.results });
});

// GET /admin/api/media - List media files
app.get('/admin/api/media', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

  const media = await db.prepare(`
    SELECT media_id, user_id, content_type, content_length, filename, created_at, quarantined
    FROM media
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await db.prepare('SELECT COUNT(*) as count FROM media').first<{ count: number }>();

  return c.json({
    media: media.results,
    total: total?.count || 0,
    limit,
    offset,
  });
});

// DELETE /admin/api/media/:mediaId - Delete media
app.delete('/admin/api/media/:mediaId', requireAuth(), requireAdmin, async (c) => {
  const mediaId = c.req.param('mediaId');
  const db = c.env.DB;

  // Delete from R2
  await c.env.MEDIA.delete(mediaId);

  // Delete thumbnails
  const thumbnails = await db.prepare(
    'SELECT width, height, method FROM thumbnails WHERE media_id = ?'
  ).bind(mediaId).all();

  for (const thumb of thumbnails.results as any[]) {
    await c.env.MEDIA.delete(`thumb_${mediaId}_${thumb.width}x${thumb.height}_${thumb.method}`);
  }

  // Delete from database
  await db.prepare('DELETE FROM thumbnails WHERE media_id = ?').bind(mediaId).run();
  await db.prepare('DELETE FROM media WHERE media_id = ?').bind(mediaId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({ success: true });
});

// POST /admin/api/media/:mediaId/quarantine - Quarantine media
app.post('/admin/api/media/:mediaId/quarantine', requireAuth(), requireAdmin, async (c) => {
  const mediaId = c.req.param('mediaId');
  const db = c.env.DB;

  await db.prepare(
    'UPDATE media SET quarantined = 1 WHERE media_id = ?'
  ).bind(mediaId).run();

  return c.json({ success: true });
});

// GET /admin/api/config - Get server configuration
app.get('/admin/api/config', requireAuth(), requireAdmin, async (c) => {
  return c.json({
    server_name: c.env.SERVER_NAME,
    version: c.env.SERVER_VERSION,
    features: {
      registration: true,
      federation: true,
      media_upload: true,
      voip: true,
    },
    limits: {
      max_upload_size: 50 * 1024 * 1024,
    },
  }, 200, { 'Cache-Control': 'no-store' });
});

// POST /admin/api/make-admin - Make a user an admin
app.post('/admin/api/make-admin', requireAuth(), requireAdmin, async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id } = body;
  if (!user_id) {
    return Errors.missingParam('user_id').toResponse();
  }

  await c.env.DB.prepare(
    'UPDATE users SET admin = 1, updated_at = ? WHERE user_id = ?'
  ).bind(Date.now(), user_id).run();

  await logAdminAction(c, { action: 'user.make_admin', target: user_id });

  return c.json({ success: true });
});

// POST /admin/api/remove-admin - Remove admin privileges
app.post('/admin/api/remove-admin', requireAuth(), requireAdmin, async (c) => {
  const currentUserId = c.get('userId');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id } = body;
  if (!user_id) {
    return Errors.missingParam('user_id').toResponse();
  }

  // Prevent self-demotion
  if (user_id === currentUserId) {
    return Errors.forbidden('Cannot remove your own admin privileges').toResponse();
  }

  await c.env.DB.prepare(
    'UPDATE users SET admin = 0, updated_at = ? WHERE user_id = ?'
  ).bind(Date.now(), user_id).run();

  await logAdminAction(c, { action: 'user.remove_admin', target: user_id });

  return c.json({ success: true });
});

// DELETE /admin/api/users/:userId/purge - Completely delete user and all data
app.delete('/admin/api/users/:userId/purge', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;
  const currentUserId = c.get('userId');

  // Prevent self-deletion
  if (userId === currentUserId) {
    return Errors.forbidden('Cannot delete your own account').toResponse();
  }

  // Get devices BEFORE deleting them (for KV cleanup)
  const devices = await db.prepare('SELECT device_id FROM devices WHERE user_id = ?').bind(userId).all<{ device_id: string }>();

  // Get and delete media BEFORE deleting user (FK constraint without CASCADE)
  const media = await db.prepare('SELECT media_id FROM media WHERE user_id = ?').bind(userId).all<{ media_id: string }>();
  for (const m of media.results) {
    // Delete from R2
    await c.env.MEDIA.delete(m.media_id);
    // Delete thumbnails
    const thumbs = await db.prepare('SELECT width, height, method FROM thumbnails WHERE media_id = ?').bind(m.media_id).all<{ width: number; height: number; method: string }>();
    for (const t of thumbs.results) {
      await c.env.MEDIA.delete(`thumb_${m.media_id}_${t.width}x${t.height}_${t.method}`);
    }
  }
  await db.prepare('DELETE FROM thumbnails WHERE media_id IN (SELECT media_id FROM media WHERE user_id = ?)').bind(userId).run();
  await db.prepare('DELETE FROM media WHERE user_id = ?').bind(userId).run();

  // Delete all user data in order (respecting foreign key constraints)
  // Account & profile data
  await db.prepare('DELETE FROM account_data WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM account_data_changes WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM presence WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM push_rules WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM sync_tokens WHERE user_id = ?').bind(userId).run();
  
  // E2EE & device keys
  await db.prepare('DELETE FROM cross_signing_keys WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM cross_signing_signatures WHERE user_id = ? OR signer_user_id = ?').bind(userId, userId).run();
  await db.prepare('DELETE FROM one_time_keys WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM fallback_keys WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM device_key_changes WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM key_backup_keys WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM key_backup_versions WHERE user_id = ?').bind(userId).run();
  
  // Messaging
  await db.prepare('DELETE FROM to_device_messages WHERE recipient_user_id = ? OR sender_user_id = ?').bind(userId, userId).run();
  await db.prepare('DELETE FROM pushers WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM notification_queue WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM transaction_ids WHERE user_id = ?').bind(userId).run();
  
  // Room participation
  await db.prepare('DELETE FROM receipts WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM typing WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM room_memberships WHERE user_id = ?').bind(userId).run();
  
  // Identity & auth
  await db.prepare('DELETE FROM user_threepids WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM idp_user_links WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId).run();
  
  // Finally delete the user
  await db.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

  // Delete device keys from KV
  for (const device of devices.results) {
    await c.env.DEVICE_KEYS.delete(`device:${userId}:${device.device_id}`);
  }

  // Clean up cross-signing keys from KV (stored as user:{userId} in keys.ts)
  await c.env.CROSS_SIGNING_KEYS.delete(`user:${userId}`);

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  await logAdminAction(c, { action: 'user.purge', target: userId });

  return c.json({ success: true });
});

// POST /admin/api/users/bulk-delete - Delete multiple users
app.post('/admin/api/users/bulk-delete', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const currentUserId = c.get('userId');

  let body: { user_ids: string[]; preserve_admin?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  let { user_ids, preserve_admin } = body;
  if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
    return Errors.missingParam('user_ids array required').toResponse();
  }

  // Always remove current user from deletion list
  user_ids = user_ids.filter(id => id !== currentUserId);

  // Optionally filter out admins
  if (preserve_admin) {
    const admins = await db.prepare(`
      SELECT user_id FROM users WHERE admin = 1
    `).all<{ user_id: string }>();
    const adminIds = new Set(admins.results.map(a => a.user_id));
    user_ids = user_ids.filter(id => !adminIds.has(id));
  }

  if (user_ids.length === 0) {
    return c.json({ success: true, deleted: 0 });
  }

  // Delete all user data for each user
  let deleted = 0;
  for (const userId of user_ids) {
    // Get devices BEFORE deleting (for KV cleanup)
    const devices = await db.prepare('SELECT device_id FROM devices WHERE user_id = ?').bind(userId).all<{ device_id: string }>();
    
    // Delete media BEFORE user (FK constraint without CASCADE)
    const media = await db.prepare('SELECT media_id FROM media WHERE user_id = ?').bind(userId).all<{ media_id: string }>();
    for (const m of media.results) {
      await c.env.MEDIA.delete(m.media_id);
      const thumbs = await db.prepare('SELECT width, height, method FROM thumbnails WHERE media_id = ?').bind(m.media_id).all<{ width: number; height: number; method: string }>();
      for (const t of thumbs.results) {
        await c.env.MEDIA.delete(`thumb_${m.media_id}_${t.width}x${t.height}_${t.method}`);
      }
    }
    await db.prepare('DELETE FROM thumbnails WHERE media_id IN (SELECT media_id FROM media WHERE user_id = ?)').bind(userId).run();
    await db.prepare('DELETE FROM media WHERE user_id = ?').bind(userId).run();
    
    // Account & profile data
    await db.prepare('DELETE FROM account_data WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM account_data_changes WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM presence WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM push_rules WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM sync_tokens WHERE user_id = ?').bind(userId).run();
    
    // E2EE & device keys
    await db.prepare('DELETE FROM cross_signing_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM cross_signing_signatures WHERE user_id = ? OR signer_user_id = ?').bind(userId, userId).run();
    await db.prepare('DELETE FROM one_time_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM fallback_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM device_key_changes WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM key_backup_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM key_backup_versions WHERE user_id = ?').bind(userId).run();
    
    // Messaging
    await db.prepare('DELETE FROM to_device_messages WHERE recipient_user_id = ? OR sender_user_id = ?').bind(userId, userId).run();
    await db.prepare('DELETE FROM pushers WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM notification_queue WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM transaction_ids WHERE user_id = ?').bind(userId).run();
    
    // Room participation
    await db.prepare('DELETE FROM receipts WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM typing WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM room_memberships WHERE user_id = ?').bind(userId).run();
    
    // Identity & auth
    await db.prepare('DELETE FROM user_threepids WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM idp_user_links WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId).run();
    
    // Finally delete the user
    await db.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

    // Clean up KV data
    for (const device of devices.results) {
      await c.env.DEVICE_KEYS.delete(`device:${userId}:${device.device_id}`);
    }
    // Cross-signing keys stored as user:{userId} in keys.ts
    await c.env.CROSS_SIGNING_KEYS.delete(`user:${userId}`);
    
    deleted++;
  }

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({ success: true, deleted });
});

// POST /admin/api/cleanup - Clean up all data except admin users
app.post('/admin/api/cleanup', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;

  // Get all non-admin users
  const users = await db.prepare(`
    SELECT user_id FROM users WHERE admin = 0
  `).all<{ user_id: string }>();
  const userIds = users.results.map(u => u.user_id);

  // Get all devices for KV cleanup
  const allDevices = await db.prepare(`
    SELECT user_id, device_id FROM devices WHERE user_id IN (SELECT user_id FROM users WHERE admin = 0)
  `).all<{ user_id: string; device_id: string }>();

  // Delete user-related data for each non-admin user
  for (const userId of userIds) {
    // Account & profile data
    await db.prepare('DELETE FROM account_data WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM account_data_changes WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM presence WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM push_rules WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM sync_tokens WHERE user_id = ?').bind(userId).run();
    
    // E2EE & device keys
    await db.prepare('DELETE FROM cross_signing_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM cross_signing_signatures WHERE user_id = ? OR signer_user_id = ?').bind(userId, userId).run();
    await db.prepare('DELETE FROM one_time_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM fallback_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM device_key_changes WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM key_backup_keys WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM key_backup_versions WHERE user_id = ?').bind(userId).run();
    
    // Messaging
    await db.prepare('DELETE FROM to_device_messages WHERE recipient_user_id = ? OR sender_user_id = ?').bind(userId, userId).run();
    await db.prepare('DELETE FROM pushers WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM notification_queue WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM transaction_ids WHERE user_id = ?').bind(userId).run();
    
    // Room participation
    await db.prepare('DELETE FROM receipts WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM typing WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM room_memberships WHERE user_id = ?').bind(userId).run();
    
    // Identity & auth
    await db.prepare('DELETE FROM user_threepids WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM idp_user_links WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();
    await db.prepare('DELETE FROM devices WHERE user_id = ?').bind(userId).run();
    
    // Finally delete the user
    await db.prepare('DELETE FROM users WHERE user_id = ?').bind(userId).run();

    // Clean up KV cross-signing keys (stored as user:{userId} in keys.ts)
    await c.env.CROSS_SIGNING_KEYS.delete(`user:${userId}`);
  }

  // Clean up device keys from KV
  for (const device of allDevices.results) {
    await c.env.DEVICE_KEYS.delete(`device:${device.user_id}:${device.device_id}`);
  }

  // Delete all rooms, events, and related data
  await db.prepare('DELETE FROM event_relations').run();
  await db.prepare('DELETE FROM room_state').run();
  await db.prepare('DELETE FROM room_aliases').run();
  await db.prepare('DELETE FROM room_knocks').run();
  await db.prepare('DELETE FROM content_reports').run();
  await db.prepare('DELETE FROM events').run();
  await db.prepare('DELETE FROM rooms').run();

  // Clean up media (delete from R2 and database)
  const media = await db.prepare('SELECT media_id FROM media').all<{ media_id: string }>();
  for (const m of media.results) {
    await c.env.MEDIA.delete(m.media_id);
  }
  await db.prepare('DELETE FROM thumbnails').run();
  await db.prepare('DELETE FROM media').run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({ 
    success: true, 
    users_deleted: userIds.length,
    rooms_deleted: true,
    media_deleted: media.results.length
  });
});

// POST /admin/api/users/:userId/reactivate - Reactivate a deactivated user
app.post('/admin/api/users/:userId/reactivate', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  await db.prepare(
    'UPDATE users SET is_deactivated = 0, updated_at = ? WHERE user_id = ?'
  ).bind(Date.now(), userId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({ success: true });
});

// POST /admin/api/users/create - Create a new user
app.post('/admin/api/users/create', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { username, password, display_name, admin } = body;
  if (!username || !password) {
    return Errors.missingParam('username and password required').toResponse();
  }

  // Validate username
  if (!/^[a-z0-9._=-]+$/i.test(username)) {
    return c.json({ errcode: 'M_INVALID_USERNAME', error: 'Invalid username format' }, 400);
  }

  // Get server name from env
  const serverName = c.env.SERVER_NAME;
  const userId = `@${username}:${serverName}`;

  // Check if user exists
  const existing = await db.prepare(
    'SELECT user_id FROM users WHERE user_id = ?'
  ).bind(userId).first();

  if (existing) {
    return c.json({ errcode: 'M_USER_IN_USE', error: 'Username already taken' }, 400);
  }

  // Hash password
  const { hashPassword } = await import('../utils/crypto');
  const passwordHash = await hashPassword(password);

  // Create user
  await db.prepare(`
    INSERT INTO users (user_id, localpart, password_hash, display_name, admin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, username, passwordHash, display_name || null, admin ? 1 : 0, Date.now(), Date.now()).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({ success: true, user_id: userId });
});

// POST /admin/api/registration-tokens - Mint an invite token.
// The raw token is returned exactly once; only its SHA-256 hash is stored.
app.post('/admin/api/registration-tokens', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: { note?: string; expires_in_hours?: number; uses?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body or invalid JSON: use defaults.
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  const uses = Number.isFinite(body.uses)
    ? Math.min(Math.max(Math.floor(body.uses as number), 1), 100)
    : 1;
  const expiresInHours = Number.isFinite(body.expires_in_hours)
    ? Math.min(Math.max(body.expires_in_hours as number, 1), 24 * 365)
    : 24 * 7;
  const expiresAt = Date.now() + expiresInHours * 60 * 60 * 1000;

  const id = await generateOpaqueId(16);
  const token = await generateRegistrationToken();
  await createRegistrationToken(db, id, await hashToken(token), note, c.get('userId'), expiresAt, uses);

  // The token is a bearer credential; never let it be cached, and record the
  // issuance in the admin audit log.
  c.header('Cache-Control', 'no-store');
  await logAdminAction(c, {
    action: 'registration_token.create',
    target: id,
    details: { uses, expires_at: expiresAt, note },
  });

  return c.json({ id, token, note, uses, expires_at: expiresAt });
});

// GET /admin/api/registration-tokens - List invite tokens (hashes omitted)
app.get('/admin/api/registration-tokens', requireAuth(), requireAdmin, async (c) => {
  const tokens = await listRegistrationTokens(c.env.DB);
  return c.json({ tokens });
});

// DELETE /admin/api/registration-tokens/:id - Revoke an invite token
app.delete('/admin/api/registration-tokens/:id', requireAuth(), requireAdmin, async (c) => {
  const id = c.req.param('id');
  const revoked = await revokeRegistrationToken(c.env.DB, id);
  if (!revoked) {
    return Errors.notFound('Registration token not found').toResponse();
  }
  await logAdminAction(c, { action: 'registration_token.revoke', target: id });
  return c.json({ revoked: true });
});

// GET /admin/api/users/:userId/sessions - Get user sessions/tokens
app.get('/admin/api/users/:userId/sessions', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  const sessions = await db.prepare(`
    SELECT token_id as id, device_id, created_at
    FROM access_tokens
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(userId).all();

  return c.json({ sessions: sessions.results });
});

// DELETE /admin/api/users/:userId/sessions - Revoke all user sessions
app.delete('/admin/api/users/:userId/sessions', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  const result = await db.prepare(
    'DELETE FROM access_tokens WHERE user_id = ?'
  ).bind(userId).run();

  return c.json({ success: true, revoked: result.meta.changes || 0 });
});

// DELETE /admin/api/sessions/:sessionId - Revoke specific session
app.delete('/admin/api/sessions/:sessionId', requireAuth(), requireAdmin, async (c) => {
  const sessionId = c.req.param('sessionId');
  const db = c.env.DB;

  await db.prepare(
    'DELETE FROM access_tokens WHERE token_id = ?'
  ).bind(sessionId).run();

  return c.json({ success: true });
});

// GET /admin/api/rooms/:roomId/events - Browse room events
app.get('/admin/api/rooms/:roomId/events', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const before = c.req.query('before');

  let query = `
    SELECT event_id, event_type, state_key, sender, content, origin_server_ts, stream_position
    FROM events
    WHERE room_id = ?
  `;
  const params: any[] = [roomId];

  if (before) {
    query += ` AND stream_position < ?`;
    params.push(parseInt(before));
  }

  query += ` ORDER BY stream_position DESC LIMIT ?`;
  params.push(limit);

  const events = await db.prepare(query).bind(...params).all();

  return c.json({
    events: events.results.map((e: any) => ({
      ...e,
      content: JSON.parse(e.content),
    })),
  });
});

// GET /admin/api/reports - Get content reports (proxy to existing endpoint format)
app.get('/admin/api/reports', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 100));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);
  const resolved = c.req.query('resolved');

  let query = `
    SELECT cr.*, e.sender as reported_user_id, e.event_type, e.content
    FROM content_reports cr
    LEFT JOIN events e ON cr.event_id = e.event_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (resolved === 'true') {
    query += ` AND cr.resolved = 1`;
  } else if (resolved === 'false') {
    query += ` AND cr.resolved = 0`;
  }

  query += ` ORDER BY cr.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const reports = await db.prepare(query).bind(...params).all();

  // Get total count
  let countQuery = 'SELECT COUNT(*) as count FROM content_reports WHERE 1=1';
  if (resolved === 'true') {
    countQuery += ` AND resolved = 1`;
  } else if (resolved === 'false') {
    countQuery += ` AND resolved = 0`;
  }
  const total = await db.prepare(countQuery).first<{ count: number }>();

  return c.json({
    reports: reports.results.map((r: any) => ({
      id: r.id,
      reporter_user_id: r.reporter_user_id,
      reported_user_id: r.reported_user_id,
      room_id: r.room_id,
      event_id: r.event_id,
      event_type: r.event_type,
      event_content: r.content ? JSON.parse(r.content) : null,
      reason: r.reason,
      score: r.score,
      created_at: r.created_at,
      resolved: r.resolved,
      resolved_by: r.resolved_by,
      resolved_at: r.resolved_at,
      resolution_note: r.resolution_note,
    })),
    total: total?.count || 0,
    limit,
    offset,
  });
});

// POST /admin/api/reports/:reportId/resolve - Resolve a report
app.post('/admin/api/reports/:reportId/resolve', requireAuth(), requireAdmin, async (c) => {
  const userId = c.get('userId');
  const reportId = c.req.param('reportId');
  const db = c.env.DB;

  let body: { note?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const result = await db.prepare(`
    UPDATE content_reports
    SET resolved = 1, resolved_by = ?, resolved_at = ?, resolution_note = ?
    WHERE id = ?
  `).bind(userId, Date.now(), body.note || null, parseInt(reportId)).run();

  if (result.meta.changes === 0) {
    return Errors.notFound('Report not found').toResponse();
  }

  // Invalidate stats cache (affects unresolved reports count)
  await invalidateStatsCache(c.env);

  return c.json({ success: true });
});

// POST /admin/api/reports/:reportId/unresolve - Unresolve a report
app.post('/admin/api/reports/:reportId/unresolve', requireAuth(), requireAdmin, async (c) => {
  const reportId = c.req.param('reportId');
  const db = c.env.DB;

  const result = await db.prepare(`
    UPDATE content_reports
    SET resolved = 0, resolved_by = NULL, resolved_at = NULL, resolution_note = NULL
    WHERE id = ?
  `).bind(parseInt(reportId)).run();

  if (result.meta.changes === 0) {
    return Errors.notFound('Report not found').toResponse();
  }

  // Invalidate stats cache (affects unresolved reports count)
  await invalidateStatsCache(c.env);

  return c.json({ success: true });
});

// POST /admin/api/server-notice - Send server notice to user
app.post('/admin/api/server-notice', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { user_id, message } = body;
  if (!user_id || !message) {
    return Errors.missingParam('user_id and message required').toResponse();
  }

  // Create server notice as to-device message
  const serverName = c.env.SERVER_NAME;
  const serverUserId = `@server:${serverName}`;
  const messageId = `notice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Get all devices for user
  const devices = await db.prepare(`
    SELECT device_id FROM devices WHERE user_id = ?
  `).bind(user_id).all<{ device_id: string }>();

  // Get next stream position
  await db.prepare(`
    UPDATE stream_positions SET position = position + 1 WHERE stream_name = 'to_device'
  `).run();
  const posResult = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = 'to_device'
  `).first<{ position: number }>();
  const streamPosition = posResult?.position || 1;

  // Send to each device
  for (const device of devices.results) {
    await db.prepare(`
      INSERT INTO to_device_messages (
        recipient_user_id, recipient_device_id, sender_user_id,
        event_type, content, message_id, stream_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      user_id,
      device.device_id,
      serverUserId,
      'm.server_notice',
      JSON.stringify({
        msgtype: 'm.server_notice',
        body: message,
        admin_contact: `@admin:${serverName}`,
      }),
      messageId,
      streamPosition
    ).run();
  }

  return c.json({ success: true, devices_notified: devices.results.length });
});

// GET /admin/api/audit - Recent admin audit log entries (paginated)
//
// Defaults to the most recent 100 entries. Filterable by actor, target, and
// action. The log is append-only at the application level; the table has no
// DELETE/UPDATE codepath in src/.
app.get('/admin/api/audit', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;

  const limit = Math.max(1, Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 500));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);
  const actor = c.req.query('actor') || null;
  const target = c.req.query('target') || null;
  const action = c.req.query('action') || null;

  const conds: string[] = [];
  const params: any[] = [];
  if (actor) { conds.push('actor_user_id = ?'); params.push(actor); }
  if (target) { conds.push('target = ?'); params.push(target); }
  if (action) { conds.push('action = ?'); params.push(action); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = await db.prepare(
    `SELECT id, ts, actor_user_id, action, target, ip, success, details
     FROM admin_audit_log ${where}
     ORDER BY ts DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all<{
    id: number;
    ts: number;
    actor_user_id: string;
    action: string;
    target: string | null;
    ip: string | null;
    success: number;
    details: string | null;
  }>();

  const totalRow = await db.prepare(
    `SELECT COUNT(*) as count FROM admin_audit_log ${where}`,
  ).bind(...params).first<{ count: number }>();

  return c.json({
    entries: rows.results.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor_user_id: r.actor_user_id,
      action: r.action,
      target: r.target,
      ip: r.ip,
      success: r.success === 1,
      details: r.details ? safeParseJson(r.details) : null,
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// GET /admin/api/registration - Get registration status (via AdminDurableObject)
app.get('/admin/api/registration', requireAuth(), requireAdmin, async (c) => {
  const adminDO = getAdminDO(c.env);
  const response = await adminDO.fetch('http://internal/config');
  const config = await response.json() as { registration_enabled: boolean };

  return c.json({
    enabled: config.registration_enabled,
  }, 200, { 'Cache-Control': 'no-store' });
});

// PUT /admin/api/registration - Toggle registration (via AdminDurableObject)
app.put('/admin/api/registration', requireAuth(), requireAdmin, async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { enabled } = body;
  if (typeof enabled !== 'boolean') {
    return Errors.missingParam('enabled (boolean) required').toResponse();
  }

  const adminDO = getAdminDO(c.env);
  const response = await adminDO.fetch('http://internal/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registration_enabled: enabled }),
  });

  if (!response.ok) {
    await logAdminAction(c, {
      action: 'config.registration.update',
      success: false,
      details: { enabled },
    });
    return new Response('Failed to update config', { status: 500 });
  }

  await logAdminAction(c, {
    action: 'config.registration.update',
    details: { enabled },
  });

  return c.json({ success: true, enabled });
});

// POST /admin/api/users/:userId/login-token - Generate a one-time login token for QR code auth
app.post('/admin/api/users/:userId/login-token', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  // Verify user exists and is not deactivated
  const user = await getUserById(db, userId);
  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }
  if (user.is_deactivated) {
    return c.json({ errcode: 'M_USER_DEACTIVATED', error: 'User is deactivated' }, 400);
  }

  // Parse optional TTL from request body (default 5 minutes — audit 010.6:
  // login tokens are bearer credentials and should be short-lived by default)
  let ttlMinutes = 5;
  try {
    const body = await c.req.json();
    if (body.ttl_minutes && typeof body.ttl_minutes === 'number') {
      ttlMinutes = Math.min(Math.max(body.ttl_minutes, 1), 60); // 1-60 minutes
    }
  } catch {
    // No body or invalid JSON, use defaults
  }

  // Generate login token
  const loginToken = await generateLoginToken();
  const tokenHash = await hashToken(loginToken);
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;

  // Store in KV with TTL
  await c.env.SESSIONS.put(
    `login_token:${tokenHash}`,
    JSON.stringify({
      user_id: userId,
      expires_at: expiresAt,
    }),
    {
      expirationTtl: ttlMinutes * 60, // KV TTL in seconds
    }
  );

  // Build the QR URL that users will scan
  const protocol = c.req.url.startsWith('https') ? 'https' : 'https'; // Always use https for production
  const host = c.req.header('host') || c.env.SERVER_NAME;
  const qrUrl = `${protocol}://${host}/login/qr/${loginToken}`;

  // Never let intermediaries or the browser cache a response carrying a live
  // login token (audit 010.6), and record the issuance in the admin audit log.
  c.header('Cache-Control', 'no-store');
  await logAdminAction(c, {
    action: 'user.login-token.create',
    target: userId,
    details: { ttl_seconds: ttlMinutes * 60, expires_at: expiresAt },
  });

  return c.json({
    success: true,
    token: loginToken,
    qr_url: qrUrl,
    expires_at: expiresAt,
    ttl_seconds: ttlMinutes * 60,
    user_id: userId,
    homeserver: c.env.SERVER_NAME,
  });
});

// ============================================
// Identity Provider (IdP) Management Endpoints
// ============================================

/** Validate the explicitly configured endpoints of a non-OIDC (OAuth 2.0) provider. */
function validateOAuth2Endpoints(endpoints: {
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  userinfo_endpoint?: string | null;
  emails_endpoint?: string | null;
}): string | null {
  const required: Array<[string, string | null | undefined]> = [
    ['authorization_endpoint', endpoints.authorization_endpoint],
    ['token_endpoint', endpoints.token_endpoint],
    ['userinfo_endpoint', endpoints.userinfo_endpoint],
  ];
  for (const [field, value] of required) {
    if (!value || typeof value !== 'string') {
      return `${field} is required for OAuth 2.0 providers`;
    }
    try {
      new URL(value);
    } catch {
      return `${field} must be a valid URL`;
    }
  }
  if (endpoints.emails_endpoint) {
    try {
      new URL(endpoints.emails_endpoint);
    } catch {
      return 'emails_endpoint must be a valid URL';
    }
  }
  return null;
}

interface IdPProvider {
  id: string;
  name: string;
  issuer_url: string;
  provider_type: string;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  userinfo_endpoint: string | null;
  emails_endpoint: string | null;
  client_id: string;
  client_secret_encrypted: string;
  scopes: string;
  enabled: number;
  auto_create_users: number;
  username_claim: string;
  display_order: number;
  icon_url: string | null;
  created_at: number;
  updated_at: number;
}

// GET /admin/api/idp/providers - List all IdP providers
app.get('/admin/api/idp/providers', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT id, name, issuer_url, client_id, scopes, provider_type,
           authorization_endpoint, token_endpoint, userinfo_endpoint, emails_endpoint,
           enabled, auto_create_users,
           username_claim, display_order, icon_url, created_at, updated_at
    FROM idp_providers
    ORDER BY display_order ASC, name ASC
  `).all<Omit<IdPProvider, 'client_secret_encrypted'>>();

  // Get user counts for each provider
  const providers = await Promise.all(result.results.map(async (p) => {
    const countResult = await db.prepare(`
      SELECT COUNT(*) as count FROM idp_user_links WHERE provider_id = ?
    `).bind(p.id).first<{ count: number }>();

    return {
      ...p,
      enabled: p.enabled === 1,
      auto_create_users: p.auto_create_users === 1,
      linked_users: countResult?.count || 0,
    };
  }));

  return c.json({ providers });
});

// POST /admin/api/idp/providers - Create new IdP provider
app.post('/admin/api/idp/providers', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const {
    name, issuer_url, client_id, client_secret, scopes, auto_create_users, username_claim, icon_url,
    provider_type, authorization_endpoint, token_endpoint, userinfo_endpoint, emails_endpoint,
  } = body;

  // OIDC remains the default; a non-OIDC provider must declare its type explicitly.
  const effectiveProviderType = provider_type || 'oidc';
  if (effectiveProviderType !== 'oidc' && effectiveProviderType !== 'oauth2') {
    return c.json({ errcode: 'M_INVALID_PARAM', error: 'provider_type must be either oidc or oauth2' }, 400);
  }
  const isOAuth2 = effectiveProviderType === 'oauth2';

  // Validate required fields
  if (!name || !issuer_url || !client_id || !client_secret) {
    return Errors.missingParam('name, issuer_url, client_id, and client_secret are required').toResponse();
  }

  if (isOAuth2) {
    // GitHub has no discovery document, so validate the configured endpoints directly.
    const endpointError = validateOAuth2Endpoints({
      authorization_endpoint, token_endpoint, userinfo_endpoint, emails_endpoint,
    });
    if (endpointError) {
      return c.json({ errcode: 'M_INVALID_PARAM', error: endpointError }, 400);
    }
  } else {
    // Validate issuer URL by fetching discovery document
    try {
      await fetchOIDCDiscovery(issuer_url);
    } catch (err) {
      console.error('[admin] OIDC discovery fetch failed:', err);
      return c.json({
        errcode: 'M_INVALID_PARAM',
        error: 'Failed to fetch OIDC discovery from issuer. Check the issuer URL is correct and accessible.',
      }, 400);
    }
  }

  // Generate ID and encrypt secret
  const id = await generateOpaqueId(12);
  const encryptedSecret = await encryptSecret(client_secret, c.env);

  try {
    await db.prepare(`
      INSERT INTO idp_providers (id, name, issuer_url, client_id, client_secret_encrypted, scopes,
                                  enabled, auto_create_users, username_claim, icon_url, created_at, updated_at,
                                  provider_type, authorization_endpoint, token_endpoint, userinfo_endpoint, emails_endpoint)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      name,
      issuer_url.replace(/\/$/, ''), // Normalize URL
      client_id,
      encryptedSecret,
      scopes || (isOAuth2 ? 'read:user user:email' : 'openid profile email'),
      auto_create_users !== false ? 1 : 0,
      username_claim || (isOAuth2 ? 'preferred_username' : 'email'),
      icon_url || null,
      Date.now(),
      Date.now(),
      effectiveProviderType,
      authorization_endpoint || null,
      token_endpoint || null,
      userinfo_endpoint || null,
      emails_endpoint || null
    ).run();

    return c.json({
      success: true,
      id,
      message: 'Identity provider created successfully',
    });
  } catch (err) {
    console.error('Failed to create IdP:', err);
    return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to create identity provider' }, 500);
  }
});

// GET /admin/api/idp/providers/:id - Get IdP provider details
app.get('/admin/api/idp/providers/:id', requireAuth(), requireAdmin, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const provider = await db.prepare(`
    SELECT id, name, issuer_url, client_id, scopes, provider_type,
           authorization_endpoint, token_endpoint, userinfo_endpoint, emails_endpoint,
           enabled, auto_create_users,
           username_claim, display_order, icon_url, created_at, updated_at
    FROM idp_providers WHERE id = ?
  `).bind(id).first<Omit<IdPProvider, 'client_secret_encrypted'>>();

  if (!provider) {
    return Errors.notFound('Identity provider not found').toResponse();
  }

  // Get linked users
  const links = await db.prepare(`
    SELECT l.id, l.external_id, l.user_id, l.external_email, l.external_name, l.created_at, l.last_login_at
    FROM idp_user_links l
    WHERE l.provider_id = ?
    ORDER BY l.last_login_at DESC
    LIMIT 100
  `).bind(id).all<{
    id: number;
    external_id: string;
    user_id: string;
    external_email: string | null;
    external_name: string | null;
    created_at: number;
    last_login_at: number | null;
  }>();

  return c.json({
    ...provider,
    enabled: provider.enabled === 1,
    auto_create_users: provider.auto_create_users === 1,
    linked_users: links.results,
  });
});

// PUT /admin/api/idp/providers/:id - Update IdP provider
app.put('/admin/api/idp/providers/:id', requireAuth(), requireAdmin, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  let body: any;

  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  // Check provider exists. Keep this exact legacy query shape: other D1 stubs
  // recognize only "SELECT id FROM idp_providers WHERE id = ?" for the lookup.
  const existing = await db.prepare('SELECT id FROM idp_providers WHERE id = ?')
    .bind(id).first<{ id: string }>();
  if (!existing) {
    return Errors.notFound('Identity provider not found').toResponse();
  }

  // provider_type is needed to preserve an existing OAuth2 provider's type when
  // the request omits it; read it separately so the existence check above stays
  // compatible with those stubs.
  const stored = await db.prepare('SELECT id, provider_type FROM idp_providers WHERE id = ?')
    .bind(id).first<{ provider_type: string | null }>();

  const effectiveProviderType = body.provider_type ?? stored?.provider_type ?? 'oidc';
  if (effectiveProviderType !== 'oidc' && effectiveProviderType !== 'oauth2') {
    return c.json({ errcode: 'M_INVALID_PARAM', error: 'provider_type must be either oidc or oauth2' }, 400);
  }
  const isOAuth2 = effectiveProviderType === 'oauth2';

  const updates: string[] = [];
  const values: any[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.issuer_url !== undefined) {
    if (isOAuth2) {
      // OAuth 2.0 issuers (e.g. github.com) have no discovery document.
      try {
        new URL(body.issuer_url);
      } catch {
        return c.json({ errcode: 'M_INVALID_PARAM', error: 'issuer_url must be a valid URL' }, 400);
      }
    } else {
      // Validate new issuer URL
      try {
        await fetchOIDCDiscovery(body.issuer_url);
      } catch (err) {
        console.error('[admin] OIDC discovery fetch failed on update:', err);
        return c.json({
          errcode: 'M_INVALID_PARAM',
          error: 'Failed to fetch OIDC discovery from issuer. Check the issuer URL is correct and accessible.',
        }, 400);
      }
    }
    updates.push('issuer_url = ?');
    values.push(body.issuer_url.replace(/\/$/, ''));
  }
  if (body.client_id !== undefined) {
    updates.push('client_id = ?');
    values.push(body.client_id);
  }
  if (body.client_secret !== undefined) {
    const encryptedSecret = await encryptSecret(body.client_secret, c.env);
    updates.push('client_secret_encrypted = ?');
    values.push(encryptedSecret);
  }
  if (body.scopes !== undefined) {
    updates.push('scopes = ?');
    values.push(body.scopes);
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(body.enabled ? 1 : 0);
  }
  if (body.auto_create_users !== undefined) {
    updates.push('auto_create_users = ?');
    values.push(body.auto_create_users ? 1 : 0);
  }
  if (body.username_claim !== undefined) {
    updates.push('username_claim = ?');
    values.push(body.username_claim);
  }
  if (body.display_order !== undefined) {
    updates.push('display_order = ?');
    values.push(body.display_order);
  }
  if (body.icon_url !== undefined) {
    updates.push('icon_url = ?');
    values.push(body.icon_url || null);
  }
  if (body.provider_type !== undefined) {
    updates.push('provider_type = ?');
    values.push(effectiveProviderType);
  }
  if (body.authorization_endpoint !== undefined) {
    updates.push('authorization_endpoint = ?');
    values.push(body.authorization_endpoint || null);
  }
  if (body.token_endpoint !== undefined) {
    updates.push('token_endpoint = ?');
    values.push(body.token_endpoint || null);
  }
  if (body.userinfo_endpoint !== undefined) {
    updates.push('userinfo_endpoint = ?');
    values.push(body.userinfo_endpoint || null);
  }
  if (body.emails_endpoint !== undefined) {
    updates.push('emails_endpoint = ?');
    values.push(body.emails_endpoint || null);
  }

  if (updates.length === 0) {
    return c.json({ success: true, message: 'No changes' });
  }

  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  await db.prepare(`
    UPDATE idp_providers SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return c.json({ success: true, message: 'Identity provider updated' });
});

// DELETE /admin/api/idp/providers/:id - Delete IdP provider
app.delete('/admin/api/idp/providers/:id', requireAuth(), requireAdmin, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  // Check provider exists
  const existing = await db.prepare('SELECT id FROM idp_providers WHERE id = ?').bind(id).first();
  if (!existing) {
    return Errors.notFound('Identity provider not found').toResponse();
  }

  // Delete provider (cascades to user links)
  await db.prepare('DELETE FROM idp_providers WHERE id = ?').bind(id).run();

  return c.json({ success: true, message: 'Identity provider deleted' });
});

// DELETE /admin/api/idp/providers/:id/links/:linkId - Remove a user link
app.delete('/admin/api/idp/providers/:id/links/:linkId', requireAuth(), requireAdmin, async (c) => {
  const providerId = c.req.param('id');
  const linkId = c.req.param('linkId');
  const db = c.env.DB;

  await db.prepare(`
    DELETE FROM idp_user_links WHERE id = ? AND provider_id = ?
  `).bind(linkId, providerId).run();

  return c.json({ success: true, message: 'User link removed' });
});

// POST /admin/api/idp/providers/:id/test - Test IdP connection
app.post('/admin/api/idp/providers/:id/test', requireAuth(), requireAdmin, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  // Keep the exact legacy query for the existence check and issuer URL: other
  // D1 stubs recognize only "SELECT issuer_url FROM idp_providers WHERE id = ?".
  const base = await db.prepare('SELECT issuer_url FROM idp_providers WHERE id = ?')
    .bind(id).first<{ issuer_url: string }>();

  if (!base) {
    return Errors.notFound('Identity provider not found').toResponse();
  }

  // OAuth2 needs the configured endpoints and provider type; fetch them in an
  // additive query so the legacy lookup above remains unchanged.
  const details = await db.prepare(`
    SELECT issuer_url, provider_type, authorization_endpoint, token_endpoint,
           userinfo_endpoint, emails_endpoint
    FROM idp_providers WHERE id = ?
  `).bind(id).first<{
    provider_type: string | null;
    authorization_endpoint: string | null;
    token_endpoint: string | null;
    userinfo_endpoint: string | null;
    emails_endpoint: string | null;
  }>();
  const provider = { ...base, ...(details ?? {}) };

  const isOAuth2 = (provider.provider_type ?? 'oidc') === 'oauth2';

  try {
    if (isOAuth2) {
      // GitHub has no discovery document — verify the configured endpoints instead.
      const endpointError = validateOAuth2Endpoints({
        authorization_endpoint: provider.authorization_endpoint,
        token_endpoint: provider.token_endpoint,
        userinfo_endpoint: provider.userinfo_endpoint,
        emails_endpoint: provider.emails_endpoint,
      });
      if (endpointError) {
        return c.json({ success: false, error: endpointError }, 400);
      }
      const endpoints_found = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'];
      if (provider.emails_endpoint) endpoints_found.push('emails_endpoint');
      return c.json({
        success: true,
        message: 'Connection successful',
        endpoints_found,
      });
    }

    const discovery = await fetchOIDCDiscovery(provider.issuer_url);
    return c.json({
      success: true,
      message: 'Connection successful',
      endpoints_found: ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri'],
      discovery: {
        issuer: discovery.issuer,
        authorization_endpoint: discovery.authorization_endpoint,
        token_endpoint: discovery.token_endpoint,
        userinfo_endpoint: discovery.userinfo_endpoint,
        jwks_uri: discovery.jwks_uri,
      },
    });
  } catch (err) {
    return c.json({
      success: false,
      error: String(err),
    }, 400);
  }
});

// ============================================
// E2EE Key Debug Endpoint (Admin Only)
// ============================================

// GET /admin/api/users/:userId/keys - Debug E2EE key state for a user
app.get('/admin/api/users/:userId/keys', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  // Get cross-signing keys from D1
  const crossSigningKeys = await db.prepare(`
    SELECT key_type, key_id, key_data FROM cross_signing_keys WHERE user_id = ?
  `).bind(userId).all<{ key_type: string; key_id: string; key_data: string }>();

  // Get signatures from D1
  const signatures = await db.prepare(`
    SELECT key_id, signer_user_id, signer_key_id, signature FROM cross_signing_signatures WHERE user_id = ?
  `).bind(userId).all<{ key_id: string; signer_user_id: string; signer_key_id: string; signature: string }>();

  // Get devices
  const devices = await db.prepare(`
    SELECT device_id, display_name FROM devices WHERE user_id = ?
  `).bind(userId).all<{ device_id: string; display_name: string | null }>();

  // Get device keys from KV
  const deviceKeys: Record<string, any> = {};
  for (const device of devices.results) {
    const keyData = await c.env.DEVICE_KEYS.get(`device:${userId}:${device.device_id}`);
    if (keyData) {
      deviceKeys[device.device_id] = JSON.parse(keyData);
    }
  }

  // Parse cross-signing keys
  const parsedCSKeys: Record<string, any> = {};
  for (const key of crossSigningKeys.results) {
    parsedCSKeys[key.key_type] = {
      key_id: key.key_id,
      data: JSON.parse(key.key_data),
    };
  }

  // Verification status check
  const selfSigningKeyId = parsedCSKeys.self_signing?.key_id;
  const verificationStatus: Record<string, { verified: boolean; reason: string }> = {};
  
  for (const device of devices.results) {
    const deviceId = device.device_id;
    const hasSelfSigningSignature = signatures.results.some(
      s => s.key_id === deviceId && s.signer_key_id === selfSigningKeyId
    );
    const deviceKey = deviceKeys[deviceId];
    const hasSignatureInDeviceKey = deviceKey?.signatures?.[userId]?.[selfSigningKeyId] !== undefined;
    
    verificationStatus[deviceId] = {
      verified: hasSelfSigningSignature && hasSignatureInDeviceKey,
      reason: !selfSigningKeyId 
        ? 'No self-signing key' 
        : !hasSelfSigningSignature 
          ? 'No signature in DB' 
          : !hasSignatureInDeviceKey 
            ? 'Signature not in device key object'
            : 'Verified',
    };
  }

  return c.json({
    user_id: userId,
    cross_signing_keys: parsedCSKeys,
    signatures: signatures.results,
    devices: devices.results,
    device_keys: deviceKeys,
    verification_status: verificationStatus,
  });
});

// ============================================
// Matrix Client-Server Admin API Endpoints
// ============================================

// GET /_matrix/client/v3/admin/whois/:userId - Get information about a user's sessions
// Per Matrix spec: admin users can query any user, non-admin users can only query themselves
app.get('/_matrix/client/v3/admin/whois/:userId', requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  // Check if requesting user is admin
  const requestingUser = await getUserById(db, requestingUserId);
  const isAdmin = Boolean(requestingUser?.admin);

  // Non-admin users can only query themselves
  if (!isAdmin && requestingUserId !== targetUserId) {
    return Errors.forbidden('Admin privileges required to query other users').toResponse();
  }

  // Check if target user exists
  const targetUser = await db.prepare(`
    SELECT user_id FROM users WHERE user_id = ?
  `).bind(targetUserId).first<{ user_id: string }>();

  if (!targetUser) {
    return Errors.notFound('User not found').toResponse();
  }

  // Get user's devices with session info
  const devices = await db.prepare(`
    SELECT d.device_id, d.display_name, d.last_seen_ts, d.last_seen_ip,
           a.created_at as session_created_at
    FROM devices d
    LEFT JOIN access_tokens a ON d.user_id = a.user_id AND d.device_id = a.device_id
    WHERE d.user_id = ?
  `).bind(targetUserId).all<{
    device_id: string;
    display_name: string | null;
    last_seen_ts: number | null;
    last_seen_ip: string | null;
    session_created_at: number | null;
  }>();

  // Build devices map in Matrix spec format
  const devicesMap: Record<string, { sessions: Array<{
    connections: Array<{
      ip: string | null;
      last_seen: number | null;
      user_agent?: string;
    }>;
  }> }> = {};

  for (const device of devices.results) {
    devicesMap[device.device_id] = {
      sessions: [{
        connections: [{
          ip: device.last_seen_ip || null,
          last_seen: device.last_seen_ts || null,
        }],
      }],
    };
  }

  return c.json({
    user_id: targetUserId,
    devices: devicesMap,
  });
});

// ============================================
// Synapse-Compatible Admin API Routes
// These routes provide compatibility with Synapse admin tools
// ============================================

// GET /_synapse/admin/v1/server_version - Server version info (Synapse format)
app.get('/_synapse/admin/v1/server_version', requireAuth(), requireAdmin, async (c) => {
  return c.json({
    server_version: c.env.SERVER_VERSION,
    python_version: 'N/A (Cloudflare Workers)',
  });
});

// GET /_synapse/admin/v2/users - List users (Synapse format)
app.get('/_synapse/admin/v2/users', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
  const from = parseInt(c.req.query('from') || '0');
  const guests = c.req.query('guests') !== 'false';
  const deactivated = c.req.query('deactivated') === 'true';
  const name = c.req.query('name'); // Search by name

  let query = `
    SELECT user_id as name, display_name as displayname, is_guest, is_deactivated as deactivated, admin, created_at as creation_ts
    FROM users WHERE 1=1
  `;
  const params: any[] = [];

  if (!guests) {
    query += ' AND is_guest = 0';
  }
  if (deactivated) {
    query += ' AND is_deactivated = 1';
  }
  if (name) {
    query += ' AND (localpart LIKE ? OR display_name LIKE ?)';
    params.push(`%${name}%`, `%${name}%`);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, from);

  const users = await db.prepare(query).bind(...params).all();
  const total = await db.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>();

  return c.json({
    users: users.results,
    next_token: from + limit < (total?.count || 0) ? String(from + limit) : undefined,
    total: total?.count || 0,
  });
});

// GET /_synapse/admin/v2/users/:userId - User details (Synapse format)
app.get('/_synapse/admin/v2/users/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  const user = await db.prepare(`
    SELECT user_id as name, display_name as displayname, avatar_url, is_guest,
           is_deactivated as deactivated, admin, created_at as creation_ts,
           locked, suspended
    FROM users WHERE user_id = ?
  `).bind(userId).first<{
    locked?: number;
    suspended?: number;
  }>();

  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  // Get user's threepids (email addresses, phone numbers)
  // Note: We may not have a full threepid table, returning empty for now
  const threepids: any[] = [];

  // MSC4323: surface the real moderation state (Synapse's field shape).
  const locked = user.locked === 1;
  const suspended = user.suspended === 1;
  const { locked: _locked, suspended: _suspended, ...userFields } = user;

  return c.json({
    ...userFields,
    threepids,
    consent_version: null,
    consent_server_notice_sent: null,
    appservice_id: null,
    consent_ts: null,
    user_type: null,
    is_shadow_banned: false,
    locked,
    suspended,
  });
});

// POST /_synapse/admin/v1/deactivate/:userId - Deactivate user (Synapse format)
app.post('/_synapse/admin/v1/deactivate/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  // Check user exists
  const user = await db.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(userId).first();
  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  // Deactivate user
  await db.prepare('UPDATE users SET is_deactivated = 1, updated_at = ? WHERE user_id = ?')
    .bind(Date.now(), userId).run();

  // Revoke all access tokens
  await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  await logAdminAction(c, { action: 'user.deactivate', target: userId });

  return c.json({ id_server_unbind_result: 'success' });
});

// POST /_synapse/admin/v1/reset_password/:userId - Reset password (Synapse format)
app.post('/_synapse/admin/v1/reset_password/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { new_password, logout_devices } = body;
  if (!new_password) {
    return Errors.missingParam('new_password').toResponse();
  }

  // Check user exists
  const user = await db.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(userId).first();
  if (!user) {
    return Errors.notFound('User not found').toResponse();
  }

  // Hash and update password
  const { hashPassword } = await import('../utils/crypto');
  const passwordHash = await hashPassword(new_password);

  await db.prepare(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?'
  ).bind(passwordHash, Date.now(), userId).run();

  // Optionally revoke all access tokens (default: true per Synapse behavior)
  if (logout_devices !== false) {
    await db.prepare('DELETE FROM access_tokens WHERE user_id = ?').bind(userId).run();
  }

  await logAdminAction(c, {
    action: 'user.reset_password',
    target: userId,
    details: { logout_devices: logout_devices !== false },
  });

  return c.json({});
});

// GET /_synapse/admin/v1/rooms - List rooms (Synapse format)
app.get('/_synapse/admin/v1/rooms', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
  const from = parseInt(c.req.query('from') || '0');
  const orderBy = c.req.query('order_by') || 'name';
  const dir = c.req.query('dir') === 'b' ? 'DESC' : 'ASC';
  const searchTerm = c.req.query('search_term');

  // Build query
  let query = `
    SELECT r.room_id, r.room_version, r.is_public as public, r.creator_id as creator, r.created_at,
           (SELECT COUNT(*) FROM room_memberships WHERE room_id = r.room_id AND membership = 'join') as joined_members,
           (SELECT COUNT(*) FROM room_memberships WHERE room_id = r.room_id) as joined_local_members,
           (SELECT COUNT(*) FROM events WHERE room_id = r.room_id) as state_events
    FROM rooms r
  `;
  const params: any[] = [];

  if (searchTerm) {
    query += ` WHERE r.room_id LIKE ?`;
    params.push(`%${searchTerm}%`);
  }

  // Order by (simplified)
  const orderColumn = orderBy === 'joined_members' ? 'joined_members' : 'r.created_at';
  query += ` ORDER BY ${orderColumn} ${dir} LIMIT ? OFFSET ?`;
  params.push(limit, from);

  const rooms = await db.prepare(query).bind(...params).all();

  // Get room names and other metadata
  const roomsWithDetails = await Promise.all(rooms.results.map(async (room: any) => {
    const nameEvent = await db.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
    `).bind(room.room_id).first<{ content: string }>();

    const canonicalAliasEvent = await db.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
    `).bind(room.room_id).first<{ content: string }>();

    const topicEvent = await db.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'
    `).bind(room.room_id).first<{ content: string }>();

    const avatarEvent = await db.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
    `).bind(room.room_id).first<{ content: string }>();

    return {
      room_id: room.room_id,
      name: nameEvent ? JSON.parse(nameEvent.content).name : null,
      canonical_alias: canonicalAliasEvent ? JSON.parse(canonicalAliasEvent.content).alias : null,
      topic: topicEvent ? JSON.parse(topicEvent.content).topic : null,
      avatar: avatarEvent ? JSON.parse(avatarEvent.content).url : null,
      joined_members: room.joined_members || 0,
      joined_local_members: room.joined_local_members || 0,
      version: room.room_version,
      creator: room.creator,
      encryption: null, // Would need to check m.room.encryption state
      federatable: true,
      public: Boolean(room.public),
      join_rules: null, // Would need to check m.room.join_rules state
      guest_access: null, // Would need to check m.room.guest_access state
      history_visibility: null, // Would need to check m.room.history_visibility state
      state_events: room.state_events || 0,
    };
  }));

  const total = await db.prepare('SELECT COUNT(*) as count FROM rooms').first<{ count: number }>();

  return c.json({
    rooms: roomsWithDetails,
    offset: from,
    total_rooms: total?.count || 0,
    next_batch: from + limit < (total?.count || 0) ? from + limit : undefined,
    prev_batch: from > 0 ? Math.max(0, from - limit) : undefined,
  });
});

// GET /_synapse/admin/v1/rooms/:roomId - Room details (Synapse format)
app.get('/_synapse/admin/v1/rooms/:roomId', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;

  const room = await db.prepare(`
    SELECT room_id, room_version, is_public, creator_id, created_at
    FROM rooms WHERE room_id = ?
  `).bind(roomId).first();

  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Get room state
  const nameEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'
  `).bind(roomId).first<{ content: string }>();

  const topicEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'
  `).bind(roomId).first<{ content: string }>();

  const canonicalAliasEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.canonical_alias'
  `).bind(roomId).first<{ content: string }>();

  const avatarEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.avatar'
  `).bind(roomId).first<{ content: string }>();

  const joinRulesEvent = await db.prepare(`
    SELECT e.content FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.join_rules'
  `).bind(roomId).first<{ content: string }>();

  // Get member count
  const memberCount = await db.prepare(`
    SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'
  `).bind(roomId).first<{ count: number }>();

  // Get state event count
  const stateCount = await db.prepare(`
    SELECT COUNT(*) as count FROM room_state WHERE room_id = ?
  `).bind(roomId).first<{ count: number }>();

  return c.json({
    room_id: roomId,
    name: nameEvent ? JSON.parse(nameEvent.content).name : null,
    topic: topicEvent ? JSON.parse(topicEvent.content).topic : null,
    canonical_alias: canonicalAliasEvent ? JSON.parse(canonicalAliasEvent.content).alias : null,
    avatar: avatarEvent ? JSON.parse(avatarEvent.content).url : null,
    joined_members: memberCount?.count || 0,
    joined_local_members: memberCount?.count || 0,
    version: (room as any).room_version,
    creator: (room as any).creator_id,
    public: Boolean((room as any).is_public),
    join_rules: joinRulesEvent ? JSON.parse(joinRulesEvent.content).join_rule : null,
    state_events: stateCount?.count || 0,
    federatable: true,
  });
});

// GET /_synapse/admin/v1/federation/destinations - Federation destinations (Synapse format)
app.get('/_synapse/admin/v1/federation/destinations', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
  const from = parseInt(c.req.query('from') || '0');

  const servers = await db.prepare(`
    SELECT server_name as destination, valid_until_ts, last_successful_fetch as last_successful_stream_ordering,
           retry_count as failure_ts, retry_count
    FROM servers
    ORDER BY last_successful_fetch DESC
    LIMIT ? OFFSET ?
  `).bind(limit, from).all();

  const total = await db.prepare('SELECT COUNT(*) as count FROM servers').first<{ count: number }>();

  return c.json({
    destinations: servers.results.map((s: any) => ({
      destination: s.destination,
      retry_last_ts: s.failure_ts ? Date.now() - 60000 * s.retry_count : 0,
      retry_interval: s.retry_count * 60000,
      failure_ts: s.failure_ts > 0 ? Date.now() - 60000 * s.retry_count : null,
      last_successful_stream_ordering: s.last_successful_stream_ordering,
    })),
    total: total?.count || 0,
    next_token: from + limit < (total?.count || 0) ? String(from + limit) : undefined,
  });
});

// GET /_synapse/admin/v1/event_reports - Event reports (Synapse format)
app.get('/_synapse/admin/v1/event_reports', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const limit = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
  const from = parseInt(c.req.query('from') || '0');
  const dir = c.req.query('dir') === 'f' ? 'ASC' : 'DESC';
  const roomId = c.req.query('room_id');
  const userId = c.req.query('user_id');

  let query = `
    SELECT cr.id, cr.reporter_user_id as user_id, cr.room_id, cr.event_id,
           cr.reason, cr.score, cr.created_at as received_ts,
           e.sender as sender, e.content
    FROM content_reports cr
    LEFT JOIN events e ON cr.event_id = e.event_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (roomId) {
    query += ' AND cr.room_id = ?';
    params.push(roomId);
  }
  if (userId) {
    query += ' AND cr.reporter_user_id = ?';
    params.push(userId);
  }

  query += ` ORDER BY cr.created_at ${dir} LIMIT ? OFFSET ?`;
  params.push(limit, from);

  const reports = await db.prepare(query).bind(...params).all();

  const total = await db.prepare('SELECT COUNT(*) as count FROM content_reports').first<{ count: number }>();

  return c.json({
    event_reports: reports.results.map((r: any) => ({
      id: r.id,
      received_ts: r.received_ts,
      room_id: r.room_id,
      user_id: r.user_id,
      reason: r.reason,
      score: r.score,
      sender: r.sender,
      event_id: r.event_id,
      event_json: r.content ? { content: JSON.parse(r.content) } : null,
    })),
    total: total?.count || 0,
    next_token: from + limit < (total?.count || 0) ? String(from + limit) : undefined,
  });
});

// DELETE /_synapse/admin/v1/rooms/:roomId - Delete room (Synapse format)
app.delete('/_synapse/admin/v1/rooms/:roomId', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;

  // Check room exists
  const room = await db.prepare('SELECT room_id FROM rooms WHERE room_id = ?').bind(roomId).first();
  if (!room) {
    return Errors.notFound('Room not found').toResponse();
  }

  // Delete in order (foreign key constraints)
  await db.prepare('DELETE FROM room_aliases WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM room_memberships WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM room_state WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM events WHERE room_id = ?').bind(roomId).run();
  await db.prepare('DELETE FROM rooms WHERE room_id = ?').bind(roomId).run();

  // Invalidate stats cache
  await invalidateStatsCache(c.env);

  return c.json({
    kicked_users: [],
    failed_to_kick_users: [],
    local_aliases: [],
    new_room_id: null,
  });
});

// PUT /_synapse/admin/v2/users/:userId - Create or modify user (Synapse format)
app.put('/_synapse/admin/v2/users/:userId', requireAuth(), requireAdmin, async (c) => {
  const userId = decodeURIComponent(c.req.param('userId'));
  const db = c.env.DB;

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const { password, displayname, admin, deactivated, avatar_url } = body;

  // Check if user exists
  const existingUser = await db.prepare('SELECT user_id FROM users WHERE user_id = ?').bind(userId).first();

  if (existingUser) {
    // Update existing user
    const updates: string[] = [];
    const params: any[] = [];

    if (displayname !== undefined) {
      updates.push('display_name = ?');
      params.push(displayname);
    }
    if (admin !== undefined) {
      updates.push('admin = ?');
      params.push(admin ? 1 : 0);
    }
    if (deactivated !== undefined) {
      updates.push('is_deactivated = ?');
      params.push(deactivated ? 1 : 0);
    }
    if (avatar_url !== undefined) {
      updates.push('avatar_url = ?');
      params.push(avatar_url);
    }
    if (password !== undefined) {
      const { hashPassword } = await import('../utils/crypto');
      const passwordHash = await hashPassword(password);
      updates.push('password_hash = ?');
      params.push(passwordHash);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(Date.now());
      params.push(userId);

      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`).bind(...params).run();
    }

    return c.json({
      name: userId,
      displayname,
      admin: admin !== undefined ? admin : null,
      deactivated: deactivated !== undefined ? deactivated : null,
    });
  } else {
    // Create new user
    if (!password) {
      return Errors.missingParam('password required for new user').toResponse();
    }

    // Extract localpart from user_id
    const match = userId.match(/^@([^:]+):/);
    if (!match) {
      return c.json({ errcode: 'M_INVALID_USERNAME', error: 'Invalid user ID format' }, 400);
    }
    const localpart = match[1];

    const { hashPassword } = await import('../utils/crypto');
    const passwordHash = await hashPassword(password);

    await db.prepare(`
      INSERT INTO users (user_id, localpart, password_hash, display_name, avatar_url, admin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      localpart,
      passwordHash,
      displayname || null,
      avatar_url || null,
      admin ? 1 : 0,
      Date.now(),
      Date.now()
    ).run();

    // Invalidate stats cache
    await invalidateStatsCache(c.env);

    return c.json({
      name: userId,
      displayname: displayname || null,
      admin: admin || false,
      deactivated: false,
    });
  }
});

// ============================================
// Analytics Engine Query Endpoints
// ============================================

// Get request metrics from Analytics Engine
app.get('/_matrix/client/v3/admin/analytics/requests', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const period = c.req.query('period') || '1h';

  // Calculate time range
  const now = Date.now();
  const periodMs: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  const rangeMs = periodMs[period] || periodMs['1h'];
  const since = now - rangeMs;

  // Query from D1 events as a proxy for request activity
  const totalRequests = await db.prepare(`
    SELECT COUNT(*) as count FROM events WHERE origin_server_ts > ?
  `).bind(since).first<{ count: number }>();

  const byType = await db.prepare(`
    SELECT event_type, COUNT(*) as count FROM events
    WHERE origin_server_ts > ?
    GROUP BY event_type ORDER BY count DESC LIMIT 20
  `).bind(since).all<{ event_type: string; count: number }>();

  const activeUsers = await db.prepare(`
    SELECT COUNT(DISTINCT sender) as count FROM events WHERE origin_server_ts > ?
  `).bind(since).first<{ count: number }>();

  const activeRooms = await db.prepare(`
    SELECT COUNT(DISTINCT room_id) as count FROM events WHERE origin_server_ts > ?
  `).bind(since).first<{ count: number }>();

  return c.json({
    period,
    since: new Date(since).toISOString(),
    total_events: totalRequests?.count || 0,
    active_users: activeUsers?.count || 0,
    active_rooms: activeRooms?.count || 0,
    events_by_type: byType.results,
  });
});

// Get federation metrics
app.get('/_matrix/client/v3/admin/analytics/federation', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  const period = c.req.query('period') || '24h';

  const now = Date.now();
  const periodMs: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  const rangeMs = periodMs[period] || periodMs['24h'];
  const since = now - rangeMs;

  // Get federation event counts (events from remote servers)
  const inboundEvents = await db.prepare(`
    SELECT COUNT(*) as count FROM events
    WHERE origin_server_ts > ? AND sender NOT LIKE ?
  `).bind(since, `%:${c.env.SERVER_NAME}`).first<{ count: number }>();

  const outboundEvents = await db.prepare(`
    SELECT COUNT(*) as count FROM events
    WHERE origin_server_ts > ? AND sender LIKE ?
  `).bind(since, `%:${c.env.SERVER_NAME}`).first<{ count: number }>();

  // Get unique remote servers
  const remoteServers = await db.prepare(`
    SELECT COUNT(DISTINCT server_name) as count FROM known_servers
  `).first<{ count: number }>();

  return c.json({
    period,
    since: new Date(since).toISOString(),
    inbound_events: inboundEvents?.count || 0,
    outbound_events: outboundEvents?.count || 0,
    known_servers: remoteServers?.count || 0,
  });
});

// Backfill a remote room's state (name/create) and full member list without
// requiring a fresh join. Useful when the join snapshot was partial.
app.post('/admin/api/rooms/:roomId/backfill', requireAuth(), requireAdmin, async (c) => {
  const roomId = decodeURIComponent(c.req.param('roomId'));
  const db = c.env.DB;

  let server = c.req.query('server');
  if (!server) {
    const m = roomId.match(/^!.+:(.+)$/);
    server = m ? m[1] : undefined;
  }
  if (!server) {
    const row = await db.prepare(
      `SELECT substr(user_id, instr(user_id, ':') + 1) AS s FROM room_memberships
       WHERE room_id = ? AND user_id NOT LIKE ? LIMIT 1`
    ).bind(roomId, `%:${c.env.SERVER_NAME}`).first<{ s: string }>();
    server = row?.s;
  }
  if (!server) return Errors.invalidParam('server', 'Could not determine a remote server for this room').toResponse();

  // Wire-ID derivation needs the room version (v1-10 redaction rules differ
  // from v11+ for create/power_levels); a version-blind derivation stores
  // phantom IDs nothing references.
  const roomRow = await db.prepare(
    `SELECT room_version FROM rooms WHERE room_id = ?`
  ).bind(roomId).first<{ room_version: string }>();
  const roomVersion = roomRow?.room_version;

  // A resident's /state PDUs carry the IDs every other peer references. For
  // v3+ they omit event_id; derive it with the redaction form the resident
  // used (pre-2023 `origin` events use the legacy keep-list), and prefer an
  // ID already stored locally so a re-sync never mints a phantom duplicate.
  const residentEventId = async (ev: any): Promise<string> => {
    const candidates = typeof ev?.event_id === 'string' && ev.event_id
      ? [ev.event_id as string]
      : await inboundWireEventIdCandidates(ev as Record<string, unknown>, roomVersion);
    for (const candidate of candidates) {
      const stored = await db.prepare(
        `SELECT 1 FROM events WHERE event_id = ?`
      ).bind(candidate).first();
      if (stored) return candidate;
    }
    return candidates[0];
  };

  const storeEv = async (ev: any): Promise<boolean> => {
    if (!ev || typeof ev !== 'object' || !ev.type) return false;
    try {
      const normalized: Record<string, unknown> = { ...ev };
      if (typeof ev.event_id !== 'string' || !ev.event_id) {
        normalized.event_id = await residentEventId(ev);
      }
      if (ev.type === 'm.room.create' && typeof ev.room_id !== 'string') {
        normalized.room_id = `!${String(normalized.event_id).slice(1)}`;
      }
      // State snapshot from the resident: negated stream ordering keeps it
      // out of paginated history (this is state, not conversation).
      await storeEventIdempotent(db, normalized as any, { stateOnly: true });
      if (ev.type === 'm.room.member' && typeof ev.state_key === 'string') {
        const mem = ev.content?.membership;
        if (['join', 'invite', 'leave', 'ban', 'knock'].includes(mem)) {
          await updateMembership(db, roomId, ev.state_key, mem, String(normalized.event_id));
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  let stored = 0;
  let members = 0;
  const diag: Record<string, unknown> = {};
  // Synapse's federation /state requires ?event_id= an event the TARGET server
  // knows; use one authored by that server. There is no /members federation
  // endpoint — current members come from /state.
  const latest = await db.prepare(
    `SELECT event_id FROM events WHERE room_id = ? AND sender LIKE ? ORDER BY stream_ordering DESC LIMIT 1`
  ).bind(roomId, `%:${server}`).first<{ event_id: string }>();
  const stateUrl = `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}${latest ? `?event_id=${encodeURIComponent(latest.event_id)}` : ''}`;
  const stateResp = await federationGet(server, stateUrl, c.env.SERVER_NAME, db, c.env.CACHE);
  diag.state_status = stateResp.status;
  if (stateResp.ok) {
    const data = await stateResp.json() as { pdus?: any[]; auth_chain?: any[] };
    const all = [...(data.auth_chain ?? []), ...(data.pdus ?? [])];
    // Store non-member state (name/create/topic/…) first so the room renders
    // quickly; member events are batched below to avoid per-row round trips.
    for (const ev of all) {
      if (ev?.type === 'm.room.member') continue;
      if (await storeEv(ev)) stored++;
    }
    const memberEvs = all.filter((ev) => ev?.type === 'm.room.member' && typeof ev.state_key === 'string');
    for (let i = 0; i < memberEvs.length; i += 100) {
      const chunk = memberEvs.slice(i, i + 100);
      const stmts = [];
      for (const ev of chunk) {
        const mem = ev.content?.membership;
        if (!['join', 'invite', 'leave', 'ban', 'knock'].includes(mem)) continue;
        // State PDUs for v3+ rooms carry no event_id — use the resident's
        // wire ID (see residentEventId) so a membership row never points at
        // '' or at a phantom derived with the wrong redaction rules.
        let memberId: string;
        try {
          memberId = await residentEventId(ev);
        } catch {
          continue;
        }
        stmts.push(db.prepare(
          `INSERT OR REPLACE INTO room_memberships (room_id, user_id, membership, event_id) VALUES (?, ?, ?, ?)`
        ).bind(roomId, ev.state_key, mem, memberId));
      }
      if (stmts.length) { await db.batch(stmts); members += stmts.length; }
    }
  } else {
    diag.state_body = (await stateResp.text()).slice(0, 200);
  }

  return c.json({ server, stored_state: stored, stored_members: members, diag });
});

// --- Native bots ---

// POST /admin/api/bots - Create a bot user (no password: bots never log in;
// the homeserver acts for them). Optionally joins it to a room.
app.post('/admin/api/bots', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const localpart = String(body.localpart ?? '').toLowerCase();
  const displayName = typeof body.display_name === 'string' ? body.display_name.slice(0, 100) : undefined;
  const kind = body.kind === 'telegram' ? 'telegram' : 'admin';
  const commandPrefix = typeof body.command_prefix === 'string' && body.command_prefix.length <= 16
    ? body.command_prefix
    : '!admin';
  const roomId = typeof body.room_id === 'string' ? body.room_id : undefined;

  if (!/^[a-z0-9._=\-\/+]+$/.test(localpart)) {
    return c.json({ errcode: 'M_INVALID_USERNAME', error: 'Invalid localpart format' }, 400);
  }
  const userId = `@${localpart}:${c.env.SERVER_NAME}`;
  const existing = await db.prepare(`SELECT user_id FROM users WHERE user_id = ?`).bind(userId).first();
  const existingBot = await db.prepare(`SELECT id FROM bots WHERE user_id = ?`).bind(userId).first();
  if (existingBot) {
    return c.json({ errcode: 'M_USER_IN_USE', error: 'Bot already exists' }, 400);
  }

  const { createUser } = await import('../services/database');
  const { createBotRow } = await import('../services/bots');
  if (!existing) {
    // No password: a bot account can never log in through the client API.
    await createUser(db, userId, localpart, null, false);
  }
  if (displayName) {
    await db.prepare(`UPDATE users SET display_name = ? WHERE user_id = ?`).bind(displayName, userId).run();
  }
  const id = await generateOpaqueId(12);
  await createBotRow(db, id, userId, kind, commandPrefix);

  let joined = false;
  if (roomId) {
    // Private rooms need an invite before the bot can join. Invite as the
    // requesting admin (the state path auto-accepts for bots); failures are
    // ignored — public rooms join directly either way.
    try {
      const { performStateEvent } = await import('./rooms');
      await performStateEvent(c.env, roomId, c.get('userId'), 'm.room.member', userId, { membership: 'invite' });
    } catch { /* best-effort */ }
    const { joinBotUserToRoom } = await import('./rooms');
    joined = (await joinBotUserToRoom(c.env, roomId, userId)) !== null;
  }

  await logAdminAction(c, {
    action: 'bot.create',
    target: userId,
    details: { kind, command_prefix: commandPrefix, room_id: roomId ?? null, joined },
  });

  return c.json({ id, user_id: userId, kind, command_prefix: commandPrefix, room_id: roomId ?? null, joined });
});

// GET /admin/api/bots - List bots
app.get('/admin/api/bots', requireAuth(), requireAdmin, async (c) => {
  const { listBots } = await import('../services/bots');
  return c.json({ bots: await listBots(c.env.DB) });
});

// POST /admin/api/bots/:id/toggle - Enable/disable a bot
app.post('/admin/api/bots/:id/toggle', requireAuth(), requireAdmin, async (c) => {
  const { getBotById, setBotEnabled } = await import('../services/bots');
  const bot = await getBotById(c.env.DB, c.req.param('id'));
  if (!bot) return Errors.notFound('Bot not found').toResponse();
  const enabled = bot.enabled !== 1;
  await setBotEnabled(c.env.DB, bot.id, enabled);
  await logAdminAction(c, { action: 'bot.toggle', target: bot.user_id, details: { enabled } });
  return c.json({ id: bot.id, enabled });
});

// --- Telegram bridges (webhook-driven, never polled) ---

// POST /admin/api/telegram/bridges - Register a Telegram bot <-> room bridge
// and point Telegram's webhook at this homeserver. The BotFather token is a
// server-side credential: it is accepted HERE ONLY, never via room messages.
app.post('/admin/api/telegram/bridges', requireAuth(), requireAdmin, async (c) => {
  const db = c.env.DB;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const botUserId = typeof body.bot_user_id === 'string'
    ? body.bot_user_id
    : `@${String(body.bot_localpart ?? '').toLowerCase()}:${c.env.SERVER_NAME}`;
  const roomId = body.room_id;
  const chatId = String(body.chat_id ?? '');
  const tgToken = String(body.tg_token ?? '');
  if (!roomId || !chatId || !/^-?\d+$/.test(chatId) || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(tgToken)) {
    return c.json(
      { errcode: 'M_INVALID_PARAM', error: 'room_id, numeric chat_id and a BotFather token (123456:ABC...) are required' },
      400,
    );
  }

  // The relay account must be a bot of ours (loop prevention keys off the
  // bots table), and must be joined to the bridged room.
  const { getBotByUserId, createBotRow, getBotById } = await import('../services/bots');
  let bot = await getBotByUserId(db, botUserId);
  if (!bot) {
    const { getUserById, createUser } = await import('../services/database');
    if (!(await getUserById(db, botUserId))) {
      const localpart = botUserId.slice(1, botUserId.indexOf(':'));
      if (!/^[a-z0-9._=\-\/+]+$/.test(localpart)) {
        return c.json({ errcode: 'M_INVALID_USERNAME', error: 'Invalid bot localpart' }, 400);
      }
      await createUser(db, botUserId, localpart, null, false);
    }
    const id = await generateOpaqueId(12);
    await createBotRow(db, id, botUserId, 'telegram', '!tg');
    bot = await getBotById(db, id);
  }

  const { joinBotUserToRoom } = await import('./rooms');
  // Private rooms need an invite first; invite as the requesting admin (the
  // state path auto-accepts for bots). Failures are ignored: public rooms
  // join directly, and the membership check below still guards.
  try {
    const { performStateEvent } = await import('./rooms');
    await performStateEvent(c.env, roomId, c.get('userId'), 'm.room.member', botUserId, { membership: 'invite' });
  } catch { /* best-effort */ }
  const joined = (await joinBotUserToRoom(c.env, roomId, botUserId)) !== null;
  const membership = await db
    .prepare(`SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?`)
    .bind(roomId, botUserId)
    .first<{ membership: string }>();
  if (membership?.membership !== 'join') {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: 'Bot could not join the room (invite it first, or use a public room)' },
      403,
    );
  }

  const { createBridge, setBridgeWebhook } = await import('../services/telegram-bridge');
  const bridge = await createBridge(db, { botUserId, roomId, chatId, tgToken });
  const publicBaseUrl = `https://${c.env.SERVER_NAME}`;
  const webhook = await setBridgeWebhook(bridge, publicBaseUrl);
  if (!webhook.ok) {
    // Telegram rejected the token or the webhook URL: roll back the bridge.
    const { deleteBridge } = await import('../services/telegram-bridge');
    await deleteBridge(db, bridge.id);
    return c.json(
      { errcode: 'M_UNKNOWN', error: `Telegram setWebhook failed: ${webhook.description ?? 'unknown error'}` },
      502,
    );
  }

  await logAdminAction(c, {
    action: 'telegram_bridge.create',
    target: bridge.id,
    details: { bot_user_id: botUserId, room_id: roomId, chat_id: chatId },
  });

  // Never echo the token back; the webhook URL alone is fine to show.
  return c.json({
    id: bridge.id,
    bot_user_id: botUserId,
    room_id: roomId,
    chat_id: chatId,
    webhook_url: `${publicBaseUrl}/admin/api/telegram/webhook/${bridge.id}`,
    joined,
  });
});

// GET /admin/api/telegram/bridges - List bridges (token never returned)
app.get('/admin/api/telegram/bridges', requireAuth(), requireAdmin, async (c) => {
  const { listBridges } = await import('../services/telegram-bridge');
  const bridges = await listBridges(c.env.DB);
  return c.json({
    bridges: bridges.map((b) => ({
      id: b.id,
      bot_user_id: b.bot_user_id,
      room_id: b.room_id,
      chat_id: b.chat_id,
      enabled: b.enabled === 1,
      last_update_id: b.last_update_id,
      token_fingerprint: `…${b.tg_token.slice(-4)}`,
    })),
  });
});

// DELETE /admin/api/telegram/bridges/:id - Remove the Telegram webhook + row
app.delete('/admin/api/telegram/bridges/:id', requireAuth(), requireAdmin, async (c) => {
  const { getBridgeById, deleteBridge, deleteBridgeWebhook } = await import('../services/telegram-bridge');
  const bridge = await getBridgeById(c.env.DB, c.req.param('id'));
  if (!bridge) return Errors.notFound('Bridge not found').toResponse();
  await deleteBridgeWebhook(bridge.tg_token);
  await deleteBridge(c.env.DB, bridge.id);
  await logAdminAction(c, { action: 'telegram_bridge.delete', target: bridge.id, details: { room_id: bridge.room_id } });
  return c.json({ deleted: true });
});

// POST /admin/api/telegram/webhook/:id - Telegram's update delivery target.
// Deliberately NOT behind matrix auth: Telegram calls it directly. The
// X-Telegram-Bot-Api-Secret-Token header we set at setWebhook time is the
// credential. Always answers 200: Telegram retries non-2xx, and a poisoned
// update would otherwise replay forever.
app.post('/admin/api/telegram/webhook/:id', async (c) => {
  const id = c.req.param('id');
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  const { getBridgeById, processTelegramUpdate } = await import('../services/telegram-bridge');

  const bridge = await getBridgeById(c.env.DB, id);
  if (!bridge || bridge.enabled !== 1 || !secret || secret !== bridge.webhook_secret) {
    // Do not reveal whether the bridge exists.
    return c.json({}, 403);
  }

  let update: any;
  try {
    update = await c.req.json();
  } catch {
    return c.json({});
  }
  await processTelegramUpdate(c.env, bridge, update);
  return c.json({});
});

// GET /admin/api/telegram/bridges/:id/webhook-info - Ask Telegram (with the
// stored token) how the webhook is doing: armed URL, pending updates, last
// delivery error. The exact diagnostic for "bridge only goes one way".
app.get('/admin/api/telegram/bridges/:id/webhook-info', requireAuth(), requireAdmin, async (c) => {
  const { getBridgeById } = await import('../services/telegram-bridge');
  const bridge = await getBridgeById(c.env.DB, c.req.param('id'));
  if (!bridge) return Errors.notFound('Bridge not found').toResponse();
  try {
    const res = await fetch(`https://api.telegram.org/bot${bridge.tg_token}/getWebhookInfo`);
    const data = (await res.json()) as { ok?: boolean; result?: Record<string, unknown>; description?: string };
    if (!data.ok) {
      return c.json({ ok: false, error: data.description ?? 'Telegram rejected the request (revoked token?)' }, 502);
    }
    return c.json({ ok: true, webhook: data.result });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'network failure' }, 502);
  }
});

// GET /admin/api/rooms/:roomId/federation-probe?server=X - Remote-resolution
// probe: does the given server hold our newest locally-authored event in
// this room? The signed-GET technique from the federation debugging saga,
// as a button. held=false means delivery to that server is failing.
app.get('/admin/api/rooms/:roomId/federation-probe', requireAuth(), requireAdmin, async (c) => {
  const roomId = c.req.param('roomId');
  const server = c.req.query('server');
  if (!server || server === c.env.SERVER_NAME) {
    return Errors.invalidParam('server', 'A remote (non-local) server name is required').toResponse();
  }
  const latest = await c.env.DB.prepare(
    `SELECT event_id, origin_server_ts FROM events
     WHERE room_id = ? AND sender LIKE ? ORDER BY origin_server_ts DESC LIMIT 1`
  ).bind(roomId, `%:${c.env.SERVER_NAME}`).first<{ event_id: string; origin_server_ts: number }>();
  if (!latest) {
    return c.json({ server, held: null, error: 'no locally-authored events in this room to probe with' });
  }
  try {
    const res = await federationGet(
      server,
      `/_matrix/federation/v1/event/${encodeURIComponent(latest.event_id)}`,
      c.env.SERVER_NAME,
      c.env.DB,
      c.env.CACHE
    );
    if (res.status === 404) {
      return c.json({
        server, event_id: latest.event_id, held: false, status: 404,
        note: 'the remote server does not hold this event — outbound delivery to it is failing',
      });
    }
    if (!res.ok) {
      return c.json({
        server, event_id: latest.event_id, held: null, status: res.status,
        note: `probe returned HTTP ${res.status} — investigate with wrangler tail`,
      });
    }
    return c.json({
      server, event_id: latest.event_id, held: true, status: 200,
      origin_server_ts: latest.origin_server_ts,
      note: 'the remote server holds and serves our latest event — delivery is working',
    });
  } catch (err) {
    return c.json({
      server, event_id: latest.event_id, held: null,
      error: err instanceof Error ? err.message : 'probe failed',
    });
  }
});

export default app;
