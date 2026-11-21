// MatrixRTC API endpoints (MSC4143/MSC4195)
// Provides LiveKit JWT tokens for Element X calls
// Also implements MSC4143 RTC transports discovery

import { Hono } from 'hono';
import type { AppEnv, Env } from '../types';
import { generateLiveKitToken, getLiveKitConfig } from '../services/livekit';
import { requireAuth } from '../middleware/auth';
import {
  deliverRtcToDeviceMessage,
  getRtcToDeviceMessages,
  getRtcToDeviceMessagesBySender,
  updateRtcToDeviceMessageState,
  RTC_INVITE_STATE_FIELD,
} from './to-device';

const app = new Hono<AppEnv>();

// MSC4075's unstable identifier for m.rtc.invite; declines use MSC4310's
// unstable identifier (as specified by MSC4075).
export const MSC4075_INVITE_EVENT_TYPE = 'org.matrix.msc4075.rtc.notification';
export const MSC4310_DECLINE_EVENT_TYPE = 'org.matrix.msc4310.rtc.decline';
const MSC4075_MAX_LIFETIME_MS = 2 * 60 * 1000;

// GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports
// MSC4143: RTC transports discovery - tells clients what real-time communication methods are available
// Returns empty list to indicate standard WebRTC/TURN should be used (no special transports)
app.get('/_matrix/client/unstable/org.matrix.msc4143/rtc/transports', (c) => {
  const config = getLiveKitConfig(c.env);
  
  // If LiveKit is configured, advertise it as a transport option
  if (config) {
    return c.json({
      transports: [
        {
          type: 'livekit',
          url: `https://${c.env.SERVER_NAME}/livekit/get_token`,
        },
      ],
    });
  }

  // No special transports - clients will use standard WebRTC
  return c.json({
    transports: [],
  });
});

// ============================================================================
// MSC4075 MatrixRTC invites (unstable to-device transport)
// ============================================================================
//
// MSC4075 defines m.rtc.invite as a sticky room event with no new HTTP API.
// This server does not have sticky-event sending yet, so invites are delivered
// with the unstable event type org.matrix.msc4075.rtc.notification over the
// existing to-device store. The payload fields and expiry rules are taken from
// MSC4075; invite_id is a local handle for the query/ack routes below.

export interface RtcInviteContent {
  slot_id: string;
  sender_ts: number;
  lifetime: number;
  'm.mentions': { user_ids?: string[]; room?: boolean };
  sticky_key: string;
  invite_id?: string;
  [key: string]: unknown;
}

export type RtcInviteValidation =
  | { ok: true; invite: RtcInviteContent }
  | { ok: false; error: string };

export function validateRtcInvite(content: unknown): RtcInviteValidation {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { ok: false, error: 'Invite content must be an object' };
  }
  const invite = content as Record<string, unknown>;
  if (typeof invite.slot_id !== 'string' || invite.slot_id.length === 0) {
    return { ok: false, error: 'Missing or invalid slot_id' };
  }
  if (invite.sticky_key !== invite.slot_id) {
    return { ok: false, error: 'sticky_key must equal slot_id' };
  }
  if (!Number.isInteger(invite.sender_ts) || (invite.sender_ts as number) <= 0) {
    return { ok: false, error: 'Missing or invalid sender_ts' };
  }
  if (!Number.isInteger(invite.lifetime) || (invite.lifetime as number) < 0) {
    return { ok: false, error: 'Missing or invalid lifetime' };
  }
  const mentions = invite['m.mentions'];
  if (!mentions || typeof mentions !== 'object' || Array.isArray(mentions)) {
    return { ok: false, error: 'Missing m.mentions' };
  }
  const m = mentions as Record<string, unknown>;
  const userIds = m.user_ids;
  const hasUserIds = Array.isArray(userIds) && userIds.some((id) => typeof id === 'string' && id.length > 0);
  if (m.room !== true && !hasUserIds) {
    return { ok: false, error: 'm.mentions must target a user or the room' };
  }
  if (userIds !== undefined && (!Array.isArray(userIds) || userIds.some((id) => typeof id !== 'string'))) {
    return { ok: false, error: 'Invalid m.mentions.user_ids' };
  }
  if (invite.invite_id !== undefined && (typeof invite.invite_id !== 'string' || invite.invite_id.length === 0)) {
    return { ok: false, error: 'Invalid invite_id' };
  }
  return { ok: true, invite: invite as unknown as RtcInviteContent };
}

