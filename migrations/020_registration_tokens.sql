-- Invite-only registration tokens.
--
-- When the worker's REGISTRATION_REQUIRE_TOKEN env var is truthy, every
-- /register call (user or guest) must present a valid, unspent token. Tokens
-- are shown once at creation; only the SHA-256 (base64url) hash is stored.
-- Tokens can be single- or multi-use, expire, and be revoked by an admin.

CREATE TABLE IF NOT EXISTS registration_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  uses_remaining INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_registration_tokens_hash ON registration_tokens(token_hash);
