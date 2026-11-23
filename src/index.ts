// Matrix Homeserver on Cloudflare Workers
// Main entry point

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './types';

// Import API routes
import versions from './api/versions';
import login from './api/login';
import rooms from './api/rooms';
import sync from './api/sync';
import legacySync from './api/legacy-sync';
import slidingSync from './api/sliding-sync';
import profile from './api/profile';
import media from './api/media';
import voip from './api/voip';
import keys from './api/keys';
import federation from './api/federation';
import admin from './api/admin';
import keyBackups from './api/key-backups';
import toDevice from './api/to-device';
import push from './api/push';
import softIgnore from './api/msc4584';
import accountData from './api/account-data';
import typing from './api/typing';
import receipts from './api/receipts';
import tags from './api/tags';
import devices from './api/devices';
import presence from './api/presence';
import aliases from './api/aliases';
import relations from './api/relations';
import spaces from './api/spaces';
import account from './api/account';
import search from './api/search';
import serverNotices from './api/server-notices';
import report from './api/report';
import calls from './api/calls';
import rtc from './api/rtc';
import { handleLiveKitSignalRequest } from './services/livekit-calls-shim';
import appservice from './api/appservice';
import thirdparty from './api/thirdparty';
import identity from './api/identity';
import dehydratedDevice from './api/dehydrated-device';
import delayedEvents from './api/delayed-events';
import rendezvous from './api/rendezvous';
import qrLogin from './api/qr-login';
import oidcAuth from './api/oidc-auth';
import oauth from './api/oauth';
import { adminDashboardHtml } from './admin/dashboard';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { requireAuth, optionalAuth } from './middleware/auth';
import { MatrixApiError } from './utils/errors';
import { analyticsMiddleware } from './middleware/analytics';
import { federationGet, federationPost } from './services/federation-keys';

// Import Durable Objects
export { RoomDurableObject, SyncDurableObject, FederationDurableObject, CallRoomDurableObject, AdminDurableObject, UserKeysDurableObject, PushDurableObject, RateLimitDurableObject, DelayedEventsDurableObject, LiveKitShimDurableObject } from './durable-objects';

// Import Workflows
export { RoomJoinWorkflow, PushNotificationWorkflow, FederationCatchupWorkflow, MediaCleanupWorkflow, StateCompactionWorkflow } from './workflows';

// Create the main app
const app = new Hono<AppEnv>();

// CORS for Matrix clients - MUST BE FIRST to ensure headers are always sent
// (even on error responses from rate limiter or other middleware)
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Matrix-Origin', 'If-Match', 'If-None-Match'],
  exposeHeaders: ['Content-Type', 'Content-Length', 'ETag', 'Location', 'X-Max-Bytes', 'Expires', 'Last-Modified'],
  maxAge: 86400,
}));

// Global middleware
app.use('*', logger());
app.use('*', analyticsMiddleware());

// Rate limiting for Matrix API endpoints
app.use('/_matrix/*', rateLimitMiddleware);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', server: 'matrix-worker' }));