export function getRtcInviteExpiresAt(invite: RtcInviteContent, receivedAt: number = Date.now()): number {
  // MSC4075 counts the lifetime from sender_ts unless the client's clock is
  // ahead of the server's, in which case the server receive time wins.
  const start = invite.sender_ts <= receivedAt ? invite.sender_ts : receivedAt;
  return start + Math.min(invite.lifetime, MSC4075_MAX_LIFETIME_MS);
}

export function isRtcInviteActive(
  invite: RtcInviteContent,
  now: number = Date.now(),
  receivedAt: number = now
): boolean {
  const start = Math.min(invite.sender_ts, receivedAt);
  return now >= start && now < getRtcInviteExpiresAt(invite, receivedAt);
}

interface RtcInviteSendRequest {
  room_id?: string;
  slot_id?: string;
  lifetime?: number;
  sender_ts?: number;
  invite_id?: string;
  mentions?: { user_ids?: string[]; room?: boolean };
  'm.mentions'?: { user_ids?: string[]; room?: boolean };
}

const MSC4075_API = '/_matrix/client/unstable/org.matrix.msc4075';

// POST .../org.matrix.msc4075/rtc/invite/send - send an invite as a to-device message
app.post(`${MSC4075_API}/rtc/invite/send`, requireAuth(), async (c) => {
  const sender = c.get('userId');
  const db = c.env.DB;

  let body: RtcInviteSendRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON body' }, 400);
  }

  const now = Date.now();
  const candidate = {
    ...body,
    slot_id: body.slot_id,
    sender_ts: body.sender_ts ?? now,
    lifetime: body.lifetime,
    'm.mentions': body['m.mentions'] ?? body.mentions,
    sticky_key: body.slot_id,
    invite_id: body.invite_id ?? `${sender}|${body.slot_id ?? ''}|${body.sender_ts ?? now}`,
    [RTC_INVITE_STATE_FIELD]: 'pending',
  };
  const validated = validateRtcInvite(candidate);
  if (!validated.ok) {
    return c.json({ errcode: 'M_INVALID_PARAM', error: validated.error }, 400);
  }
  const invite = validated.invite;

  if (body.room_id) {
    const senderMembership = await db.prepare(`
      SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
    `).bind(body.room_id, sender).first<{ membership: string }>();
    if (senderMembership?.membership !== 'join') {
      return c.json({ errcode: 'M_FORBIDDEN', error: 'Sender is not a member of this room' }, 403);
    }
  }

  const recipients = new Set<string>();
  for (const target of invite['m.mentions'].user_ids ?? []) {
    if (target !== sender) recipients.add(target);
  }
  if (invite['m.mentions'].room === true) {
    if (!body.room_id) {
      return c.json({ errcode: 'M_MISSING_PARAM', error: 'room_id is required for a room invite' }, 400);
    }
    const members = await db.prepare(`
      SELECT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join'
    `).bind(body.room_id).all<{ user_id: string }>();
    for (const member of members.results) {
      if (member.user_id !== sender) recipients.add(member.user_id);
    }
  }

  const localSuffix = `:${c.env.SERVER_NAME}`;
  const localRecipients = [...recipients].filter((id) => id.endsWith(localSuffix));
  if (localRecipients.length === 0) {
    return c.json({ errcode: 'M_NOT_FOUND', error: 'No local invite recipients' }, 404);
  }

  const sent = await deliverRtcToDeviceMessage(
    c.env,
    sender,
    MSC4075_INVITE_EVENT_TYPE,
    localRecipients,
    invite as unknown as Record<string, any>,
    `msc4075-invite-${invite.invite_id}`
  );
  return c.json({ invite_id: invite.invite_id, sent, expires_at: getRtcInviteExpiresAt(invite, now) });
});

