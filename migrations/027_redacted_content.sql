-- Serve-side redaction: the pruned content a client should see for a
-- redacted event, computed once when the redaction lands (per the room
-- version's redaction keep rules) and stored beside the untouched original
-- -- federation hashes/signatures stay valid over the original `content`,
-- while client-facing reads prefer `redacted_content`.
ALTER TABLE events ADD COLUMN redacted_content TEXT;
