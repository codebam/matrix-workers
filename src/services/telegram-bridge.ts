// Telegram bot bridge: one Telegram bot chat <-> one Matrix room, both
// directions.
//
//   Telegram -> Matrix: Telegram POSTs updates to the homeserver webhook
//   (POST /admin/api/telegram/webhook/:id, validated by the
//   X-Telegram-Bot-Api-Secret-Token header that Telegram echoes from
//   setWebhook). We never poll. Messages land in the room as the bridge's
//   bot user through the normal send pipeline (federation fanout included).
//
//   Matrix -> Telegram: room messages (local sends AND federated-in PDUs)
//   are relayed to the Telegram Bot API as sendMessage calls. Bot senders
//   are skipped — the bridge bot's own messages must never loop back.
//
// The bot token is a server-side credential stored in D1 (like hs_token in
// appservice_registrations) and is only ever supplied via the admin HTTP
// API — never via room messages, whose history is permanent.

import type { Env } from '../types';
import { generateOpaqueId } from '../utils/ids';

export interface TelegramBridgeRow {
  id: string;
  bot_user_id: string;
  room_id: string;
  chat_id: string;
  tg_token: string;
  webhook_secret: string;
  last_update_id: number;
  enabled: number;
  created_at: number;
}

export async function getBridgeById(db: D1Database, id: string): Promise<TelegramBridgeRow | null> {
  return await db
    .prepare(
      `SELECT id, bot_user_id, room_id, chat_id, tg_token, webhook_secret, last_update_id, enabled, created_at
       FROM telegram_bridges WHERE id = ?`
    )
    .bind(id)
    .first<TelegramBridgeRow>();
}

export async function getBridgesForRoom(db: D1Database, roomId: string): Promise<TelegramBridgeRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, bot_user_id, room_id, chat_id, tg_token, webhook_secret, last_update_id, enabled, created_at
       FROM telegram_bridges WHERE room_id = ? AND enabled = 1`
    )
    .bind(roomId)
    .all<TelegramBridgeRow>();
  return rows.results ?? [];
}

export async function listBridges(db: D1Database): Promise<TelegramBridgeRow[]> {
  const rows = await db
    .prepare(
      `SELECT id, bot_user_id, room_id, chat_id, tg_token, webhook_secret, last_update_id, enabled, created_at
       FROM telegram_bridges ORDER BY created_at`
    )
    .all<TelegramBridgeRow>();
  return rows.results ?? [];
}

export interface CreateBridgeInput {
  botUserId: string;
  roomId: string;
  chatId: string;
  tgToken: string;
}

export async function createBridge(
  db: D1Database,
  input: CreateBridgeInput
): Promise<TelegramBridgeRow> {
  const id = 'tgb_' + (await generateOpaqueId(12));
  // 32 chars of [A-Za-z0-9_-]: valid for Telegram's secret_token header and
  // unguessable in practice.
  const webhookSecret = await generateOpaqueId(24);
  await db
    .prepare(
      `INSERT INTO telegram_bridges (id, bot_user_id, room_id, chat_id, tg_token, webhook_secret, last_update_id, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)`
    )
    .bind(id, input.botUserId, input.roomId, input.chatId, input.tgToken, webhookSecret, Date.now())
    .run();
  const row = await getBridgeById(db, id);
  return row!;
}

const TG_API = 'https://api.telegram.org';

async function tgCall(token: string, method: string, body: Record<string, unknown>): Promise<{ ok: boolean; description?: string }> {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  return { ok: !!data.ok, description: data.description };
}

/** Verify a Telegram bot token and register the webhook for a bridge. */
export async function setBridgeWebhook(
  bridge: TelegramBridgeRow,
  publicBaseUrl: string
): Promise<{ ok: boolean; description?: string }> {
  return await tgCall(bridge.tg_token, 'setWebhook', {
    url: `${publicBaseUrl}/admin/api/telegram/webhook/${bridge.id}`,
    secret_token: bridge.webhook_secret,
    allowed_updates: ['message'],
    // Telegram retries failed webhooks; keep the queue short so a long outage
    // does not replay a huge backlog into the room.
    max_connections: 4,
  });
}

export async function deleteBridgeWebhook(tgToken: string): Promise<void> {
  await tgCall(tgToken, 'deleteWebhook', {}).catch(() => undefined);
}

export async function setBridgeEnabled(db: D1Database, id: string, enabled: boolean): Promise<void> {
  await db.prepare(`UPDATE telegram_bridges SET enabled = ? WHERE id = ?`).bind(enabled ? 1 : 0, id).run();
}

export async function deleteBridge(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM telegram_bridges WHERE id = ?`).bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// --- Matrix -> Telegram ---