// GET .../org.matrix.msc4075/rtc/invites - list unexpired, unhandled invites
app.get(`${MSC4075_API}/rtc/invites`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const now = Date.now();
  const messages = await getRtcToDeviceMessages(
    c.env.DB,
    userId,
    MSC4075_INVITE_EVENT_TYPE
  );

  const invites: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const content = message.content;
    if (content[RTC_INVITE_STATE_FIELD] && content[RTC_INVITE_STATE_FIELD] !== 'pending') continue;
    const validated = validateRtcInvite(content);
    if (!validated.ok) continue;
    if (!isRtcInviteActive(validated.invite, now, message.createdAt || now)) continue;
    const inviteId = validated.invite.invite_id ?? `${message.senderUserId}|${validated.invite.slot_id}|${validated.invite.sender_ts}`;
    if (seen.has(inviteId)) continue; // one row per device; report once per invite
    seen.add(inviteId);
    invites.push({
      invite_id: inviteId,
      sender: message.senderUserId,
      slot_id: validated.invite.slot_id,
      sender_ts: validated.invite.sender_ts,
      lifetime: validated.invite.lifetime,
      sticky_key: validated.invite.sticky_key,
      expires_at: getRtcInviteExpiresAt(validated.invite, message.createdAt || now),
    });
  }
  return c.json({ invites });
});

// POST .../org.matrix.msc4075/rtc/invites/:inviteId/ack - accept, decline or ignore
app.post(`${MSC4075_API}/rtc/invites/:inviteId/ack`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const inviteId = c.req.param('inviteId');
  let body: { action?: string } = {};
  try {
    const raw = await c.req.text();
    if (raw) body = JSON.parse(raw) as { action?: string };
  } catch {
    return c.json({ errcode: 'M_BAD_JSON', error: 'Invalid JSON body' }, 400);
  }
  const action = body.action ?? 'accept';
  if (action !== 'accept' && action !== 'decline' && action !== 'ignored') {
    return c.json({ errcode: 'M_INVALID_PARAM', error: 'Invalid invite action' }, 400);
  }

  const db = c.env.DB;
  const messages = await getRtcToDeviceMessages(db, userId, MSC4075_INVITE_EVENT_TYPE);
  const invite = messages.find((m) => m.content.invite_id === inviteId);
  if (!invite) {
    return c.json({ errcode: 'M_NOT_FOUND', error: 'Invite not found' }, 404);
  }

  const updated = await updateRtcToDeviceMessageState(db, MSC4075_INVITE_EVENT_TYPE, action, {
    recipientUserId: userId,
    inviteId,
  });
  if (action === 'decline' && invite.senderUserId.endsWith(`:${c.env.SERVER_NAME}`)) {
    // MSC4075 declines reference the invite with an m.reference relation and
    // use the invite's (sticky) id as sticky_key.
    await deliverRtcToDeviceMessage(
      c.env,
      userId,
      MSC4310_DECLINE_EVENT_TYPE,
      [invite.senderUserId],
      {
        'm.relates_to': { rel_type: 'm.reference', event_id: inviteId },
        sticky_key: inviteId,
      },
      `msc4310-decline-${inviteId}`
    );
  }
  return c.json({ success: true, action, updated });
});

