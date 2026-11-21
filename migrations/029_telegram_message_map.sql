-- Telegram -> Matrix bridged-message map. Recording the Matrix event created
-- for each Telegram update lets the bridge render Telegram replies as Matrix
-- rich replies (m.relates_to / m.in_reply_to) with the spec fallback blocks.
-- The original event's sender and rendered text are kept alongside the event
-- id so a fallback can be built without reading the event back from D1.
CREATE TABLE IF NOT EXISTS telegram_message_map (
  chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  matrix_event_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  formatted_body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_message_map_lookup
  ON telegram_message_map(chat_id, telegram_message_id, matrix_event_id);