// Admin dashboard - serve HTML with security headers
app.get('/admin', (c) => {
  const html = adminDashboardHtml(c.env.SERVER_NAME);
  return c.html(html, 200, {
    // Content-Security-Policy for XSS protection
    // 'unsafe-inline' is needed for the inline scripts/styles in the dashboard
    // This could be improved by moving scripts to external files with nonces
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
});

app.get('/admin/', (c) => {
  const html = adminDashboardHtml(c.env.SERVER_NAME);
  return c.html(html, 200, {
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
});

// Admin API routes
app.route('/', admin);

// QR code login landing + MSC4108 compatible check/redemption routes
app.route('/', qrLogin);

// OIDC/SSO authentication
app.route('/', oidcAuth);

// OAuth 2.0 provider endpoints
app.route('/', oauth);

// Matrix version discovery
app.route('/', versions);

// Client-Server API
app.route('/', login);
app.route('/', rooms);
app.route('/', delayedEvents);
app.route('/', rendezvous);
app.route('/', sync);
app.route('/', legacySync);
app.route('/', slidingSync);
app.route('/', profile);
app.route('/', media);
app.route('/', voip);
app.route('/', keys);
app.route('/', keyBackups);
app.route('/', dehydratedDevice);
app.route('/', toDevice);
app.route('/', push);
// MSC4584's validated write path must win over generic account data.
app.route('/', softIgnore);
app.route('/', accountData);
app.route('/', typing);
app.route('/', receipts);
app.route('/', tags);
app.route('/', devices);
app.route('/', presence);
app.route('/', aliases);
app.route('/', relations);
app.route('/', spaces);
app.route('/', account);
app.route('/', serverNotices);
app.route('/', report);

// Cloudflare Calls-based video calling API
app.route('/', calls);

// MatrixRTC (LiveKit) JWT service for Element X calls
app.route('/', rtc);

// Experimental opt-in: LiveKit-compatible signaling terminated by the Cloudflare Calls shim.
// Inactive unless LIVEKIT_URL is pointed at wss://<SERVER_NAME>/livekit/signal.
// Limited to unencrypted A/V in a single Worker isolate — see livekit-calls-shim.ts.
app.all('/livekit/signal', (c) => handleLiveKitSignalRequest(c.req.raw, c.env));
app.all('/livekit/signal/*', (c) => handleLiveKitSignalRequest(c.req.raw, c.env));

// Application Service API
app.route('/', appservice);

// Identity Service API
app.route('/', identity);

// Server-Server (Federation) API
app.route('/', federation);

// Capabilities endpoint
// MSC4323 (spec v1.18): m.account_moderation is included only for admins —
// the spec says to omit it entirely when lock and suspend would be false.
// optionalAuth (no error on missing/invalid tokens) keeps the endpoint
// usable by clients that probe capabilities before login.
app.get('/_matrix/client/v3/capabilities', optionalAuth(), async (c) => {
  const capabilities: Record<string, unknown> = {
      'm.change_password': {
        enabled: true,
      },
      'm.room_versions': {
        default: '10',
        available: {
          '1': 'stable',
          '2': 'stable',
          '3': 'stable',
          '4': 'stable',
          '5': 'stable',
          '6': 'stable',
          '7': 'stable',
          '8': 'stable',
          '9': 'stable',
          '10': 'stable',
          '11': 'stable',
          '12': 'stable',
          'dev.zirco.msc4583.v1': 'unstable',
        },
      },
      'm.set_displayname': {
        enabled: true,
      },
      'm.set_avatar_url': {
        enabled: true,
      },
      'm.3pid_changes': {
        enabled: true,
      },
      'm.get_login_token': {
        enabled: true,
      },
      // MSC4267 (spec v1.18): the server auto-forgets rooms on every local
      // membership end (leave/kick/ban/unban, incl. remote-initiated), so
      // clients skip their own /forget call.
      'm.forget_forced_upon_leave': {
        enabled: true,
      },
      // Custom profile fields (Matrix v1.16+): arbitrary keys are accepted
      // by the profile endpoints, so no allowed/disallowed restriction.
      'm.profile_fields': {
        enabled: true,
      },
      // MSC4140 delayed events (spec v1.20): clients treat an absent
      // capability as disabled, so advertise the server's limits explicitly.
      // The unstable key is kept for clients that still probe the MSC name.
      'm.delayed_events': {
        max_delay_ms: 86400000,
        max_scheduled: 10,
      },
      'org.matrix.msc4140.delayed_events': {
        max_delay_ms: 86400000,
        max_scheduled: 10,
      },
  };

  const requester = c.get('userId');
  if (requester) {
    try {
      const adminRow = await c.env.DB.prepare(
        'SELECT admin FROM users WHERE user_id = ?'
      ).bind(requester).first<{ admin: number }>();
      if (adminRow?.admin === 1) {
        capabilities['m.account_moderation'] = { lock: true, suspend: true };
      }
    } catch {
      // Lookup failures leave the capability omitted; capabilities must
      // never 500.
    }
  }

  return c.json({ capabilities });
});

// Push rules now handled by push.ts

// Filter endpoints - persist filters in KV for sync optimization
app.post('/_matrix/client/v3/user/:userId/filter', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const requestedUserId = c.req.param('userId');

  // Users can only create filters for themselves
  if (userId !== requestedUserId) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'Cannot create filters for other users' }, 403);
  }

  let filter: Record<string, unknown>;
  try {
    filter = await c.req.json();
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON' }, 400);
  }

  // Generate filter ID and store in KV
  const filterId = crypto.randomUUID().split('-')[0];
  await c.env.CACHE.put(
    `filter:${userId}:${filterId}`,
    JSON.stringify(filter),
    { expirationTtl: 30 * 24 * 60 * 60 } // 30 days TTL
  );

  return c.json({ filter_id: filterId });
});

