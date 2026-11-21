/**
 * Targeted coverage for the two MatrixRTC watch-list MSCs:
 * - MSC4075 invites over the unstable to-device transport (send/query/ack/revoke/expiry)
 * - MSC4576 LiveKit data publishing tied to audio/video publishing rights
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const USER = '@alice:example.com';
const BOB = '@bob:example.com';
const SERVER = 'example.com';
const ROOM = '!room:example.com';
const SLOT = 'm.call#room';
const NOW = 1_700_000_000_000;

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'ALICEDEV');
      await next();
    };
  },
}));

import rtcApp, {
  MSC4075_INVITE_EVENT_TYPE,
  MSC4310_DECLINE_EVENT_TYPE,
  applyMsc4576DataPublishGate,
  evaluateLiveKitPublishRights,
  getRtcInviteExpiresAt,
  isRtcInviteActive,
  validateRtcInvite,
  type RtcInviteContent,
} from '../src/api/rtc';
import { generateLiveKitToken } from '../src/services/livekit';

type Message = {
  id: number;
  recipient_user_id: string;
  recipient_device_id: string;
  sender_user_id: string;
  event_type: string;
  content: string;
  message_id: string;
  stream_position: number;
  created_at: number;
};

type Membership = { room_id: string; user_id: string; membership: string };

function createDb(opts: {
  memberships?: Membership[];
  powerLevels?: Record<string, unknown>;
} = {}) {
  const streamPositions: Record<string, number> = { to_device: 5 };
  const devices = [
    { user_id: USER, device_id: 'ALICEDEV' },
    { user_id: BOB, device_id: 'BOBDEV' },
  ];
  const memberships = opts.memberships ?? [
    { room_id: ROOM, user_id: USER, membership: 'join' },
    { room_id: ROOM, user_id: BOB, membership: 'join' },
  ];
  const messages: Message[] = [];
  const powerLevels = opts.powerLevels ?? null;
  const updates: unknown[][] = [];

  const db = {
    streamPositions,
    devices,
    memberships,
    messages,
    updates,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('UPDATE stream_positions') && sql.includes('RETURNING')) {
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { position: streamPositions[name] } as T;
              }
              if (sql.includes('INSERT INTO stream_positions') && sql.includes('RETURNING')) {
                const name = args[0] as string;
                streamPositions[name] = (streamPositions[name] ?? 0) + 1;
                return { position: streamPositions[name] } as T;
              }
              if (sql.includes('FROM room_memberships')) {
                const [roomId, userId] = args as string[];
                const row = memberships.find((m) => m.room_id === roomId && m.user_id === userId);
                return (row ? { membership: row.membership } : null) as T;
              }
              if (sql.includes("rs.event_type = 'm.room.power_levels'")) {
                return (powerLevels ? { content: JSON.stringify(powerLevels) } : null) as T;
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes('SELECT device_id FROM devices')) {
                const userId = args[0] as string;
                return { results: devices
                  .filter((d) => d.user_id === userId)
                  .map((d) => ({ device_id: d.device_id })) as T[] };
              }
              if (sql.includes('SELECT user_id FROM room_memberships')) {
                const roomId = args[0] as string;
                return { results: memberships
                  .filter((m) => m.room_id === roomId && m.membership === 'join')
                  .map((m) => ({ user_id: m.user_id })) as T[] };
              }
              if (sql.includes('SELECT id, recipient_user_id, sender_user_id, content')) {
                const bySender = sql.includes('WHERE sender_user_id = ?');
                const [party, eventType] = args as string[];
                return { results: messages
                  .filter((m) => m.event_type === eventType)
                  .filter((m) => bySender ? m.sender_user_id === party : m.recipient_user_id === party)
                  .map((m) => ({
                    id: m.id,
                    recipient_user_id: m.recipient_user_id,
                    sender_user_id: m.sender_user_id,
                    content: m.content,
                    created_at: m.created_at,
                    stream_position: m.stream_position,
                  })) as T[] };
              }
              if (sql.includes('SELECT id, content FROM to_device_messages')) {
                const hasRecipient = sql.includes('recipient_user_id = ?');
                const byRecipient = hasRecipient && (!sql.includes('sender_user_id = ?') ||
                  sql.indexOf('recipient_user_id = ?') < sql.indexOf('sender_user_id = ?'));
                const [eventType, party] = args as [string, string?];
                return { results: messages
                  .filter((m) => m.event_type === eventType)
                  .filter((m) => party === undefined || (byRecipient
                    ? m.recipient_user_id === party
                    : m.sender_user_id === party))
                  .map((m) => ({ id: m.id, content: m.content })) as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              if (sql.includes('INSERT INTO to_device_messages')) {
                const [recipient, device, sender, eventType, content, messageId, position] = args as [
                  string, string, string, string, string, string, number,
                ];
                if (!messages.some((m) => m.message_id === messageId && m.recipient_user_id === recipient)) {
                  messages.push({
                    id: messages.length + 1,
                    recipient_user_id: recipient,
                    recipient_device_id: device,
                    sender_user_id: sender,
                    event_type: eventType,
                    content,
                    message_id: messageId,
                    stream_position: position,
                    created_at: Date.now(),
                  });
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE to_device_messages SET content')) {
                const [content, id] = args as [string, number];
                const row = messages.find((m) => m.id === id);
                if (row) row.content = content;
                updates.push(args);
                return { meta: { changes: row ? 1 : 0 } };
              }
              throw new Error(`Unhandled run SQL: ${sql.slice(0, 120)}`);
            },
          };
        },
      };
    },
  };
  return db;
}

type Db = ReturnType<typeof createDb>;

function createEnv(db: Db = createDb()) {
  const syncNotified: string[] = [];
  const env = {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret',
    LIVEKIT_URL: 'wss://livekit.example/rtc',
    SESSIONS: { get: async () => null, put: async () => undefined },
    SYNC: {
      idFromName: () => 'sync-do',
      get: () => ({ fetch: async (req: Request) => {
        const body = (await req.json()) as { type: string };
        syncNotified.push(body.type);
        return new Response('ok');
      } }),
    },
    _syncNotified: syncNotified,
  };
  return env as unknown as Env & { _syncNotified: string[] };
}

async function request(env: Env, path: string, init: RequestInit = {}) {
  const res = await rtcApp.request(`http://localhost${path}`, init, env);
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function invite(partial: Partial<RtcInviteContent> = {}): RtcInviteContent {
  return {
    slot_id: SLOT,
    sticky_key: SLOT,
    sender_ts: NOW,
    lifetime: 90_000,
    'm.mentions': { user_ids: [BOB] },
    invite_id: 'invite-1',
    ...partial,
  };
}

const SEND = '/_matrix/client/unstable/org.matrix.msc4075/rtc/invite/send';
const LIST = '/_matrix/client/unstable/org.matrix.msc4075/rtc/invites';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MSC4075 invite shape and expiry', () => {
  it('accepts a conformant invite', () => {
    expect(validateRtcInvite(invite())).toMatchObject({ ok: true });
  });

  it('rejects invalid slot_id, sticky_key, lifetime, mentions and invite_id', () => {
    expect(validateRtcInvite(invite({ slot_id: '' }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ sticky_key: 'other' }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ lifetime: -1 }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ lifetime: 1.5 }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ sender_ts: 0 }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ 'm.mentions': { room: false } }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ 'm.mentions': { user_ids: [3] as any } }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(invite({ invite_id: '' }))).toMatchObject({ ok: false });
    expect(validateRtcInvite(null)).toMatchObject({ ok: false });
  });

  it('allows a room mention without user_ids', () => {
    expect(validateRtcInvite(invite({ 'm.mentions': { room: true } }))).toMatchObject({ ok: true });
  });

  it('counts lifetime from sender_ts and caps at two minutes', () => {
    const cap = invite({ lifetime: 10 * 60_000 });
    expect(getRtcInviteExpiresAt(cap, NOW)).toBe(NOW + 120_000);
    const earlier = invite({ sender_ts: NOW - 5_000, lifetime: 90_000 });
    expect(getRtcInviteExpiresAt(earlier, NOW)).toBe(NOW - 5_000 + 90_000);
    expect(isRtcInviteActive(earlier, NOW, NOW)).toBe(true);
  });

  it('bounds a client clock ahead of the server by the receive time', () => {
    const future = invite({ sender_ts: NOW + 30_000, lifetime: 10_000 });
    expect(isRtcInviteActive(future, NOW + 5_000, NOW)).toBe(true);
    expect(isRtcInviteActive(future, NOW + 10_001, NOW)).toBe(false);
  });

  it('expires an invite after its lifetime', () => {
    const old = invite({ sender_ts: NOW - 120_000, lifetime: 90_000 });
    expect(isRtcInviteActive(old, NOW, NOW)).toBe(false);
  });
});

describe('MSC4075 invite routes', () => {
  it('sends an invite to all recipient devices using the unstable event type', async () => {
    const db = createDb();
    const env = createEnv(db);
    const res = await request(env, SEND, jsonInit('POST', {
      room_id: ROOM,
      slot_id: SLOT,
      lifetime: 90_000,
      sender_ts: NOW,
      'm.mentions': { user_ids: [BOB] },
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invite_id: `${USER}|${SLOT}|${NOW}`,
      sent: 1,
      expires_at: NOW + 90_000,
    });
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      recipient_user_id: BOB,
      sender_user_id: USER,
      event_type: MSC4075_INVITE_EVENT_TYPE,
    });
    expect(JSON.parse(db.messages[0].content)).toMatchObject({
      slot_id: SLOT,
      sticky_key: SLOT,
      lifetime: 90_000,
      msc4075_state: 'pending',
    });
    expect(env._syncNotified).toContain('stream:to_device');
  });

  it('expands a room mention to joined members, excluding the sender', async () => {
    const db = createDb();
    const res = await request(createEnv(db), SEND, jsonInit('POST', {
      room_id: ROOM,
      slot_id: SLOT,
      lifetime: 60_000,
      'm.mentions': { room: true },
    }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: 1 });
    expect(db.messages[0].recipient_user_id).toBe(BOB);
  });

  it('rejects malformed invites and missing recipients', async () => {
    const bad = await request(createEnv(), SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: -1, 'm.mentions': { user_ids: [BOB] },
    }));
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });

    const roomOnly = await request(createEnv(), SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: 1_000, 'm.mentions': { room: true },
    }));
    expect(roomOnly.status).toBe(400);

    const selfOnly = await request(createEnv(), SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: 1_000, 'm.mentions': { user_ids: [USER] },
    }));
    expect(selfOnly.status).toBe(404);
  });

  it('refuses to send a room invite when the sender is not joined', async () => {
    const db = createDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }] });
    const res = await request(createEnv(db), SEND, jsonInit('POST', {
      room_id: ROOM, slot_id: SLOT, lifetime: 60_000, 'm.mentions': { room: true },
    }));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errcode: 'M_FORBIDDEN' });
    expect(db.messages).toHaveLength(0);
  });

  it('queries pending invites and hides expired or already handled ones', async () => {
    const db = createDb();
    const env = createEnv(db);
    await request(env, SEND, jsonInit('POST', {
      room_id: ROOM, slot_id: SLOT, lifetime: 90_000, sender_ts: NOW,
      invite_id: 'invite-1', 'm.mentions': { user_ids: [BOB] },
    }));
    db.messages[0].recipient_user_id = USER;
    db.messages[0].recipient_device_id = 'ALICEDEV';

    const listed = await request(env, LIST);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      invites: [{
        invite_id: 'invite-1', sender: USER, slot_id: SLOT,
        expires_at: NOW + 90_000,
      }],
    });

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 90_001);
    const expired = await request(env, LIST);
    expect(expired.body).toEqual({ invites: [] });
  });

  it('reports an invite only once when delivered to several devices', async () => {
    const db = createDb();
    db.devices.push({ user_id: BOB, device_id: 'BOBDEV2' });
    const env = createEnv(db);
    await request(env, SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: 90_000, sender_ts: NOW, invite_id: 'invite-multi',
      'm.mentions': { user_ids: [BOB] },
    }));
    expect(db.messages).toHaveLength(2);
    for (const message of db.messages) message.recipient_user_id = USER;
    const listed = await request(env, LIST);
    expect((listed.body as { invites: unknown[] }).invites).toHaveLength(1);
  });

  it('acknowledges an invite and declines with an m.reference relation', async () => {
    const db = createDb();
    const env = createEnv(db);
    await request(env, SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: 90_000, sender_ts: NOW, invite_id: 'invite-1',
      'm.mentions': { user_ids: [BOB] },
    }));
    // Move the delivered invite to Alice so she can ack it.
    db.messages[0].recipient_user_id = USER;

    const accepted = await request(env, `${LIST}/invite-1/ack`, jsonInit('POST', { action: 'accept' }));
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ action: 'accept', updated: 1 });
    expect(JSON.parse(db.messages[0].content).msc4075_state).toBe('accept');
    expect((await request(env, LIST)).body).toEqual({ invites: [] });

    const declined = await request(env, `${LIST}/invite-1/ack`, jsonInit('POST', { action: 'decline' }));
    expect(declined.status).toBe(200);
    const decline = db.messages.find((m) => m.event_type === MSC4310_DECLINE_EVENT_TYPE);
    expect(decline).toBeDefined();
    expect(JSON.parse(decline!.content)).toEqual({
      'm.relates_to': { rel_type: 'm.reference', event_id: 'invite-1' },
      sticky_key: 'invite-1',
    });

    expect((await request(env, `${LIST}/missing/ack`, jsonInit('POST', {}))).status).toBe(404);
    expect((await request(env, `${LIST}/invite-1/ack`, jsonInit('POST', { action: 'bogus' }))).status).toBe(400);
  });

  it('lets the sender revoke an invite and withdraws it to-device', async () => {
    const db = createDb();
    const env = createEnv(db);
    await request(env, SEND, jsonInit('POST', {
      slot_id: SLOT, lifetime: 90_000, sender_ts: NOW, invite_id: 'invite-2',
      'm.mentions': { user_ids: [BOB] },
    }));

    const revoked = await request(env, `${LIST}/invite-2/revoke`, jsonInit('POST'));
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revoked: 1 });
    const withdrawals = db.messages.filter((m) => JSON.parse(m.content).msc4075_state === 'revoked');
    expect(withdrawals.length).toBeGreaterThan(0);
    expect(JSON.parse(withdrawals[withdrawals.length - 1].content).sticky_key).toBe(SLOT);
    expect((await request(env, `${LIST}/nope/revoke`, jsonInit('POST'))).status).toBe(404);
  });
});

describe('MSC4576 LiveKit data publish gating', () => {
  it('allows data publishing exactly when audio/video publishing is allowed', () => {
    for (const decision of [
      evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join' }),
      evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join', userPowerLevel: 50, requiredPowerLevel: 50 }),
      evaluateLiveKitPublishRights({ isLocalUser: false, membership: 'join' }),
      evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'leave' }),
      evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join', userPowerLevel: 0, requiredPowerLevel: 50 }),
    ]) {
      expect(decision.canPublishData).toBe(decision.canPublish);
    }
    expect(evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join' }).canPublish).toBe(true);
    expect(evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'leave' }).reason).toBe('not-joined');
    expect(evaluateLiveKitPublishRights({ isLocalUser: false }).reason).toBe('remote-user');
    expect(evaluateLiveKitPublishRights({ isLocalUser: true, membership: 'join', userPowerLevel: 0, requiredPowerLevel: 50 }).reason)
      .toBe('insufficient-power-level');
  });

  it('rewrites a JWT so canPublishData matches canPublish', async () => {
    const original = await generateLiveKitToken('lk-key', 'lk-secret', 'room', USER, 'alice', 3600);
    const gated = await applyMsc4576DataPublishGate(original, 'lk-secret', false);
    const claims = JSON.parse(Buffer.from(gated.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.video).toMatchObject({ canPublish: false, canPublishData: false, canSubscribe: true });

    // The re-signed token must still verify against the LiveKit secret.
    const [header, payload, signature] = gated.split('.');
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('lk-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
    const expected = Buffer.from(signed).toString('base64url');
    expect(signature).toBe(expected);
    expect(await applyMsc4576DataPublishGate('not-a-jwt', 'lk-secret', false)).toBe('not-a-jwt');
  });

  async function claimsFor(db: Db, path: string) {
    const res = await request(createEnv(db), path, jsonInit('POST', { room: ROOM }));
    expect(res.status).toBe(200);
    const jwt = (res.body as { jwt: string }).jwt;
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  }

  it('grants both publish grants to a joined local member', async () => {
    const claims = await claimsFor(
      createDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }] }),
      '/livekit/get_token'
    );
    expect(claims.video).toMatchObject({ canPublish: true, canPublishData: true });
  });

  it('denies both publish grants to a non-member but keeps subscribe', async () => {
    const claims = await claimsFor(
      createDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'leave' }] }),
      '/livekit/get_token'
    );
    expect(claims.video).toMatchObject({ canPublish: false, canPublishData: false, canSubscribe: true });
  });

  it('applies the same gate on the /sfu/get endpoint', async () => {
    const claims = await claimsFor(
      createDb({ memberships: [{ room_id: ROOM, user_id: USER, membership: 'ban' }] }),
      '/livekit/get_token/sfu/get'
    );
    expect(claims.video).toMatchObject({ canPublish: false, canPublishData: false });
  });

  it('honours room power levels when deciding publish rights', async () => {
    const claims = await claimsFor(
      createDb({
        memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
        powerLevels: { events: { 'm.call': 50 }, users: {}, users_default: 0 },
      }),
      '/livekit/get_token'
    );
    expect(claims.video).toMatchObject({ canPublish: false, canPublishData: false });
  });
});
