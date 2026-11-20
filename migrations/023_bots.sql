-- Native bot accounts: users the homeserver itself acts for. Bots never
-- log in (no password is set for them); the server processes their commands
-- and posts their replies through the normal send pipeline. The Telegram
-- bridge bot is also a bot row (kind='telegram') with its bridge config in
-- telegram_bridges.
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'admin',
  command_prefix TEXT NOT NULL DEFAULT '!admin',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_user_id ON bots(user_id);
