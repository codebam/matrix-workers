// Native bot registry. Bots are Matrix users the homeserver itself acts
// for: they never log in (no password is stored for them), and the server
// processes their commands and posts their replies through the normal send
// pipeline. Kind determines behaviour:
//   - 'admin':     in-room admin console (see bot-commands.ts)
//   - 'telegram':  relay account for a Telegram bridge (see telegram-bridge.ts)

export interface BotRow {
  id: string;
  user_id: string;
  kind: string;
  command_prefix: string;
  enabled: number;
  created_at: number;
}

export async function getBotByUserId(db: D1Database, userId: string): Promise<BotRow | null> {
  return await db
    .prepare(`SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots WHERE user_id = ?`)
    .bind(userId)
    .first<BotRow>();
}

export async function getBotById(db: D1Database, id: string): Promise<BotRow | null> {
  return await db
    .prepare(`SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots WHERE id = ?`)
    .bind(id)
    .first<BotRow>();
}

/** All enabled bots joined to a room (command routing / relay targets). */
export async function getEnabledBotsInRoom(db: D1Database, roomId: string): Promise<BotRow[]> {
  const rows = await db
    .prepare(
      `SELECT b.id, b.user_id, b.kind, b.command_prefix, b.enabled, b.created_at
       FROM bots b
       JOIN room_memberships m ON m.user_id = b.user_id
       WHERE m.room_id = ? AND m.membership = 'join' AND b.enabled = 1`
    )
    .bind(roomId)
    .all<BotRow>();
  return rows.results ?? [];
}

export async function listBots(db: D1Database): Promise<BotRow[]> {
  const rows = await db
    .prepare(`SELECT id, user_id, kind, command_prefix, enabled, created_at FROM bots ORDER BY created_at`)
    .all<BotRow>();
  return rows.results ?? [];
}

export async function createBotRow(
  db: D1Database,
  id: string,
  userId: string,
  kind: string,
  commandPrefix: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bots (id, user_id, kind, command_prefix, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)`
    )
    .bind(id, userId, kind, commandPrefix, Date.now())
    .run();
}

export async function setBotEnabled(db: D1Database, id: string, enabled: boolean): Promise<void> {
  await db.prepare(`UPDATE bots SET enabled = ? WHERE id = ?`).bind(enabled ? 1 : 0, id).run();
}

/** Is this user a bot account (any kind)? Used to prevent relay loops. */
export async function isBotUser(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM bots WHERE user_id = ? AND enabled = 1`)
    .bind(userId)
    .first<{ x: number }>();
  return !!row;
}
