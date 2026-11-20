// In-room admin console. Server admins type commands to a bot (default
// prefix "!admin"); the bot executes them through the same service layer the
// admin HTTP API uses and replies in-room as an m.notice. Only users with
// admin=1 may invoke commands; bot users themselves are ignored (their own
// replies must never re-enter command processing).

import type { Env } from '../types';
import { hashPassword, hashToken } from '../utils/crypto';
import { generateOpaqueId } from '../utils/ids';
import {
  getUserById,
  createRegistrationToken,
  listRegistrationTokens,
  revokeRegistrationToken,
  createUser,
} from './database';
import { sendServerNotice } from '../api/server-notices';
import type { BotRow } from './bots';

interface CommandContext {
  env: Env;
  bot: BotRow;
  roomId: string;
  sender: string;
  args: string[];
}

type CommandHandler = (ctx: CommandContext) => Promise<string>;

const HELP = [
  'admin console commands:',
  '  !admin help',
  '  !admin status                       - server summary + counts',
  '  !admin token mint [uses] [hours]    - mint a registration token (shown once)',
  '  !admin token list',
  '  !admin token revoke <id>',
  '  !admin user list [limit]',
  '  !admin user create <localpart> <password>',
  '  !admin user deactivate <mxid> CONFIRM',
  '  !admin user reset-password <mxid> <new-password>',
  '  !admin federation status            - known peers + last contact',
  '  !admin room kick|ban|unban <roomId> <mxid>',
  '  !admin notice <mxid> <text>',
  '  !admin telegram list               - telegram bridges',
].join('\n');

function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

