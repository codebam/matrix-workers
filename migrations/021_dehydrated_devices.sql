-- MSC3814 dehydrated devices (single slot per user).
--
-- When Element sets up recovery it creates a "dehydrated device" on the
-- server: a device whose private keys are encrypted client-side (device_data)
-- and whose public device keys are served like any other device. The server
-- keeps one slot per user; a new PUT replaces it and DELETE removes it.

CREATE TABLE IF NOT EXISTS dehydrated_devices (
  user_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_data TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);