app.get('/_matrix/client/v3/user/:userId/filter/:filterId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const requestedUserId = c.req.param('userId');
  const filterId = c.req.param('filterId');

  // Users can only read their own filters
  if (userId !== requestedUserId) {
    return c.json({ errcode: 'M_FORBIDDEN', error: 'Cannot read filters for other users' }, 403);
  }

  const filterJson = await c.env.CACHE.get(`filter:${userId}:${filterId}`);
  if (!filterJson) {
    // Return empty filter if not found (per spec, unknown filter IDs should return empty)
    return c.json({});
  }

  try {
    const filter = JSON.parse(filterJson);
    return c.json(filter);
  } catch {
    return c.json({});
  }
});

// Account data endpoints now handled by account-data.ts

// Presence endpoints now handled by presence.ts

// Search endpoint - now handled by search.ts
app.route('/', search);

// Typing notifications now handled by typing.ts

// Read receipts now handled by receipts.ts

// Device management now handled by devices.ts

// Public rooms directory (Matrix v1.17): GET with query params, POST with
// filter body. Both paginate via opaque offset tokens and sort by most-recent
// activity first (MSC4423), then room_id.
interface PublicRoomChunk {
  room_id: string;
  name?: string;
  topic?: string;
  num_joined_members: number;
  world_readable: boolean;
  guest_can_join: boolean;
  avatar_url?: string;
  join_rule?: string;
  room_type?: string | null;
  canonical_alias?: string;
}

