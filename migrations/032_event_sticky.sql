-- MSC4354 sticky events (spec v1.20) + the receipt clock they depend on.
--
-- A sticky event is an ordinary PDU carrying a top-level `sticky` object
-- ({"duration_ms": N}). That object is part of the content hash and of the
-- federation wire form, so it must be stored with the event rather than in
-- `unsigned` (which is local-only and never federates).
--
-- `received_ts` is this server's clock at the moment the PDU was stored. The
-- spec computes stickiness expiry from min(received_ts, origin_server_ts),
-- capped at one hour.
--
-- Existing rows keep NULL for both columns; readers fall back to
-- origin_server_ts and treat a NULL `sticky` as "not a sticky event".
ALTER TABLE events ADD COLUMN sticky TEXT;
ALTER TABLE events ADD COLUMN received_ts INTEGER;

-- A delayed event may ask for its eventual send to be sticky (spec v1.20
-- allows combining the two modules).
ALTER TABLE delayed_events ADD COLUMN sticky_duration_ms INTEGER;
