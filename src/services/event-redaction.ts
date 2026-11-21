// Serve-side redaction: when a redaction lands (locally or over
// federation), the target event's client-facing content is pruned to the
// room version's redaction keep rules and stored in events.redacted_content
// (the original `content` stays intact for federation hashes/signatures),
// with `unsigned.redacted_because` carrying the redaction event.

import { computeRedactedContent } from './room-versions';

export async function applyEventRedaction(
  db: D1Database,
  roomId: string,
  roomVersion: string,
  redaction: {
    eventId: string;
    sender: string;
    originServerTs: number;
    content: Record<string, unknown>;
  },
  targetEventId: string
): Promise<void> {
  const targetRow = await db
    .prepare(`SELECT event_type, content, unsigned FROM events WHERE event_id = ?`)
    .bind(targetEventId)
    .first<{ event_type: string; content: string; unsigned: string | null }>();
  if (!targetRow) return;

  let redactedContentJson: string | null = null;
  let mergedUnsigned: string | null = null;
  try {
    const redactedContent = computeRedactedContent(
      targetRow.event_type,
      JSON.parse(targetRow.content),
      roomVersion
    );
    redactedContentJson = JSON.stringify(redactedContent);

    const unsigned = targetRow.unsigned ? JSON.parse(targetRow.unsigned) : {};
    unsigned.redacted_because = {
      type: 'm.room.redaction',
      event_id: redaction.eventId,
      sender: redaction.sender,
      room_id: roomId,
      origin_server_ts: redaction.originServerTs,
      content: { ...redaction.content },
    };
    mergedUnsigned = JSON.stringify(unsigned);
  } catch (pruneErr) {
    console.warn('[redaction] failed to prune redacted content:', pruneErr);
  }

  await db
    .prepare(
      `UPDATE events SET redacted_because = ?,
         redacted_content = COALESCE(?, redacted_content),
         unsigned = COALESCE(?, unsigned)
       WHERE event_id = ?`
    )
    .bind(redaction.eventId, redactedContentJson, mergedUnsigned, targetEventId)
    .run();
}