// POST .../org.matrix.msc4075/rtc/invites/:inviteId/revoke - sender withdrawal
app.post(`${MSC4075_API}/rtc/invites/:inviteId/revoke`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const inviteId = c.req.param('inviteId');
  const db = c.env.DB;
  const updated = await updateRtcToDeviceMessageState(db, MSC4075_INVITE_EVENT_TYPE, 'revoked', {
    senderUserId: userId,
    inviteId,
  });
  if (updated === 0) {
    return c.json({ errcode: 'M_NOT_FOUND', error: 'Invite not found' }, 404);
  }
  const messages = await getRtcToDeviceMessagesBySender(db, userId, MSC4075_INVITE_EVENT_TYPE);
  const recipients = new Set(
    messages
      .filter((m) => m.content.invite_id === inviteId)
      .map((m) => m.recipientUserId)
      .filter((id): id is string => typeof id === 'string')
  );
  // Sticky-event withdrawal is an empty invite with the same sticky_key.
  for (const recipient of recipients) {
    const message = messages.find((m) => m.content.invite_id === inviteId && m.recipientUserId === recipient);
    if (!message) continue;
    await deliverRtcToDeviceMessage(
      c.env,
      userId,
      MSC4075_INVITE_EVENT_TYPE,
      [recipient],
      { sticky_key: message.content.sticky_key, [RTC_INVITE_STATE_FIELD]: 'revoked' },
      `msc4075-revoke-${inviteId}`
    );
  }
  return c.json({ success: true, revoked: updated });
});

// OpenID token structure from Matrix client
interface OpenIDToken {
  access_token: string;
  token_type: string;
  matrix_server_name: string;
  expires_in: number;
}

// Member info from request
interface MemberInfo {
  id: string;
  claimed_user_id: string;
  claimed_device_id: string;
}

// Request body for /get_token
// Note: Element X sends 'room' not 'room_id', and 'device_id' not 'member'
interface GetTokenRequest {
  room_id?: string;  // Old format
  room?: string;     // Element X format
  slot_id?: string;
  openid_token: OpenIDToken;
  member?: MemberInfo;  // Old format
  device_id?: string;   // Element X format - device ID string
  delayed_event_id?: string;
}

// Response for /get_token
interface GetTokenResponse {
  url: string;
  jwt: string;
}

// Verify OpenID token with the homeserver
async function verifyOpenIDToken(
  token: OpenIDToken,
  serverName: string,
  sessionsKv: KVNamespace
): Promise<{ sub: string } | null> {
  try {
    if (token.matrix_server_name !== serverName) {
      console.warn('[rtc] Rejecting OpenID token from different server:', token.matrix_server_name);
      return null;
    }

    // Verify the OpenID token against our local session store
    const tokenData = await sessionsKv.get(`openid:${token.access_token}`);
    if (tokenData) {
      const parsed = JSON.parse(tokenData);
      return { sub: parsed.user_id || parsed.sub };
    }

    // Token not found in our store — reject
    console.warn('[rtc] OpenID token not found in session store');
    return null;
  } catch (error) {
    console.error('[rtc] Error verifying OpenID token:', error);
    return null;
  }
}

// Convert Matrix room ID to a valid LiveKit room name
function roomIdToLiveKitName(roomId: string): string {
  // LiveKit room names can only contain alphanumeric, dash, underscore
  // Matrix room IDs look like: !roomid:server.name
  return roomId.replace(/[^a-zA-Z0-9-_]/g, '_');
}

// ============================================================================
// MSC4576 - LiveKit data publishing follows audio/video publishing
// ============================================================================

export interface LiveKitPublishDecision {
  canPublish: boolean;
  canPublishData: boolean;
  reason: 'local-joined-member' | 'remote-user' | 'not-joined' | 'insufficient-power-level';
}

// MSC4576 requires video.canPublishData to be set to the same value as
// video.canPublish. Membership/power levels decide canPublish; the data grant
// is then derived from it, never granted on its own.
export function evaluateLiveKitPublishRights(input: {
  isLocalUser: boolean;
  membership?: string | null;
  userPowerLevel?: number;
  requiredPowerLevel?: number;
}): LiveKitPublishDecision {
  let reason: LiveKitPublishDecision['reason'];
  if (!input.isLocalUser) {
    reason = 'remote-user';
  } else if (input.membership !== 'join') {
    reason = 'not-joined';
  } else if ((input.userPowerLevel ?? 0) < (input.requiredPowerLevel ?? 0)) {
    reason = 'insufficient-power-level';
  } else {
    reason = 'local-joined-member';
  }
  const canPublish = reason === 'local-joined-member';
  return { canPublish, canPublishData: canPublish, reason };
}

