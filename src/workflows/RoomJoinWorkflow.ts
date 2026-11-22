// Room Join Workflow - Durable execution for reliable room joins
//
// This workflow handles room joins with:
// - Automatic retry on failures
// - Federation handshake (make_join → send_join) with backoff
// - Batched member notifications
// - Step persistence for resume on failure

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types';
import { generateEventId } from '../utils/ids';
import { calculateContentHash, signJson } from '../utils/crypto';
import {
  computeWireEventId,
  redactEventForSigning,
  toWireEventObject,
} from '../utils/event-signing';
import {
  storeEvent,
  storeEventIdempotent,
  updateMembership,
  getRoomMembers,
  getStateEvent,
  getRoomEvents,
  getMembership,
} from '../services/database';
import { getServerSigningKey, federationGet, federationPut } from '../services/federation-keys';
import {
  deriveRoomWireEvents,
  prepareOutboundPdu,
  wireForRoom,
} from '../services/event-wire';
import { getRoomVersion } from '../services/room-versions';
import { applyEventRedaction } from '../services/event-redaction';
import {
  askPolicyServerSignature,
  attachPolicySignature,
  eventExemptFromPolicy,
  getRoomPolicyServer,
} from '../services/policy-server';
import { validateRemoteJoinTemplate } from './join-template-validation';
import { MSC4583_ROOM_VERSION } from '../api/msc4583';

// Room versions this homeserver can participate in. make_join must advertise
// these via ?ver= or resident servers reject modern rooms (e.g. v12) with
// M_INCOMPATIBLE_ROOM_VERSION. Keep in sync with the federation API's
// SUPPORTED_ROOM_VERSIONS.
const SUPPORTED_ROOM_VERSIONS = [
  '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', MSC4583_ROOM_VERSION,
];

// Parameters passed when triggering the workflow
export interface JoinParams {
  roomId: string;
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  isRemote: boolean;
  remoteServer?: string;
  reason?: string;
  // Additional participant servers (from directory resolution) to try if the
  // resident server is unreachable or rejects us (e.g. it fetches keys on a
  // port we don't serve).
  servers?: string[];
  // When true, backfill full room state + members after join (large rooms).
  backfill?: boolean;
  // Newest local stream position at /join request time. Local events written
  // after it but before send_join lands have no federation destination yet;
  // the workflow re-sweeps them once the handshake registers us remotely.
  sinceStreamOrdering?: number;
}

// Result returned when workflow completes
export interface JoinResult {
  eventId: string;
  roomId: string;
  success: boolean;
  error?: string;
}

// Serializable event data for workflow steps
// Using any for content to avoid TypeScript serialization issues with Cloudflare Workflows
interface SerializableEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: any;
  origin_server_ts: number;
  depth: number;
  auth_events: string[];
  prev_events: string[];
}

