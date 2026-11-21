-- Moderation policy lists (spec module): server-side subscriptions to
-- policy rooms. The subscriber is a dedicated local system user whose
-- membership in the policy room keeps state flowing to us; rules are
-- read from that room's m.policy.rule.{user,room,server} state.
CREATE TABLE IF NOT EXISTS policy_list_subscriptions (
  room_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  subscriber_user_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_policy_list_subscriptions_enabled
  ON policy_list_subscriptions(enabled);