// Read the room facts used for the publish decision. Failures deny publishing
// but never deny subscribing, so an existing call can still be joined.
async function resolveLiveKitPublishRights(
  env: Env,
  roomId: string,
  userId: string,
  openIdSubject?: string
): Promise<LiveKitPublishDecision> {
  const isLocalUser = !openIdSubject || openIdSubject.endsWith(`:${env.SERVER_NAME}`);
  if (!isLocalUser) return evaluateLiveKitPublishRights({ isLocalUser });
  if (!env.DB) return evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join' });

  try {
    const membership = await env.DB.prepare(`
      SELECT membership FROM room_memberships WHERE room_id = ? AND user_id = ?
    `).bind(roomId, userId).first<{ membership: string }>();

    const powerLevels = await env.DB.prepare(`
      SELECT e.content FROM room_state rs
      JOIN events e ON rs.event_id = e.event_id
      WHERE rs.room_id = ? AND rs.event_type = 'm.room.power_levels'
    `).bind(roomId).first<{ content: string }>();

    let userPowerLevel = 0;
    let requiredPowerLevel = 0;
    if (powerLevels?.content) {
      const parsed = JSON.parse(powerLevels.content) as Record<string, any>;
      userPowerLevel = Number(parsed.users?.[userId] ?? parsed.users_default ?? 0);
      requiredPowerLevel = Number(
        parsed.events?.['m.call'] ?? parsed.events?.['m.rtc.member'] ?? parsed.state_default ?? 0
      );
    }
    return evaluateLiveKitPublishRights({
      isLocalUser,
      membership: membership?.membership,
      userPowerLevel,
      requiredPowerLevel,
    });
  } catch (error) {
    console.warn('[rtc] Could not resolve room publish rights:', error);
    return evaluateLiveKitPublishRights({ isLocalUser, membership: null });
  }
}

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

