-- The redaction pipeline (rooms.ts performRedaction) has always written
-- events.redacted_because = <redaction event id>, but no schema file ever
-- declared the column -- every PUT /redact (and, since MSC4169, redactions
-- through PUT /send) 500'd with "no such column" on any database built from
-- schema.sql + the numbered migrations. Add the column (NULL until the event
-- is redacted).
ALTER TABLE events ADD COLUMN redacted_because TEXT;
