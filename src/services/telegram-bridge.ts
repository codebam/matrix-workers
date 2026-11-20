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
//   are relayed to the Telegram Bot API. Text goes out as sendMessage;
//   images (m.image / m.sticker / image-typed m.file) are resolved from the
//   media repo and uploaded as sendPhoto (sendDocument for SVG or >10MB).
//   Bot senders are skipped — the bridge bot's own messages must never loop
//   back. Telegram -> Matrix image updates are downloaded via getFile and
//   stored in our media repo, so the room references a mxc:// URI we serve.
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

/** Largest payload Telegram accepts for sendPhoto. */
const MAX_TG_PHOTO_BYTES = 10 * 1024 * 1024;
/** Bot API cap for file downloads (getFile/file). */
const MAX_TG_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** MIME types Telegram renders inline via sendPhoto. */
const TG_PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);

interface ResolvedMedia {
  bytes: ArrayBuffer;
  contentType: string;
  filename?: string;
}

/** Fetch the bytes behind an mxc:// URI: our R2 for local media, the
 *  MSC3916 signed federation download path (with its R2 cache) for media
 *  on other servers. Returns null when the bytes are unavailable. */
async function resolveMatrixMedia(env: Env, mxcUrl: string): Promise<ResolvedMedia | null> {
  const match = /^mxc:\/\/([^/?#]+)\/([^/?#]+)/.exec(mxcUrl);
  if (!match) return null;
  const [, serverName, mediaId] = match;
  try {
    if (serverName === env.SERVER_NAME) {
      const obj = await env.MEDIA.get(mediaId);
      if (!obj) return null;
      return {
        bytes: await obj.arrayBuffer(),
        contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
        filename: obj.customMetadata?.filename || undefined,
      };
    }
    // Remote media: signed MSC3916 federation download, cached in R2.
    // Dynamic import keeps the api <-> service boundary acyclic.
    const { fetchRemoteMedia } = await import('../api/media');
    const remote = await fetchRemoteMedia(env, serverName, mediaId);
    return remote
      ? { bytes: remote.body, contentType: remote.contentType, filename: remote.filename }
      : null;
  } catch (err) {
    console.warn('[telegram-bridge] media resolve failed:', err);
    return null;
  }
}

async function tgCallForm(
  token: string,
  method: string,
  form: FormData
): Promise<{ ok: boolean; description?: string }> {
  // No Content-Type header: the runtime sets the multipart boundary.
  const res = await fetch(`${TG_API}/bot${token}/${method}`, { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  return { ok: !!data.ok, description: data.description };
}

/** sendPhoto for inline rendering, sendDocument for anything Telegram will
 *  not show inline (SVG) or that exceeds the photo size cap. Never throws. */
async function tgSendImage(
  token: string,
  chatId: string,
  media: ResolvedMedia,
  caption: string
): Promise<{ ok: boolean; description?: string }> {
  const asPhoto =
    TG_PHOTO_MIMES.has(media.contentType) && media.bytes.byteLength <= MAX_TG_PHOTO_BYTES;
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) form.append('caption', caption.slice(0, 1024));
  // Telegram reflects filenames in its client UI: strip anything unsafe.
  const safeName = (media.filename && media.filename.replace(/[^\w.\-]/g, '_')) || 'image';
  form.append(asPhoto ? 'photo' : 'document', new Blob([media.bytes], { type: media.contentType }), safeName);
  return tgCallForm(token, asPhoto ? 'sendPhoto' : 'sendDocument', form);
}

/** Relay a Matrix room message to every bridge on that room. Text goes out
 *  as sendMessage; images are resolved from the media repo and uploaded via
 *  sendPhoto/sendDocument, falling back to a text notice when the bytes are
 *  unavailable. Never throws. */
export async function relayMatrixToTelegram(
  env: Env,
  roomId: string,
  sender: string,
  content: Record<string, unknown> | null | undefined
): Promise<void> {
  try {
    if (!content) return;
    const body = typeof content.body === 'string' ? content.body : null;
    if (!body) return;
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

    const msgtype = typeof content.msgtype === 'string' ? content.msgtype : null;
    const url = typeof content.url === 'string' ? content.url : null;
    const info = (content.info ?? null) as { mimetype?: unknown } | null;
    const mimetype = typeof info?.mimetype === 'string' ? info.mimetype : null;
    // m.image and m.sticker are always images; m.file (or a msgtype-less
    // m.sticker event) counts when its info says image/*.
    const isImage = !!url && (
      msgtype === 'm.image' ||
      msgtype === 'm.sticker' ||
      (msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote' &&
        !!mimetype && mimetype.startsWith('image/'))
    );

    if (isImage) {
      const media = await resolveMatrixMedia(env, url);
      if (media) {
        const caption = `${name}: ${body}`;
        const results = await Promise.allSettled(
          bridges.map((b) => tgSendImage(b.tg_token, String(b.chat_id), media, caption))
        );
        for (const r of results) {
          if (r.status === 'rejected') {
            console.error('[telegram-bridge] sendImage failed:', r.reason);
          } else if (!r.value.ok) {
            console.error('[telegram-bridge] sendImage rejected:', r.value.description);
          }
        }
        return;
      }
      // Bytes unavailable (deleted media, unreachable remote): still tell
      // the Telegram side what was posted instead of dropping it silently.
      const fallback = `${name}: [image] ${body}`;
      const results = await Promise.allSettled(
        bridges.map((b) => tgCall(b.tg_token, 'sendMessage', { chat_id: b.chat_id, text: fallback }))
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          console.error('[telegram-bridge] sendMessage failed:', r.reason);
        } else if (!r.value.ok) {
          console.error('[telegram-bridge] sendMessage rejected:', r.value.description);
        }
      }
      return;
    }

    const payload = `${name}: ${body}`;
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

interface TgPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface TgFileObject {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TgSticker {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
  mime_type?: string;
  emoji?: string;
}

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

interface TgImage {
  file: TgPhotoSize | TgFileObject | TgSticker;
  mime: string;
  filename: string;
  width?: number;
  height?: number;
  sticker: boolean;
}

/** Pull the relayable image out of a Telegram message, if it has one.
 *  Photos come as a size ladder (pick the largest); documents only when
 *  image-typed; stickers only in the static webp form — animated .tgs and
 *  video stickers stay placeholders. */
function extractTgImage(msg: NonNullable<TelegramUpdate['message']>): TgImage | null {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const sizes = msg.photo as TgPhotoSize[];
    const area = (s: TgPhotoSize) => s.file_size ?? (s.width ?? 0) * (s.height ?? 0);
    const best = sizes.reduce((a, b) => (area(b) > area(a) ? b : a));
    return {
      file: best,
      mime: 'image/jpeg',
      filename: 'photo.jpg',
      width: best.width,
      height: best.height,
      sticker: false,
    };
  }
  const doc = msg.document as TgFileObject | undefined;
  if (doc && typeof doc.mime_type === 'string' && doc.mime_type.startsWith('image/')) {
    return {
      file: doc,
      mime: doc.mime_type,
      filename: typeof doc.file_name === 'string' && doc.file_name ? doc.file_name : 'image',
      width: doc.width,
      height: doc.height,
      sticker: false,
    };
  }
  const st = msg.sticker as TgSticker | undefined;
  if (st && st.mime_type === 'image/webp') {
    return {
      file: st,
      mime: 'image/webp',
      filename: 'sticker.webp',
      width: st.width,
      height: st.height,
      sticker: true,
    };
  }
  return null;
}

/** Download a file from Telegram via getFile (bot downloads are capped at
 *  20MB by the Bot API). Returns null on any failure. */
async function downloadTelegramFile(
  token: string,
  file: { file_id: string; file_size?: number },
  fallbackMime: string
): Promise<ResolvedMedia | null> {
  if (typeof file.file_size === 'number' && file.file_size > MAX_TG_DOWNLOAD_BYTES) return null;
  try {
    const info = await fetch(`${TG_API}/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: file.file_id }),
    });
    const data = (await info.json().catch(() => null)) as
      | { result?: { file_path?: string } }
      | null;
    const filePath = data?.result?.file_path;
    if (!filePath) return null;
    const res = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_TG_DOWNLOAD_BYTES) return null;
    const header = (res.headers.get('Content-Type') || '').split(';')[0].trim();
    // Telegram serves some files as octet-stream: trust the declared kind.
    return { bytes, contentType: header && header !== 'application/octet-stream' ? header : fallbackMime };
  } catch (err) {
    console.warn('[telegram-bridge] Telegram file download failed:', err);
    return null;
  }
}

/** Store downloaded bytes in our media repo (R2 + D1 row, exactly like an
 *  upload) so the room event can reference mxc://<server>/<id>. Returns
 *  the media id, or null on failure. */
async function storeBridgeMedia(
  env: Env,
  ownerId: string,
  media: ResolvedMedia
): Promise<string | null> {
  try {
    const mediaId = await generateOpaqueId(24);
    await env.MEDIA.put(mediaId, media.bytes, {
      httpMetadata: { contentType: media.contentType },
      customMetadata: {
        userId: ownerId,
        filename: media.filename ?? '',
        uploadedAt: Date.now().toString(),
      },
    });
    await env.DB.prepare(
      `INSERT INTO media (media_id, user_id, content_type, content_length, filename, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(mediaId, ownerId, media.contentType, media.bytes.byteLength, media.filename ?? null, Date.now())
      .run();
    return mediaId;
  } catch (err) {
    console.warn('[telegram-bridge] media store failed:', err);
    return null;
  }
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

    const senderName = msg.from?.first_name
      ? `${msg.from.first_name}${msg.from.username ? ` (@${msg.from.username})` : ''}`
      : 'telegram user';

    const { performSendEvent } = await import('../api/rooms');

    // Images are downloaded from Telegram, stored in our media repo, and
    // posted as m.image / m.sticker events carrying the mxc URI. Failure at
    // any step falls through to the placeholder text below, so the room
    // still hears about the image instead of losing it.
    if (typeof msg.text !== 'string' || msg.text.length === 0) {
      const img = extractTgImage(msg);
      if (img) {
        const media = await downloadTelegramFile(bridge.tg_token, img.file, img.mime);
        const mediaId = media ? await storeBridgeMedia(env, bridge.bot_user_id, { ...media, filename: img.filename }) : null;
        if (media && mediaId) {
          const caption = `[TG] ${senderName}: ${msg.caption ?? img.filename}`;
          const info: Record<string, unknown> = {
            mimetype: media.contentType,
            size: media.bytes.byteLength,
          };
          if (img.width) info.w = img.width;
          if (img.height) info.h = img.height;
          const eventType = img.sticker ? 'm.sticker' : 'm.room.message';
          const content: Record<string, unknown> = {
            body: caption,
            url: `mxc://${env.SERVER_NAME}/${mediaId}`,
            info,
          };
          if (!img.sticker) {
            content.msgtype = 'm.image';
          } else if (typeof (msg.sticker as TgSticker | undefined)?.emoji === 'string') {
            content.emoji = (msg.sticker as TgSticker).emoji;
          }
          const result = await performSendEvent(env, bridge.room_id, bridge.bot_user_id, eventType, content);
          if ('error' in result) {
            console.error('[telegram-bridge] matrix send failed:', result.error.errcode);
          }
          return true;
        }
      }
    }

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
