-- Persist the top-level event `origin` (the server that created the event).
--
-- Optional on the wire, but strict residents require it on /send_join and
-- /send_knock PDUs (Tuwunel: "Event does not have an origin server name."),
-- and in room versions 1-10 `origin` is protected from redaction, so it is
-- covered by the reference hash and signature. Serving an event back without
-- the field would change its derived ID and invalidate its hashes, so the
-- value has to survive storage.
ALTER TABLE events ADD COLUMN origin TEXT;
