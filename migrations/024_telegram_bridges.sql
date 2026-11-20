-- Telegram bot bridges: one Telegram bot chat <-> one Matrix room, both
-- directions, webhook-driven (Telegram POSTs updates to the homeserver's
-- webhook route, validated by X-Telegram-Bot-Api-Secret-Token). The Telegram
-- bot token is stored raw, like hs_token in appservice_registrations: a
-- server-side credential managed through the admin API, never accepted via
-- room messages (room history is permanent).
CREATE TABLE IF NOT EXISTS telegram_bridges (
  id TEXT PRIMARY KEY,
  bot_user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  tg_token TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  last_update_id INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_bridges_room ON telegram_bridges(room_id);
CREATE INDEX IF NOT EXISTS idx_telegram_bridges_bot ON telegram_bridges(bot_user_id);
