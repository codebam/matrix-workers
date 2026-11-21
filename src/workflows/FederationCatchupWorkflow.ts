// Federation Catchup Workflow - Backfill events when a server comes online
//
// Triggered when a previously-offline server is detected as reachable again.
// Requests missing events via /backfill and /get_missing_events.

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env, PDU } from '../types';
import { storeEventIdempotent } from '../services/database';
import { inboundWireEventIdCandidates } from '../utils/event-signing';

// A returned PDU is only useful if it can be stored with the columns the
// idempotent store pipeline needs. Malformed/placeholder entries still count
// as fetched (the workflow's existing count contract) but are not persisted.
function storeablePdu(value: unknown, roomId: string): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pdu = value as Record<string, unknown>;
  return typeof pdu.type === 'string'
    && typeof pdu.sender === 'string'
    && Boolean(pdu.content) && typeof pdu.content === 'object'
    && typeof pdu.origin_server_ts === 'number'
    && (pdu.room_id === undefined || pdu.room_id === roomId);
}

export interface CatchupParams {
  serverName: string;
  roomIds: string[];
}

export interface CatchupResult {
  serverName: string;
  backfilledEvents: number;
  success: boolean;
  error?: string;
}

export class FederationCatchupWorkflow extends WorkflowEntrypoint<Env, CatchupParams> {
  async run(event: WorkflowEvent<CatchupParams>, step: WorkflowStep) {
    const { serverName, roomIds } = event.payload;

    // Step 1: Verify server is reachable
    const isReachable = await step.do('check-server', async () => {
      try {
        const resp = await fetch(`https://${serverName}/_matrix/federation/v1/version`, {
          signal: AbortSignal.timeout(10000),
        });
        return resp.ok;
      } catch {
        return false;
      }
    });

    if (!isReachable) {
      return { serverName, backfilledEvents: 0, success: false, error: 'Server not reachable' };
    }

    let totalBackfilled = 0;

    // Step 2: For each room, request missing events
    for (const roomId of roomIds) {
      const count = await step.do(`backfill-${roomId}`, async () => {
        try {
          // Get our latest event in this room
          const latestEvent = await this.env.DB.prepare(`
            SELECT event_id FROM events WHERE room_id = ? ORDER BY stream_ordering DESC LIMIT 1
          `).bind(roomId).first<{ event_id: string }>();

          if (!latestEvent) return 0;

          // Request missing events from the remote server
          const resp = await fetch(
            `https://${serverName}/_matrix/federation/v1/get_missing_events/${encodeURIComponent(roomId)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                limit: 100,
                earliest_events: [latestEvent.event_id],
                latest_events: [],
              }),
              signal: AbortSignal.timeout(30000),
            }
          );

          if (!resp.ok) return 0;

          const data = await resp.json() as { events?: unknown[] };
          // Preserve the workflow's existing reported-count contract: peers
          // sometimes reply with non-array `events` shapes, which are counted
          // as before but cannot be persisted.
          const reportedCount = data.events?.length || 0;
          const returned = Array.isArray(data.events) ? data.events : [];
          const storeable = returned.filter((raw) => storeablePdu(raw, roomId));

          // A fetch that is never stored leaves the gap open. Persist each
          // accepted PDU through the idempotent pipeline (which allocates a
          // stream position and deduplicates retries). Wire IDs come from the
          // PDU when present; v3+ wire events derive them with the resident's
          // redaction rules, with an existing stored ID taking precedence so
          // we never create a second, phantom copy of a remote event.
          if (storeable.length > 0) {
            const roomRow = await this.env.DB.prepare(
              `SELECT room_version FROM rooms WHERE room_id = ?`
            ).bind(roomId).first<{ room_version: string }>();
            for (const raw of storeable) {
              const pdu = raw as Record<string, unknown>;
              try {
                const candidates = typeof pdu.event_id === 'string' && pdu.event_id
                  ? [pdu.event_id as string]
                  : await inboundWireEventIdCandidates(pdu, roomRow?.room_version);
                let eventId = candidates[0];
                for (const candidate of candidates) {
                  const held = await this.env.DB.prepare(
                    `SELECT 1 FROM events WHERE event_id = ?`
                  ).bind(candidate).first();
                  if (held) {
                    eventId = candidate;
                    break;
                  }
                }
                await storeEventIdempotent(this.env.DB, {
                  ...pdu,
                  event_id: eventId,
                  room_id: roomId,
                  auth_events: Array.isArray(pdu.auth_events) ? pdu.auth_events : [],
                  prev_events: Array.isArray(pdu.prev_events) ? pdu.prev_events : [],
                  depth: typeof pdu.depth === 'number' ? pdu.depth : 0,
                } as PDU);
              } catch (err) {
                console.warn('[federation-catchup] Failed to store returned PDU:', err);
              }
            }
          }

          return reportedCount;
        } catch {
          return 0;
        }
      });

      totalBackfilled += count;
    }

    return { serverName, backfilledEvents: totalBackfilled, success: true };
  }
}