async function base64UrlEncode(bytes: Uint8Array): Promise<string> {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Apply MSC4576 to an issued LiveKit JWT. Non-JWT tokens (e.g. custom SFU
// token providers) are passed through untouched.
export async function applyMsc4576DataPublishGate(
  jwt: string,
  apiSecret: string,
  canPublish: boolean
): Promise<string> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return jwt;
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as Record<string, any>;
    if (!claims.video || typeof claims.video !== 'object') return jwt;
    if (claims.video.canPublish === canPublish && claims.video.canPublishData === canPublish) {
      return jwt;
    }
    claims.video.canPublish = canPublish;
    claims.video.canPublishData = canPublish; // MSC4576: MUST equal canPublish

    const payload = await base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(apiSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${payload}`));
    return `${parts[0]}.${payload}.${await base64UrlEncode(new Uint8Array(signature))}`;
  } catch (error) {
    console.warn('[rtc] Could not apply MSC4576 data publish gate:', error);
    return jwt;
  }
}

// POST /livekit/get_token - Get a LiveKit JWT token
// This is the endpoint that Element X calls to get call credentials
app.post('/livekit/get_token', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const config = getLiveKitConfig(c.env);
  if (!config) {
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'LiveKit not configured' },
      500
    );
  }

  let body: GetTokenRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'Invalid JSON body' },
      400
    );
  }

  // Handle both old format (room_id, member) and Element X format (room, device_id)
  const roomId = body.room_id || body.room;

  // Validate required fields
  if (!roomId) {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'Missing required field: room' },
      400
    );
  }

  // Verify the OpenID token if provided (additional verification layer)
  let openIdSubject: string | undefined;
  if (body.openid_token) {
    const verified = await verifyOpenIDToken(body.openid_token, c.env.SERVER_NAME, c.env.SESSIONS);
    if (verified) {
      openIdSubject = verified.sub;
    } else {
      console.warn(`[rtc] OpenID token verification failed for ${userId}`);
    }
  }

  // Use the authenticated user's identity — never trust client-supplied identity
  const participantId = userId;
  const participantName = userId.split(':')[0].replace('@', '');
  void (body.device_id || c.get('deviceId')); // deviceId available for future per-device tracking

  // Convert Matrix room ID to LiveKit room name
  const liveKitRoom = roomIdToLiveKitName(roomId);

  try {
    // Generate JWT token for this participant
    const jwt = await generateLiveKitToken(
      config.apiKey,
      config.apiSecret,
      liveKitRoom,
      participantId,
      participantName,
      3600 // 1 hour TTL
    );
    const decision = await resolveLiveKitPublishRights(c.env, roomId, participantId, openIdSubject);
    const gatedJwt = await applyMsc4576DataPublishGate(jwt, config.apiSecret, decision.canPublish);

    const response: GetTokenResponse = {
      url: config.wsUrl,
      jwt: gatedJwt,
    };

    return c.json(response);
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'Failed to generate token' },
      500
    );
  }
});

// OPTIONS handler for CORS preflight
app.options('/livekit/get_token', () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
});

// POST /livekit/get_token/sfu/get - Alternative endpoint format used by Element X
// This is the same as /livekit/get_token but with /sfu/get suffix
app.post('/livekit/get_token/sfu/get', requireAuth(), async (c) => {
  const userId = c.get('userId');

  const config = getLiveKitConfig(c.env);
  if (!config) {
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'LiveKit not configured' },
      500
    );
  }

  let body: GetTokenRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'Invalid JSON body' },
      400
    );
  }

  // Handle both old format (room_id, member) and Element X format (room, device_id)
  const roomId = body.room_id || body.room;

  // Validate required fields
  if (!roomId) {
    return c.json(
      { errcode: 'M_BAD_JSON', error: 'Missing required field: room' },
      400
    );
  }

  // Verify the OpenID token if provided (additional verification layer)
  let openIdSubject: string | undefined;
  if (body.openid_token) {
    const verified = await verifyOpenIDToken(body.openid_token, c.env.SERVER_NAME, c.env.SESSIONS);
    if (verified) {
      openIdSubject = verified.sub;
    } else {
      console.warn(`[rtc] OpenID token verification failed for ${userId}`);
    }
  }

  // Use the authenticated user's identity — never trust client-supplied identity
  const participantId = userId;
  const participantName = userId.split(':')[0].replace('@', '');
  void (body.device_id || c.get('deviceId')); // deviceId available for future per-device tracking

  // Convert Matrix room ID to LiveKit room name
  const liveKitRoom = roomIdToLiveKitName(roomId);

  try {
    // Generate JWT token for this participant
    const jwt = await generateLiveKitToken(
      config.apiKey,
      config.apiSecret,
      liveKitRoom,
      participantId,
      participantName,
      3600 // 1 hour TTL
    );
    const decision = await resolveLiveKitPublishRights(c.env, roomId, participantId, openIdSubject);
    const gatedJwt = await applyMsc4576DataPublishGate(jwt, config.apiSecret, decision.canPublish);

    const response: GetTokenResponse = {
      url: config.wsUrl,
      jwt: gatedJwt,
    };

    return c.json(response);
  } catch (error) {
    console.error('Error generating LiveKit token:', error);
    return c.json(
      { errcode: 'M_UNKNOWN', error: 'Failed to generate token' },
      500
    );
  }
});

// OPTIONS handler for /sfu/get endpoint
app.options('/livekit/get_token/sfu/get', () => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
});

// Return 405 Method Not Allowed for non-POST/OPTIONS methods
// Element X checks endpoint availability with GET and expects 405 (not 404)
app.all('/livekit/get_token', (c) => {
  return c.text('Method Not Allowed', 405, {
    Allow: 'POST, OPTIONS',
  });
});

app.all('/livekit/get_token/sfu/get', (c) => {
  return c.text('Method Not Allowed', 405, {
    Allow: 'POST, OPTIONS',
  });
});

export default app;