export class RoomJoinWorkflow extends WorkflowEntrypoint<Env, JoinParams> {
  async run(event: WorkflowEvent<JoinParams>, step: WorkflowStep): Promise<JoinResult> {
    const { roomId, userId, isRemote, remoteServer, displayName, avatarUrl, reason, servers, backfill, sinceStreamOrdering } = event.payload;

    console.log('[RoomJoinWorkflow] Starting join', { roomId, userId, isRemote, remoteServer });

    // Resident first, then any directory-provided participants, deduplicated.
    const candidateServers = [...new Set([remoteServer, ...(servers ?? [])].filter((s): s is string => !!s))];
    let chosenServer = remoteServer;

    try {
      // Step 1: For remote joins, get join template from remote server
      let remoteEventTemplate: { room_version: string; event: any; server?: string } | null = null;
      if (isRemote && remoteServer) {
        remoteEventTemplate = await step.do('make-join', {
          retries: {
            limit: 3,
            delay: 5000, // 5 seconds in milliseconds
            backoff: 'exponential',
          },
          timeout: 30000, // 30 seconds in milliseconds
        }, async () => {
          return await this.makeJoinWithFallback(candidateServers, roomId, userId);
        }) as { room_version: string; event: any; server?: string } | null;

        if (remoteEventTemplate?.server) chosenServer = remoteEventTemplate.server;

        // Validate the remote-supplied template before trusting any of its
        // fields (auth_events, prev_events, depth, room_id, sender, state_key).
        // A malicious remote could otherwise bypass authorization or trick us
        // into signing a join for the wrong room or user.
        if (remoteEventTemplate) {
          validateRemoteJoinTemplate(remoteEventTemplate, roomId, userId);
        }
      }

      // Step 2: Create and sign the join event
      const joinEventData = await step.do('create-event', async () => {
        return await this.createJoinEvent({
          roomId,
          userId,
          displayName,
          avatarUrl,
          reason,
          remoteEventTemplate,
        });
      }) as SerializableEvent;

      // Step 3: For remote joins, send signed event to remote server
      // send_join for a large public room carries megabytes of state, far
      // above Workflows' 1 MiB step-output cap. Keep the payload in R2 and
      // return only its key; the store step reads it back.
      let sendJoinRef: { stateKey: string } | null = null;
      if (isRemote && remoteServer && joinEventData) {
        sendJoinRef = (await step.do('send-join', {
          retries: {
            limit: 3,
            delay: 5000,
            backoff: 'exponential',
          },
          timeout: 120000,
        }, async () => {
          // MSC4284 (spec v1.18): if the room's state (already known to us
          // from a previous join or a partial state sync) names a policy
          // server, ask it to countersign our join — residents reject
          // unsigned joins in policy rooms. A refusal fails the join here
          // instead of three doomed send_join attempts. Fresh first joins
          // cannot know the room's policy state yet; the resident's
          // send_join rejection is the failure signal for those.
          const policy = await getRoomPolicyServer(this.env.DB, roomId);
          if (policy && !eventExemptFromPolicy(joinEventData as unknown as { type?: unknown; state_key?: unknown })) {
            const asked = await askPolicyServerSignature(
              this.env, policy, joinEventData as unknown as Record<string, unknown>
            );
            if ('signature' in asked) {
              attachPolicySignature(
                joinEventData as unknown as Record<string, unknown>, policy.via, asked.signature
              );
            } else {
              throw new Error(`policy server refused the join: ${asked.error}`);
            }
          }
          const response = await this.sendJoinRequest(chosenServer ?? remoteServer, roomId, joinEventData);
          const stateKey = `join-state/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEventData.event_id)}.json`;
          await this.env.MEDIA.put(stateKey, JSON.stringify(response));
          return { stateKey };
        })) as { stateKey: string };
      }

      // Step 4: Persist event and membership locally
      await step.do('persist', async () => {
        await storeEvent(this.env.DB, joinEventData);
        await updateMembership(this.env.DB, roomId, userId, 'join', joinEventData.event_id);
      });

      // Step 4b: Persist the room state the remote server returned with the
      // accepted join (v2 send_join: auth_chain + state + counter-signed
      // event). Without it, events the remote server later relays to us
      // can't be authorized locally -- auth checks need the full state.
      // This runs after `persist` so the join event already exists locally;
      // when the response echoes the counter-signed join event, the
      // idempotent store simply skips the duplicate.
      if (isRemote && remoteServer) {
        await step.do('store-remote-state', {
          retries: { limit: 2, delay: 2000, backoff: 'exponential' },
          timeout: 300000,
        }, async () => {
          // Derive wire IDs with the resident's room version (see
          // storeRemoteStateEvent): the make_join template negotiated it, and
          // the local rooms row is the fallback for rooms we already hold.
          let localVersion: string | undefined;
          try {
            const localRoom = await this.env.DB.prepare(
              `SELECT room_version FROM rooms WHERE room_id = ?`
            ).bind(roomId).first<{ room_version: string }>();
            localVersion = localRoom?.room_version ?? undefined;
          } catch {
            // Best-effort fallback only; the template version is primary.
          }
          const roomVersion = remoteEventTemplate?.room_version ?? localVersion;
          const storedResponse = sendJoinRef
            ? await this.env.MEDIA.get(sendJoinRef.stateKey)
            : null;
          if (sendJoinRef && !storedResponse) {
            throw new Error(`send_join payload missing from R2: ${sendJoinRef.stateKey}`);
          }
          const joinPayload = storedResponse
            ? await storedResponse.json() as { auth_chain?: any[]; state?: any[]; event?: any }
            : null;
          const remoteEvents = [
            ...(Array.isArray(joinPayload?.auth_chain) ? joinPayload.auth_chain : []),
            ...(Array.isArray(joinPayload?.state) ? joinPayload.state : []),
            ...(joinPayload?.event ? [joinPayload.event] : []),
          ];
          // State snapshot: store with stream_ordering 0 (invisible to
          // timeline serving). The echoed join event was already persisted
          // with a real position in the `persist` step, so the idempotent
          // insert simply skips it here.
          if (typeof this.env.DB.batch === 'function') {
            await this.storeRemoteStateEventsBulk(remoteEvents, roomId, roomVersion, true);
          } else {
            for (const ev of remoteEvents) {
              await this.storeRemoteStateEvent(ev, roomId, roomVersion, true);
            }
          }

          // Some residents return a partial snapshot (missing create/name), so
          // the room renders without a name. Backfill the full current state.
          if (backfill) {
          let haveEssential: { c: number | null; n: number | null } | null = null;
          try {
            haveEssential = await this.env.DB.prepare(
              `SELECT
                 (SELECT 1 FROM room_state WHERE room_id = ? AND event_type = 'm.room.create') AS c,
                 (SELECT 1 FROM room_state WHERE room_id = ? AND event_type = 'm.room.name') AS n`
            ).bind(roomId, roomId).first<{ c: number | null; n: number | null }>();
          } catch {
            // Best-effort completeness check; on failure, fetch the state.
          }
          if (!haveEssential?.c || !haveEssential?.n) {
            try {
              // Synapse's federation /state requires ?event_id=; use the join
              // event to fetch the current state (name + all current members).
              // There is no federation /members endpoint.
              const resp = await federationGet(
                chosenServer ?? remoteServer!,
                `/_matrix/federation/v1/state/${encodeURIComponent(roomId)}?event_id=${encodeURIComponent(joinEventData.event_id)}`,
                this.env.SERVER_NAME,
                this.env.DB,
                this.env.CACHE
              );
              if (resp.ok) {
                const data = (await resp.json()) as { pdus?: any[]; auth_chain?: any[] };
                const fetched = [...(data.auth_chain ?? []), ...(data.pdus ?? [])];
                if (typeof this.env.DB.batch === 'function') {
                  await this.storeRemoteStateEventsBulk(fetched, roomId, roomVersion, true);
                } else {
                  for (const ev of fetched) {
                    await this.storeRemoteStateEvent(ev, roomId, roomVersion, true);
                  }
                }
              }
            } catch (e) {
              console.warn('[RoomJoinWorkflow] state backfill failed', {
                roomId,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          }
          // Only after every consumer succeeded: a step retry must still find
          // the payload if a later operation in this step throws.
          if (sendJoinRef) await this.env.MEDIA.delete(sendJoinRef.stateKey);
        });
      }

      // Close the /join race (after step 4b, deliberately). Locally-written
      // events (resident messages, state changes) from the handshake window
      // had no federation destination yet: the send path only queues a wire
      // PDU once a joined REMOTE member exists, and those destinations come
      // from room_memberships (getJoinedRemoteServers). `persist` above only
      // stores the local joiner's membership; the remote members that populate
      // our destination list are registered by store-remote-state (step 4b).
      // Sweeping before that step left a second gap: events written after the
      // sweep but before the remote members landed were stored locally yet
      // never queued. Running the sweep here — after destinations exist, before
      // the joining server sends through the normal path — covers the whole
      // /join → send_join → state-sync window in one durable step.
      if (isRemote && remoteServer && typeof sinceStreamOrdering === 'number') {
        await step.do('resweep-recent-events', {
          retries: { limit: 2, delay: 1000, backoff: 'exponential' },
          timeout: 30000,
        }, async () => {
          await this.resweepLocalEventsToServer(
            roomId, chosenServer ?? remoteServer, sinceStreamOrdering, joinEventData.event_id
          );
        });
      }

      // Step 4c: Backfill the room's recent TIMELINE. The join response only
      // carries state (create/PL/join_rules/members) — without a history fetch
      // the room renders with every member but an empty timeline, and the
      // user sees none of the recent messages. Synapse backfills after
      // joining via the federation /backfill endpoint; so do we. Best-effort:
      // a failed history fetch never fails the join.
      if (backfill && remoteServer) {
        await step.do('backfill-timeline', async () => {
          let roomVersion = remoteEventTemplate?.room_version;
          try {
            const localRoom = await this.env.DB.prepare(
              `SELECT room_version FROM rooms WHERE room_id = ?`
            ).bind(roomId).first<{ room_version: string }>();
            roomVersion = roomVersion ?? localRoom?.room_version;
          } catch {
            // Best-effort fallback only; the template version is primary.
          }
          try {
            const resp = await federationGet(
              chosenServer ?? remoteServer,
              `/_matrix/federation/v1/backfill/${encodeURIComponent(roomId)}?v=${encodeURIComponent(joinEventData.event_id)}&limit=50`,
              this.env.SERVER_NAME,
              this.env.DB,
              this.env.CACHE
            );
            if (!resp.ok) {
              console.warn('[RoomJoinWorkflow] timeline backfill non-OK', {
                roomId, status: resp.status,
              });
              return;
            }
            const data = (await resp.json()) as { pdus?: any[] };
            const pdus = Array.isArray(data.pdus) ? data.pdus : [];
            // /backfill returns newest-first; store oldest-first so stream
            // positions ascend with chronology and /sync renders history in
            // order. storeRemoteStateEvent derives IDs with the room version
            // (v1-10 redaction keeps origin/prev_state, so residents' IDs
            // reproduce exactly) and keeps memberships/state in sync.
            // Real history: stateOnly stays false so backfilled messages
            // keep ascending stream positions and appear in the timeline.
            const history = [...pdus].reverse();
            if (typeof this.env.DB.batch === 'function') {
              await this.storeRemoteStateEventsBulk(history, roomId, roomVersion, false);
            } else {
              for (const ev of history) {
                await this.storeRemoteStateEvent(ev, roomId, roomVersion);
              }
            }
            console.log('[RoomJoinWorkflow] timeline backfill stored', {
              roomId, count: pdus.length,
            });
          } catch (e) {
            console.warn('[RoomJoinWorkflow] timeline backfill failed', {
              roomId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
      }

      // Step 5: Get room members for notification
      const members = await step.do('get-members', async () => {
        const memberList = await getRoomMembers(this.env.DB, roomId);
        // Only local users can be notified (remote users have no Sync DO
        // here). A large public room has thousands of remote members, which
        // would also exceed Workflows' 1 MiB step-output cap.
        const localSuffix = `:${this.env.SERVER_NAME}`;
        // Exclude the joining user and cap the fan-out per join.
        return memberList
          .filter(m => m.userId.endsWith(localSuffix) && m.userId !== userId)
          .slice(0, 5000)
          .map(m => ({ userId: m.userId }));
      }) as Array<{ userId: string }>;

      // Step 6: Notify members in batches of 50
      const BATCH_SIZE = 50;
      for (let i = 0; i < members.length; i += BATCH_SIZE) {
        const batch = members.slice(i, i + BATCH_SIZE);
        await step.do(`notify-batch-${i}`, async () => {
          await this.notifyMemberBatch(batch, joinEventData);
        });
      }

      console.log('[RoomJoinWorkflow] Join completed successfully', { roomId, userId, eventId: joinEventData.event_id });

      return {
        eventId: joinEventData.event_id,
        roomId,
        success: true,
      };
    } catch (error) {
      console.error('[RoomJoinWorkflow] Join failed', { roomId, userId, error });
      return {
        eventId: '',
        roomId,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Re-deliver locally written events from the /join → send_join gap. The
  // send path only prepares a wire PDU when it already has remote
  // destinations (joined remote members in room_memberships); during the gap
  // there were none, so nothing was queued for the joining server. This sweep
  // runs after store-remote-state has registered those members, so sends from
  // here on fan out normally and this covers exactly the finite window where
  // they could not.
  private async resweepLocalEventsToServer(
    roomId: string,
    destination: string,
    sinceStreamOrdering: number,
    joinEventId: string
  ): Promise<void> {
    const SWEEP_LIMIT = 200;
    try {
      const rows = await this.env.DB.prepare(
        `SELECT event_id, room_id, sender, event_type, state_key, content,
                origin_server_ts, depth, auth_events, prev_events, hashes, signatures
         FROM events
         WHERE room_id = ? AND stream_ordering > ? AND stream_ordering > 0
           AND sender LIKE ? AND event_id <> ?
         ORDER BY stream_ordering ASC LIMIT ?`
      ).bind(roomId, sinceStreamOrdering, `%:${this.env.SERVER_NAME}`, joinEventId, SWEEP_LIMIT)
        .all<Record<string, any>>();
      const events = rows.results ?? [];
      if (events.length === 0) return;

      const room = await this.env.DB.prepare(
        `SELECT room_version FROM rooms WHERE room_id = ?`
      ).bind(roomId).first<{ room_version: string }>();
      const roomVersion = room?.room_version ?? '10';
      const numericVersion = parseInt(roomVersion, 10);
      const creator = await this.env.DB.prepare(
        `SELECT e.sender FROM room_state rs
         JOIN events e ON rs.event_id = e.event_id
         WHERE rs.room_id = ? AND rs.event_type = 'm.room.create'`
      ).bind(roomId).first<{ sender: string }>();
      const localCreate = !!creator?.sender?.endsWith(`:${this.env.SERVER_NAME}`);
      // Re-derive local rooms (including v11, which the serving-side helper
      // leaves as-stored) so random pre-destination IDs and their references
      // become the wire IDs peers expect. Never re-derive a remote-created
      // legacy room: our stored bytes cannot reproduce the resident's IDs.
      const wire = numericVersion >= 3 && (localCreate || roomVersion === '12')
        ? await deriveRoomWireEvents(this.env, roomId, roomVersion)
        : await wireForRoom(this.env, roomId, roomVersion);

      let queued = 0;
      for (const row of events) {
        const storedId = String(row.event_id);
        let wireId = storedId;
        let pdu: Record<string, unknown> | null = null;
        if (wire) {
          pdu = wire.wireById.get(storedId) ?? null;
          wireId = wire.idMap.get(storedId) ?? storedId;
        } else if (!Number.isFinite(numericVersion) || numericVersion <= 2) {
          // Room versions 1-2 keep explicit IDs on the wire. Sign the stored
          // content if it predates the wire-form derivation, retaining the ID.
          const event: Record<string, any> = {
            event_id: storedId,
            room_id: row.room_id,
            sender: row.sender,
            type: row.event_type,
            content: JSON.parse(row.content),
            origin_server_ts: row.origin_server_ts,
            depth: row.depth,
            auth_events: JSON.parse(row.auth_events),
            prev_events: JSON.parse(row.prev_events),
          };
          if (row.state_key !== null && row.state_key !== undefined) event.state_key = row.state_key;
          if (row.hashes) event.hashes = JSON.parse(row.hashes);
          if (row.signatures) event.signatures = JSON.parse(row.signatures);
          const prepared = await prepareOutboundPdu(
            this.env, event as unknown as Parameters<typeof prepareOutboundPdu>[1], roomVersion
          );
          if (prepared) pdu = { ...prepared.wire, event_id: storedId };
        }
        if (!pdu) continue;
        await this.queueResweepPdu(destination, wireId, roomId, pdu);
        queued++;
      }
      console.log('[RoomJoinWorkflow] re-swept local events after handshake', {
        roomId, destination, found: events.length, queued,
      });
    } catch (err) {
      // Best-effort: a sweep failure must not fail an otherwise accepted join.
      console.warn('[RoomJoinWorkflow] recent-event re-sweep failed', {
        roomId, destination, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // One durable DO queue put with a hard timeout. A stuck destination must
  // never wedge the workflow step (Worker subrequest limits); delivery itself
  // remains durable in the Federation DO's alarm queue.
  private async queueResweepPdu(
    destination: string,
    eventId: string,
    roomId: string,
    pdu: Record<string, unknown>
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const fedDO = this.env.FEDERATION.get(this.env.FEDERATION.idFromName(destination));
      await fedDO.fetch(new Request('http://internal/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination, event_id: eventId, room_id: roomId, pdu }),
        signal: controller.signal,
      }));
    } catch (err) {
      console.warn('[RoomJoinWorkflow] re-sweep queue failed', {
        destination, eventId, error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Make an authenticated make_join request to a remote server.
  // Try make_join against the resident server first, then fallback participants.
  // Some residents fetch our signing key on a port we don't serve (8448) and
  // reject us; other participants in the same room may accept over 443.
  private async makeJoinWithFallback(
    candidates: string[],
    roomId: string,
    userId: string
  ): Promise<{ room_version: string; event: any; server: string }> {
    let lastError: unknown = new Error('No candidate servers');
    for (const server of candidates) {
      try {
        const result = await this.makeJoinRequest(server, roomId, userId);
        // A 2xx with a null/empty body means "no template"; fall through to
        // local creation rather than treating it as a valid template.
        if (!result) return null as unknown as { room_version: string; event: any; server: string };
        return { ...result, server };
      } catch (e) {
        lastError = e;
        console.warn('[RoomJoinWorkflow] make_join candidate failed', {
          server,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    throw lastError;
  }

  private async makeJoinRequest(
    remoteServer: string,
    roomId: string,
    userId: string
  ): Promise<{ room_version: string; event: any }> {
    console.log('[RoomJoinWorkflow] Making make_join request', { remoteServer, roomId, userId });

    // Advertise support for our room versions: resident servers intersect this
    // list with the room's version when deciding whether to accept the join.
    const versions = SUPPORTED_ROOM_VERSIONS.map((v) => `ver=${encodeURIComponent(v)}`).join('&');
    const path = `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${encodeURIComponent(userId)}?${versions}`;

    let response: Response;
    try {
      response = await federationGet(
        remoteServer,
        path,
        this.env.SERVER_NAME,
        this.env.DB,
        this.env.CACHE
      );
    } catch (e) {
      console.warn('[RoomJoinWorkflow] make_join transport error', {
        remoteServer,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    if (!response.ok) {
      const error = await response.text();
      console.warn('[RoomJoinWorkflow] make_join non-OK', { remoteServer, status: response.status, error: error.slice(0, 300) });
      throw new Error(`make_join failed: ${response.status} ${error}`);
    }

    const result = await response.json() as { room_version: string; event: any };
    return result;
  }

  // Create a join event (either from remote template or local state)
  private async createJoinEvent(params: {
    roomId: string;
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    reason?: string;
    remoteEventTemplate?: { room_version: string; event: any } | null;
  }): Promise<SerializableEvent> {
    const { roomId, userId, displayName, avatarUrl, reason, remoteEventTemplate } = params;

    let authEvents: string[] = [];
    let prevEvents: string[] = [];
    let depth = 1;

    if (remoteEventTemplate?.event) {
      // Use template from remote server
      authEvents = remoteEventTemplate.event.auth_events || [];
      prevEvents = remoteEventTemplate.event.prev_events || [];
      depth = remoteEventTemplate.event.depth || 1;
    } else {
      // Get local room state
      const createEvent = await getStateEvent(this.env.DB, roomId, 'm.room.create');
      const joinRulesEvent = await getStateEvent(this.env.DB, roomId, 'm.room.join_rules');
      const powerLevelsEvent = await getStateEvent(this.env.DB, roomId, 'm.room.power_levels');
      const currentMembership = await getMembership(this.env.DB, roomId, userId);

      if (createEvent) authEvents.push(createEvent.event_id);
      if (joinRulesEvent) authEvents.push(joinRulesEvent.event_id);
      if (powerLevelsEvent) authEvents.push(powerLevelsEvent.event_id);
      if (currentMembership) authEvents.push(currentMembership.eventId);

      const { events: latestEvents } = await getRoomEvents(this.env.DB, roomId, undefined, 1);
      prevEvents = latestEvents.map(e => e.event_id);
      depth = (latestEvents[0]?.depth ?? 0) + 1;
    }

    const eventId = await generateEventId(this.env.SERVER_NAME);

    // A make_join template can carry authorisation fields (restricted rooms:
    // join_authorised_via_users_server; also third_party_invite). Merge them
    // instead of rebuilding from scratch — dropping them makes the resident
    // reject our join — while local profile fields still take precedence.
    const memberContent: any = {
      ...(remoteEventTemplate?.event?.content ?? {}),
      membership: 'join',
    };

    if (displayName) {
      memberContent.displayname = displayName;
    }
    if (avatarUrl) {
      memberContent.avatar_url = avatarUrl;
    }
    if (reason) {
      memberContent.reason = reason;
    }

    const signingKey = await getServerSigningKey(this.env.DB);
    if (!signingKey) {
      throw new Error('Server signing key not configured');
    }

    const baseEvent = {
      room_id: roomId,
      sender: userId,
      type: 'm.room.member',
      state_key: userId,
      content: memberContent,
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    };

    // Remote joins (any room version) must use the v4+ wire form: the event ID
    // is the reference hash and signatures cover the *redacted* event. Sending
    // a random ID or a full-event signature gets the join rejected by the
    // resident server. Pure-local joins keep the legacy shape below.
    const wireFormat = !!remoteEventTemplate?.event;

    if (wireFormat) {
      // Derive the ID and signature with the resident's room version: the
      // redaction rules for v1-10 differ from v11+ (create/power_levels), so
      // a version-blind derivation produces an ID the resident does not
      // recognize.
      const roomVersion = remoteEventTemplate?.room_version;
      const hashed = {
        ...baseEvent,
        hashes: {
          sha256: await calculateContentHash(baseEvent as unknown as Record<string, unknown>),
        },
      };
      const eventId = await computeWireEventId(hashed as unknown as Record<string, unknown>, roomVersion);
      const signed = await signJson(
        redactEventForSigning(hashed as unknown as Record<string, unknown>, roomVersion),
        this.env.SERVER_NAME,
        signingKey.keyId,
        signingKey.privateKeyJwk
      );
      return {
        ...hashed,
        event_id: eventId,
        signatures: (signed as Record<string, unknown>).signatures,
      } as unknown as SerializableEvent;
    }

    const event: SerializableEvent = {
      event_id: eventId,
      ...baseEvent,
    } as SerializableEvent;

    const hashed = {
      ...event,
      hashes: {
        sha256: await calculateContentHash(event as unknown as Record<string, unknown>),
      },
    } as SerializableEvent;

    return (await signJson(
      hashed as unknown as Record<string, unknown>,
      this.env.SERVER_NAME,
      signingKey.keyId,
      signingKey.privateKeyJwk
    )) as unknown as SerializableEvent;
  }

  // Send an authenticated send_join request to a remote server
  private async sendJoinRequest(
    remoteServer: string,
    roomId: string,
    joinEvent: SerializableEvent
  ): Promise<any> {
    console.log('[RoomJoinWorkflow] Sending send_join request', { remoteServer, roomId, eventId: joinEvent.event_id });

    const path = `/_matrix/federation/v2/send_join/${encodeURIComponent(roomId)}/${encodeURIComponent(joinEvent.event_id)}`;

    let response: Response;
    try {
      response = await federationPut(
        remoteServer,
        path,
        // v4+ events must not carry event_id on the wire; the resident server
        // derives the reference hash itself.
        toWireEventObject(joinEvent as unknown as Record<string, unknown>),
        this.env.SERVER_NAME,
        this.env.DB,
        this.env.CACHE
      );
    } catch (e) {
      console.warn('[RoomJoinWorkflow] send_join transport error', {
        remoteServer,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    if (!response.ok) {
      const error = await response.text();
      console.warn('[RoomJoinWorkflow] send_join non-OK', { remoteServer, status: response.status, error: error.slice(0, 300) });
      throw new Error(`send_join failed: ${response.status} ${error}`);
    }

    // v2 send_join returns { auth_chain, origin, state, event }: the join
    // counter-signed by the resident server plus the room's current state.
    return await response.json();
  }

  // Store one remote state/event PDU, deriving wire IDs where omitted and
  // keeping the memberships table in sync. Never throws on a malformed event.
  // The room version MUST be passed in: reference hashes (and therefore wire
  // IDs) use the room version's redaction rules, and v1-10 redacts create and
  // power_levels differently from v11+. A version-blind derivation stores
  // those events under phantom IDs that no resident — or event we later
  // receive — ever references, so every auth lookup against them fails
  // ("missing auth event type m.room.power_levels").
  private async storeRemoteStateEvent(
    ev: any,
    roomId: string,
    roomVersion?: string,
    stateOnly = false
  ): Promise<void> {
    if (!ev || typeof ev !== 'object' || !ev.type) return;
    try {
      const normalized: Record<string, unknown> = { ...ev };
      if (typeof ev.event_id !== 'string' || !ev.event_id) {
        normalized.event_id = await computeWireEventId(ev as Record<string, unknown>, roomVersion);
      }
      if (ev.type === 'm.room.create' && typeof ev.room_id !== 'string') {
        normalized.room_id = `!${String(normalized.event_id).slice(1)}`;
      }
      await storeEventIdempotent(
        this.env.DB,
        normalized as unknown as Parameters<typeof storeEventIdempotent>[1],
        { stateOnly }
      );

      const evStateKey = (ev as { state_key?: unknown }).state_key;
      if (ev.type === 'm.room.member' && typeof evStateKey === 'string') {
        const membership = (ev.content as { membership?: string } | undefined)?.membership;
        if (
          membership === 'join' ||
          membership === 'invite' ||
          membership === 'leave' ||
          membership === 'ban' ||
          membership === 'knock'
        ) {
          await updateMembership(this.env.DB, roomId, evStateKey, membership, String(normalized.event_id));
        }
      }

      // Inbound redactions in backfilled history prune the target's
      // client view too, mirroring the live transaction path.
      if (ev.type === 'm.room.redaction') {
        const behavior = getRoomVersion(String(roomVersion ?? '10'));
        const targetId = behavior?.updatedRedactionRules
          ? (ev.content as { redacts?: unknown } | undefined)?.redacts
          : (ev as { redacts?: unknown }).redacts;
        if (typeof targetId === 'string' && targetId) {
          await applyEventRedaction(
            this.env.DB,
            roomId,
            String(roomVersion ?? '10'),
            {
              eventId: String(normalized.event_id),
              sender: String(ev.sender ?? ''),
              originServerTs: Number(ev.origin_server_ts ?? Date.now()),
              content: (ev.content ?? {}) as Record<string, unknown>,
            },
            targetId
          ).catch((pruneErr) => {
            console.warn('[RoomJoinWorkflow] backfilled redaction prune failed:', pruneErr);
          });
        }
      }
    } catch (storeErr) {
      console.warn('[RoomJoinWorkflow] Skipping remote state event', {
        error: storeErr instanceof Error ? storeErr.message : 'Unknown error',
      });
    }
  }

  /**
   * Store a large federation state snapshot with D1 batches. The per-event
   * path costs ~3 round trips per event and took >30 minutes for a 19k-event
   * public room; batching keeps the same INSERT OR IGNORE / state and
   * membership upsert semantics in far fewer round trips.
   */
  private async storeRemoteStateEventsBulk(
    events: any[],
    roomId: string,
    roomVersion?: string,
    stateOnly = true
  ): Promise<void> {
    const valid = events.filter((ev) => ev && typeof ev === 'object' && typeof ev.type === 'string');
    if (!valid.length) return;

    const normalized = await Promise.all(valid.map(async (ev) => {
      const copy: Record<string, unknown> = { ...ev };
      if (typeof copy.event_id !== 'string' || !copy.event_id) {
        copy.event_id = await computeWireEventId(copy, roomVersion);
      }
      if (ev.type === 'm.room.create' && typeof copy.room_id !== 'string') {
        copy.room_id = `!${String(copy.event_id).slice(1)}`;
      }
      return copy;
    }));

    const CHUNK = 80;
    for (let offset = 0; offset < normalized.length; offset += CHUNK) {
      const chunk = normalized.slice(offset, offset + CHUNK);
      const position = await this.env.DB.prepare(
        `UPDATE stream_positions SET position = position + ? WHERE stream_name = 'events' RETURNING position`
      ).bind(chunk.length).first<{ position: number }>();
      const first = (position?.position ?? chunk.length) - chunk.length + 1;
      const statements: Array<ReturnType<typeof this.env.DB.prepare>> = [];
      chunk.forEach((ev, i) => {
        const streamOrdering = stateOnly ? -(first + i) : first + i;
        statements.push(this.env.DB.prepare(
          `INSERT OR IGNORE INTO events (event_id, room_id, sender, event_type, state_key, content,
           origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(ev.event_id), String(ev.room_id ?? roomId), String(ev.sender ?? ''), String(ev.type),
          typeof ev.state_key === 'string' ? ev.state_key : null,
          JSON.stringify(ev.content ?? {}), Number(ev.origin_server_ts ?? 0),
          ev.unsigned ? JSON.stringify(ev.unsigned) : null, Number(ev.depth ?? 0),
          JSON.stringify(ev.auth_events ?? []), JSON.stringify(ev.prev_events ?? []),
          ev.hashes ? JSON.stringify(ev.hashes) : null,
          ev.signatures ? JSON.stringify(ev.signatures) : null,
          streamOrdering
        ));
        // Only a CURRENT-STATE snapshot may replace room_state/room_memberships.
        // Real timeline backfill legitimately contains historical membership
        // events (old joins/leaves); promoting those to current state makes
        // checkEventAuth reject the sender's live messages as "not joined".
        if (stateOnly) {
          if (typeof ev.state_key === 'string') {
            statements.push(this.env.DB.prepare(
              `INSERT OR REPLACE INTO room_state (room_id, event_type, state_key, event_id) VALUES (?, ?, ?, ?)`
            ).bind(roomId, String(ev.type), ev.state_key, String(ev.event_id)));
          }
          const membership = (ev.content as { membership?: unknown } | undefined)?.membership;
          if (ev.type === 'm.room.member' && typeof ev.state_key === 'string'
            && ['join', 'invite', 'leave', 'ban', 'knock'].includes(String(membership))) {
            statements.push(this.env.DB.prepare(
              `INSERT INTO room_memberships (room_id, user_id, membership, event_id) VALUES (?, ?, ?, ?)
               ON CONFLICT(room_id, user_id) DO UPDATE SET membership = excluded.membership, event_id = excluded.event_id`
            ).bind(roomId, ev.state_key, String(membership), String(ev.event_id)));
          }
        }
      });
      await this.env.DB.batch(statements);
    }

    // Redactions need the live prune side effects; they are rare in a state
    // snapshot, so the per-event helper is fine for those.
    for (const ev of normalized) {
      if (ev.type === 'm.room.redaction') {
        await this.storeRemoteStateEvent(ev, roomId, roomVersion, stateOnly);
      }
    }
  }

  // Notify a batch of members about the join
  private async notifyMemberBatch(
    members: Array<{ userId: string }>,
    joinEvent: SerializableEvent
  ): Promise<void> {
    const promises = members.map(async (member) => {
      try {
        const syncDO = this.env.SYNC;
        const doId = syncDO.idFromName(member.userId);
        const stub = syncDO.get(doId);

        await stub.fetch(new Request('http://internal/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomId: joinEvent.room_id,
            eventId: joinEvent.event_id,
            eventType: joinEvent.type,
          }),
        }));
      } catch (error) {
        console.error('[RoomJoinWorkflow] Failed to notify member', {
          userId: member.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Don't throw - continue notifying other members
      }
    });

    await Promise.all(promises);
  }
}
