-- MSC4140 delayed events: scheduled client events dispatched by the
-- DelayedEventsDurableObject alarm through the normal send/state path.
CREATE TABLE IF NOT EXISTS delayed_events (
  delay_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state_key TEXT,
  content TEXT NOT NULL,
  delay_ms INTEGER NOT NULL,
  delayed_since_ts INTEGER NOT NULL,
  due_ts INTEGER NOT NULL,
  txn_id TEXT,
  finalised_ts INTEGER,
  final_event_id TEXT,
  final_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_delayed_events_due
  ON delayed_events (due_ts) WHERE finalised_ts IS NULL;

CREATE INDEX IF NOT EXISTS idx_delayed_events_user
  ON delayed_events (user_id);