const commands: Record<string, CommandHandler> = {
  help: async () => HELP,

  status: async ({ env }) => {
    const db = env.DB;
    const users = await db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE is_guest = 0`)
      .first<{ n: number }>();
    const bots = await db.prepare(`SELECT COUNT(*) AS n FROM bots`).first<{ n: number }>();
    const rooms = await db.prepare(`SELECT COUNT(*) AS n FROM rooms`).first<{ n: number }>();
    const events = await db.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>();
    const media = await db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(content_length), 0) AS bytes FROM media`)
      .first<{ n: number; bytes: number }>();
    const reg = env.REGISTRATION_REQUIRE_TOKEN === 'true' ? 'invite-only (tokens)' : 'open';
    return [
      `server ${env.SERVER_NAME} (${env.SERVER_VERSION ?? 'unknown'})`,
      `registration: ${reg}`,
      `users: ${users?.n ?? 0} (bots: ${bots?.n ?? 0})  rooms: ${rooms?.n ?? 0}  events: ${events?.n ?? 0}`,
      `media: ${media?.n ?? 0} objects (${(((media?.bytes ?? 0) / 1048576) || 0).toFixed(1)} MiB)`,
    ].join('\n');
  },

  token: async ({ env, sender, args }) => {
    const sub = args[0] ?? 'list';
    if (sub === 'mint') {
      const uses = Math.min(Math.max(parseInt(args[1] ?? '1', 10) || 1, 1), 100);
      const hours = Math.min(Math.max(parseInt(args[2] ?? '168', 10) || 168, 1), 24 * 365);
      const id = await generateOpaqueId(16);
      const token = 'mrt_' + (await generateOpaqueId(24));
      const expiresAt = Date.now() + hours * 3600_000;
      await createRegistrationToken(
        env.DB, id, await hashToken(token), `admin-bot by ${sender}`, sender, expiresAt, uses
      );
      // The token is a bearer credential shown once, in this (admin-only)
      // room, exactly like the admin HTTP API returns it once.
      return `registration token (shown once):\n${token}\nuses: ${uses}  expires: ${fmtWhen(expiresAt)}`;
    }
    if (sub === 'list') {
      const tokens = await listRegistrationTokens(env.DB);
      if (tokens.length === 0) return 'no registration tokens';
      return (
        'registration tokens:\n' +
        tokens
          .map((t: any) => `  ${t.id}  uses left: ${t.uses_remaining}  expires: ${fmtWhen(t.expires_at)}  note: ${t.note ?? '-'}`)
          .join('\n')
      );
    }
    if (sub === 'revoke') {
      const id = args[1];
      if (!id) return 'usage: !admin token revoke <id>';
      const ok = await revokeRegistrationToken(env.DB, id);
      return ok ? `token ${id} revoked` : `token ${id} not found`;
    }
    return 'usage: !admin token mint|list|revoke';
  },

  user: async ({ env, args }) => {
    const sub = args[0];
    const db = env.DB;
    if (sub === 'list') {
      const limit = Math.min(Math.max(parseInt(args[1] ?? '20', 10) || 20, 1), 100);
      const rows = await db
        .prepare(
          `SELECT user_id, admin, is_deactivated, created_at FROM users
           WHERE is_guest = 0 ORDER BY created_at DESC LIMIT ?`
        )
        .bind(limit)
        .all<{ user_id: string; admin: number; is_deactivated: number; created_at: number }>();
      if (!(rows.results ?? []).length) return 'no users';
      return (
        `latest ${rows.results.length} users:\n` +
        rows.results
          .map((r) => `  ${r.user_id}${r.admin ? ' [admin]' : ''}${r.is_deactivated ? ' [deactivated]' : ''}  ${fmtWhen(r.created_at)}`)
          .join('\n')
      );
    }
    if (sub === 'create') {
      const localpart = args[1];
      const password = args[2];
      if (!localpart || !password || !/^[a-z0-9._=\-\/+]+$/.test(localpart)) {
        return 'usage: !admin user create <localpart> <password>';
      }
      const userId = `@${localpart}:${env.SERVER_NAME}`;
      const existing = await getUserById(db, userId);
      if (existing) return `${userId} already exists`;
      await createUser(db, userId, localpart, await hashPassword(password), false);
      return `created ${userId} (no admin rights; grant via the admin HTTP API)`;
    }
    if (sub === 'deactivate') {
      const userId = args[1];
      if (!userId || args[2] !== 'CONFIRM') {
        return 'destructive: !admin user deactivate <mxid> CONFIRM';
      }
      const res = await db
        .prepare(`UPDATE users SET is_deactivated = 1, updated_at = ? WHERE user_id = ?`)
        .bind(Date.now(), userId)
        .run();
      if ((res.meta.changes ?? 0) === 0) return `${userId} not found`;
      await db
        .prepare(`DELETE FROM access_tokens WHERE user_id = ?`)
        .bind(userId)
        .run();
      return `deactivated ${userId} (sessions revoked)`;
    }
    if (sub === 'reset-password') {
      const userId = args[1];
      const password = args[2];
      if (!userId || !password) return 'usage: !admin user reset-password <mxid> <new-password>';
      const res = await db
        .prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?`)
        .bind(await hashPassword(password), Date.now(), userId)
        .run();
      if ((res.meta.changes ?? 0) === 0) return `${userId} not found`;
      await db
        .prepare(`DELETE FROM access_tokens WHERE user_id = ?`)
        .bind(userId)
        .run();
      return `password reset for ${userId} (sessions revoked)`;
    }
    return 'usage: !admin user list|create|deactivate|reset-password';
  },

  federation: async ({ env }) => {
    const rows = await env.DB
      .prepare(
        `SELECT server_name, last_successful_fetch FROM servers
         ORDER BY last_successful_fetch DESC LIMIT 15`
      )
      .all<{ server_name: string; last_successful_fetch: number | null }>();
    if (!(rows.results ?? []).length) return 'no federation peers recorded yet';
    return (
      'federation peers (latest contact):\n' +
      rows.results.map((r) => `  ${r.server_name}  ${fmtWhen(r.last_successful_fetch)}`).join('\n')
    );
  },

  room: async ({ env, bot, args, sender }) => {
    const op = args[0];
    const targetRoom = args[1];
    const targetUser = args[2];
    if (!targetRoom || !targetUser) {
      return 'usage: !admin room kick|ban|unban <roomId> <mxid>';
    }
    const content =
      op === 'ban' ? { membership: 'ban', reason: `ban via admin bot by ${sender}` }
      : op === 'unban' ? { membership: 'leave', reason: `unban via admin bot by ${sender}` }
      : op === 'kick' ? { membership: 'leave', reason: `kick via admin bot by ${sender}` }
      : null;
    if (!content) return 'usage: !admin room kick|ban|unban <roomId> <mxid>';
    // The act is performed AS THE BOT user through the normal state-event
    // pipeline, so the room's own power levels decide whether it succeeds —
    // grant the bot power in the room to widen what it may do.
    const { performStateEvent } = await import('../api/rooms');
    const result = await performStateEvent(env, targetRoom, bot.user_id, 'm.room.member', targetUser, content);
    if ('error' in result) {
      const e = result.error as { errcode?: string; message?: string };
      return `failed: ${e.errcode ?? ''} ${e.message ?? ''}`.trim();
    }
    return `${op} ${targetUser} in ${targetRoom} done (${result.eventId})`;
  },

  notice: async ({ env, args }) => {
    const target = args[0];
    const text = args.slice(1).join(' ');
    if (!target || !text) return 'usage: !admin notice <mxid> <text>';
    if (!target.endsWith(`:${env.SERVER_NAME}`)) {
      return 'server notices are for local users only';
    }
    await sendServerNotice(env.DB, env.SERVER_NAME, target, text, 'm.text');
    return `server notice sent to ${target}`;
  },

  telegram: async ({ env }) => {
    const rows = await env.DB
      .prepare(
        `SELECT id, bot_user_id, room_id, chat_id, enabled FROM telegram_bridges ORDER BY created_at`
      )
      .all();
    if (!(rows.results ?? []).length) return 'no telegram bridges (register via the admin API)';
    return (
      'telegram bridges:\n' +
      rows.results
        .map((r: any) => `  ${r.id}  bot ${r.bot_user_id}  room ${r.room_id}  chat ${r.chat_id}${r.enabled ? '' : ' [disabled]'}`)
        .join('\n')
    );
  },
};

/**
 * Try to run an admin console command. Returns the reply body, or null when
 * the message is not a command for this bot. Never throws.
 */
export async function tryHandleAdminCommand(
  env: Env,
  bot: BotRow,
  roomId: string,
  sender: string,
  body: string
): Promise<string | null> {
  try {
    const prefix = bot.command_prefix || '!admin';
    if (!body.startsWith(prefix)) return null;
    const rest = body.slice(prefix.length).trim();
    if (!rest) return null;
    const parts = rest.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);
    const handler = commands[cmd];
    if (!handler) return `unknown command "${cmd}" — try ${prefix} help`;
    // Permission gate: server admins only. The sender must be a real local
    // user with admin=1; bot users can never invoke (isBotUser is checked by
    // the caller, but double-guard here).
    const admin = await getUserById(env.DB, sender);
    if (!admin || !admin.admin) {
      return 'not authorized (server admins only)';
    }
    const ctx: CommandContext = { env, bot, roomId, sender, args };
    return await handler(ctx);
  } catch (err) {
    console.error('[bot-commands] handler failed:', err);
    return `command failed: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
}
