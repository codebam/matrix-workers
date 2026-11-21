-- Real incremental presence for legacy /sync.
--
-- The presence table previously stored only current state, so /sync could not
-- tell which users had changed since a token. Each write now advances the
-- 'presence' stream counter and stamps the row with that position; /sync
-- selects rows whose position is newer than the cursor carried in next_batch.
ALTER TABLE presence ADD COLUMN stream_position INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_presence_stream ON presence(stream_position);

-- Existing rows are current state, not history. Backfill them at or before
-- the stream's current position so clients holding a pre-migration token do
-- not receive every existing user as a fresh delta on their next sync.
UPDATE presence
SET stream_position = COALESCE(
  (SELECT position FROM stream_positions WHERE stream_name = 'presence'),
  0
);