/** Relay a Matrix room message to every bridge on that room. Never throws. */
export async function relayMatrixToTelegram(
  env: Env,
  roomId: string,
  sender: string,
  text: string
): Promise<void> {
  try {
    const bridges = await getBridgesForRoom(env.DB, roomId);
    if (bridges.length === 0) return;
    // Skip bot senders (loop prevention): the bridge bot posting a Telegram
    // message into the room must not be forwarded back to Telegram.
    const { isBotUser } = await import('./bots');
    if (await isBotUser(env.DB, sender)) return;
    // Prefix with the speaker so the Telegram side sees who said what.
    let name = sender;
    try {
      const member = await env.DB
        .prepare(
          `SELECT e.content FROM room_state rs JOIN events e ON rs.event_id = e.event_id
           WHERE rs.room_id = ? AND rs.event_type = 'm.room.member' AND rs.state_key = ?`
        )
        .bind(roomId, sender)
        .first<{ content: string }>();
      if (member) {
        const parsed = JSON.parse(member.content) as { displayname?: string };
        if (parsed.displayname) name = parsed.displayname;
      }
    } catch {
      // fall back to the mxid
    }
    const payload = `${name}: ${text}`;
    // Plain text only: never parse_mode, so relayed content cannot inject
    // Telegram formatting.
    const results = await Promise.allSettled(
      bridges.map((b) => tgCall(b.tg_token, 'sendMessage', { chat_id: b.chat_id, text: payload }))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[telegram-bridge] sendMessage failed:', r.reason);
      } else if (!r.value.ok) {
        console.error('[telegram-bridge] sendMessage rejected:', r.value.description);
      }
    }
  } catch (err) {
    console.error('[telegram-bridge] relay failed:', err);
  }
}

// --- Telegram -> Matrix ---

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
    photo?: unknown;
    document?: unknown;
    sticker?: unknown;
    voice?: unknown;
    audio?: unknown;
    video?: unknown;
  };
}

/**
 * Process one webhook update. Returns true when handled (Telegram expects a
 * 200 so it stops retrying — we also 200 on unknown/duplicate updates).
 * Never throws.
 */
export async function processTelegramUpdate(
  env: Env,
  bridge: TelegramBridgeRow,
  update: TelegramUpdate
): Promise<boolean> {
  try {
    // At-least-once delivery: skip replays of anything at or before the last
    // seen update id (webhook updates arrive in order).
    if (update.update_id <= bridge.last_update_id) return true;
    await env.DB
      .prepare(`UPDATE telegram_bridges SET last_update_id = ? WHERE id = ?`)
      .bind(update.update_id, bridge.id)
      .run();

    const msg = update.message;
    if (!msg) return true;
    // Only relay messages from the bridged chat.
    if (String(msg.chat.id) !== String(bridge.chat_id)) return true;

    let body: string;
    if (typeof msg.text === 'string' && msg.text.length > 0) {
      body = msg.text;
    } else if (msg.photo || msg.document || msg.sticker || msg.voice || msg.audio || msg.video) {
      const kind = msg.photo ? 'photo'
        : msg.document ? 'document'
        : msg.sticker ? 'sticker'
        : msg.voice ? 'voice message'
        : msg.audio ? 'audio'
        : 'video';
      body = `[telegram ${kind}]` + (msg.caption ? ` ${msg.caption}` : '');
    } else {
      return true; // service messages / unsupported — ack silently.
    }

    const senderName = msg.from?.first_name
      ? `${msg.from.first_name}${msg.from.username ? ` (@${msg.from.username})` : ''}`
      : 'telegram user';

    const { performSendEvent } = await import('../api/rooms');
    const result = await performSendEvent(env, bridge.room_id, bridge.bot_user_id, 'm.room.message', {
      msgtype: 'm.text',
      body: `[TG] ${senderName}: ${body}`,
    });
    if ('error' in result) {
      console.error('[telegram-bridge] matrix send failed:', result.error.errcode);
    }
    return true;
  } catch (err) {
    console.error('[telegram-bridge] update processing failed:', err);
    // Ack anyway: retrying the same update would replay the same failure.
    return true;
  }
}