function encodePublicRoomsToken(offset: number): string {
  return btoa(JSON.stringify({ o: offset }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodePublicRoomsToken(token: string | undefined): number {
  if (!token) return 0;
  try {
    const json = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const offset = (JSON.parse(json) as { o?: number }).o;
    return typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0;
  } catch {
    return 0;
  }
}

async function listPublicRooms(
  db: D1Database,
  opts: { searchTerm?: string; roomTypes?: (string | null)[] } = {}
): Promise<PublicRoomChunk[]> {
  const rooms = await db.prepare(
    `SELECT r.room_id, r.room_version,
            COALESCE((SELECT MAX(e.origin_server_ts) FROM events e WHERE e.room_id = r.room_id), 0) AS last_activity_ts
     FROM rooms r
     WHERE r.is_public = 1
     LIMIT 100`
  ).all<{ room_id: string; room_version: string; last_activity_ts: number | null }>();

  // Internal map of room_id -> newest activity timestamp, used for ordering
  // (MSC4423: most-recent activity first). Not exposed in response shape.
  const lastActivityByRoom = new Map<string, number>();
  for (const room of rooms.results) {
    lastActivityByRoom.set(room.room_id, room.last_activity_ts ?? 0);
  }

  const publicRooms: PublicRoomChunk[] = [];

  for (const room of rooms.results) {
    // Get room name and topic from state
    const nameEvent = await db.prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.name'`
    ).bind(room.room_id).first<{ content: string }>();

    const topicEvent = await db.prepare(
      `SELECT e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type = 'm.room.topic'`
    ).bind(room.room_id).first<{ content: string }>();

    // Get member count
    const memberCount = await db.prepare(
      `SELECT COUNT(*) as count FROM room_memberships WHERE room_id = ? AND membership = 'join'`
    ).bind(room.room_id).first<{ count: number }>();

    const name = nameEvent ? JSON.parse(nameEvent.content).name : undefined;
    const topic = topicEvent ? JSON.parse(topicEvent.content).topic : undefined;

    // Remaining directory metadata (alias, type, avatar, access rules).
    const extraState = await db.prepare(
      `SELECT rs.event_type, e.content FROM room_state rs
       JOIN events e ON rs.event_id = e.event_id
       WHERE rs.room_id = ? AND rs.event_type IN
         ('m.room.canonical_alias', 'm.room.create', 'm.room.avatar',
          'm.room.join_rules', 'm.room.guest_access', 'm.room.history_visibility')`
    ).bind(room.room_id).all<{ event_type: string; content: string }>();

    let canonicalAlias: string | undefined;
    let roomType: string | null | undefined;
    let avatarUrl: string | undefined;
    let joinRule: string | undefined;
    let guestCanJoin = false;
    let worldReadable = false;
    for (const row of extraState.results) {
      const content = JSON.parse(row.content) as Record<string, unknown>;
      switch (row.event_type) {
        case 'm.room.canonical_alias':
          canonicalAlias = typeof content.alias === 'string' ? content.alias : undefined;
          break;
        case 'm.room.create':
          roomType = typeof content.type === 'string' ? content.type : null;
          break;
        case 'm.room.avatar':
          avatarUrl = typeof content.url === 'string' ? content.url : undefined;
          break;
        case 'm.room.join_rules':
          joinRule = typeof content.join_rule === 'string' ? content.join_rule : undefined;
          break;
        case 'm.room.guest_access':
          guestCanJoin = content.guest_access === 'can_join';
          break;
        case 'm.room.history_visibility':
          worldReadable = content.history_visibility === 'world_readable';
          break;
      }
    }

    const chunk: PublicRoomChunk = {
      room_id: room.room_id,
      name,
      topic,
      num_joined_members: memberCount?.count || 0,
      world_readable: worldReadable,
      guest_can_join: guestCanJoin,
    };
    if (avatarUrl !== undefined) chunk.avatar_url = avatarUrl;
    if (joinRule !== undefined) chunk.join_rule = joinRule;
    if (roomType !== undefined) chunk.room_type = roomType;
    if (canonicalAlias !== undefined) chunk.canonical_alias = canonicalAlias;
    publicRooms.push(chunk);
  }

  let filtered = publicRooms;

  if (opts.roomTypes) {
    const types = opts.roomTypes;
    filtered = filtered.filter(r =>
      types.some(t => t === null ? r.room_type == null : r.room_type === t)
    );
  }

  if (opts.searchTerm) {
    const term = opts.searchTerm.toLowerCase();
    filtered = filtered.filter(r =>
      (r.name?.toLowerCase().includes(term)) ||
      (r.topic?.toLowerCase().includes(term)) ||
      (r.canonical_alias?.toLowerCase().includes(term)) ||
      r.room_id.toLowerCase().includes(term)
    );
  }

  // MSC4423: rank public rooms by most-recent activity first (newest event
  // origin_server_ts), with deterministic secondary key room_id for ties.
  filtered.sort((a, b) => {
    const ta = lastActivityByRoom.get(a.room_id) ?? 0;
    const tb = lastActivityByRoom.get(b.room_id) ?? 0;
    if (tb !== ta) return tb - ta;
    if (a.room_id < b.room_id) return -1;
    if (a.room_id > b.room_id) return 1;
    return 0;
  });
  return filtered;
}

function publicRoomsPage(
  rooms: PublicRoomChunk[],
  limit: number,
  since: string | undefined
): { chunk: PublicRoomChunk[]; next_batch?: string; prev_batch?: string; total_room_count_estimate: number } {
  const offset = decodePublicRoomsToken(since);
  const chunk = rooms.slice(offset, offset + limit);
  const response: {
    chunk: PublicRoomChunk[];
    next_batch?: string;
    prev_batch?: string;
    total_room_count_estimate: number;
  } = {
    chunk,
    total_room_count_estimate: rooms.length,
  };
  if (offset + limit < rooms.length) {
    response.next_batch = encodePublicRoomsToken(offset + limit);
  }
  if (offset > 0) {
    response.prev_batch = encodePublicRoomsToken(Math.max(0, offset - limit));
  }
  return response;
}

function parsePublicRoomsLimit(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : parseInt(raw || '100', 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(Math.floor(n), 100);
}

app.get('/_matrix/client/v3/publicRooms', async (c) => {
  const server = c.req.query('server');
  const limit = parsePublicRoomsLimit(c.req.query('limit'));
  const since = c.req.query('since');

  // Remote directory: proxy the query over federation.
  if (server && server !== c.env.SERVER_NAME) {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (since) params.set('since', since);
      const res = await federationGet(
        server,
        `/_matrix/federation/v1/publicRooms?${params.toString()}`,
        c.env.SERVER_NAME,
        c.env.DB,
        c.env.CACHE
      );
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[publicRooms] Remote directory query failed:', err);
      return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to query remote public rooms' }, 502);
    }
  }

  const rooms = await listPublicRooms(c.env.DB);
  return c.json(publicRoomsPage(rooms, limit, since));
});

app.post('/_matrix/client/v3/publicRooms', async (c) => {
  let body: {
    limit?: number;
    since?: string;
    filter?: { generic_search_term?: string; room_types?: (string | null)[] };
    include_all_networks?: boolean;
    third_party_instance_id?: string;
  } = {};
  try {
    const parsed = await c.req.json();
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON' }, 400);
  }

  if (body.include_all_networks && body.third_party_instance_id) {
    return c.json({
      errcode: 'M_INVALID_PARAM',
      error: 'include_all_networks and third_party_instance_id are mutually exclusive',
    }, 400);
  }

  const server = c.req.query('server');
  const limit = parsePublicRoomsLimit(body.limit);

  if (server && server !== c.env.SERVER_NAME) {
    try {
      const res = await federationPost(
        server,
        '/_matrix/federation/v1/publicRooms',
        body,
        c.env.SERVER_NAME,
        c.env.DB,
        c.env.CACHE
      );
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('[publicRooms] Remote directory query failed:', err);
      return c.json({ errcode: 'M_UNKNOWN', error: 'Failed to query remote public rooms' }, 502);
    }
  }

  // No application-service networks are configured, so a request scoped to
  // a specific third-party instance has no rooms to return.
  if (body.third_party_instance_id && !body.include_all_networks) {
    return c.json({ chunk: [], total_room_count_estimate: 0 });
  }

  const rooms = await listPublicRooms(c.env.DB, {
    searchTerm: body.filter?.generic_search_term,
    roomTypes: body.filter?.room_types,
  });
  return c.json(publicRoomsPage(rooms, limit, body.since));
});

// User directory search (requires authentication per Matrix spec)
app.post('/_matrix/client/v3/user_directory/search', requireAuth(), async (c) => {
  const db = c.env.DB;
  const requestingUserId = c.get('userId');

  let body: { search_term: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON' }, 400);
  }

  const searchTerm = body.search_term || '';
  const limit = Math.min(body.limit || 10, 50);

  console.log('[user_directory] Search request:', {
    requestingUserId,
    searchTerm,
    limit,
    userAgent: c.req.header('User-Agent'),
  });

  if (!searchTerm) {
    return c.json({ results: [], limited: false });
  }

  // Search for users using FTS5 for ranked full-text search
  const ftsSearchTerm = searchTerm.replace(/['"*()]/g, ' ').trim();
  const results = await db.prepare(`
    SELECT u.user_id, u.display_name, u.avatar_url
    FROM users_fts fts
    JOIN users u ON fts.user_id = u.user_id
    WHERE users_fts MATCH ?
      AND u.is_deactivated = 0
      AND u.is_guest = 0
      AND u.user_id != ?
    ORDER BY bm25(users_fts)
    LIMIT ?
  `).bind(ftsSearchTerm, requestingUserId, limit + 1).all<{
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  }>();

  const limited = results.results.length > limit;
  // Return explicit null values (not undefined/omitted) so Element X knows user exists
  const users = results.results.slice(0, limit).map(u => ({
    user_id: u.user_id,
    display_name: u.display_name || null,
    avatar_url: u.avatar_url || null,
  }));

  console.log('[user_directory] Search results:', {
    searchTerm,
    resultCount: users.length,
    limited,
    firstResult: users[0],
  });

  return c.json({ results: users, limited });
});

// Third-party protocols (stub - no bridges configured)
app.get('/_matrix/client/v3/thirdparty/protocols', async (c) => {
  return c.json({});
});

// Third-party protocol/user/location lookups (404 while no bridges exist)
app.route('/', thirdparty);

// Dehydrated device (MSC3814) routes live in ./api/dehydrated-device

// OIDC auth metadata endpoints are now handled by oidc-auth.ts
// Legacy unstable endpoint for backwards compatibility
app.get('/_matrix/client/unstable/org.matrix.msc2965/auth_issuer', async (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect('/_matrix/client/v1/auth_metadata', 307);
});

app.get('/_matrix/client/unstable/org.matrix.msc2965/auth_metadata', async (c) => {
  // Redirect to the stable endpoint implementation
  return c.redirect('/_matrix/client/v1/auth_metadata', 307);
});

// Fallback for unknown endpoints
app.all('/_matrix/*', (c) => {
  return c.json({
    errcode: 'M_UNRECOGNIZED',
    error: 'Unrecognized request',
  }, 404);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  // MatrixApiErrors carry a designed status/errcode — e.g. a policy
  // server's MSC4284 refusal surfacing verbatim to a client send.
  if (err instanceof MatrixApiError) {
    return err.toResponse();
  }
  console.error('Unhandled error:', err);
  return c.json({
    errcode: 'M_UNKNOWN',
    error: 'An internal error occurred',
  }, 500);
});

export default app;
