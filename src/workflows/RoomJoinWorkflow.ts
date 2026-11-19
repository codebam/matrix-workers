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
import { validateRemoteJoinTemplate } from './join-template-validation';

// Room versions this homeserver can participate in. make_join must advertise
// these via ?ver= or resident servers reject modern rooms (e.g. v12) with
// M_INCOMPATIBLE_ROOM_VERSION. Keep in sync with the federation API's
// SUPPORTED_ROOM_VERSIONS.
const SUPPORTED_ROOM_VERSIONS = ['12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1'];

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
    const { roomId, userId, isRemote, remoteServer, displayName, avatarUrl, reason, servers } = event.payload;

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
      let sendJoinResponse: { auth_chain?: any[]; state?: any[]; event?: any } | null = null;
      if (isRemote && remoteServer && joinEventData) {
        sendJoinResponse = (await step.do('send-join', {
          retries: {
            limit: 3,
            delay: 5000,
            backoff: 'exponential',
          },
          timeout: 30000,
        }, async () => {
          return await this.sendJoinRequest(chosenServer ?? remoteServer, roomId, joinEventData);
        })) as { auth_chain?: any[]; state?: any[]; event?: any };
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
      if (sendJoinResponse) {
        await step.do('store-remote-state', async () => {
          const remoteEvents = [
            ...(Array.isArray(sendJoinResponse?.auth_chain) ? sendJoinResponse.auth_chain : []),
            ...(Array.isArray(sendJoinResponse?.state) ? sendJoinResponse.state : []),
            ...(sendJoinResponse?.event ? [sendJoinResponse.event] : []),
          ];
          for (const ev of remoteEvents) {
            if (!ev || typeof ev !== 'object' || !ev.type) continue;
            try {
              const normalized: Record<string, unknown> = { ...ev };
              if (typeof ev.event_id !== 'string' || !ev.event_id) {
                // v4+ events omit event_id on the wire; derive the reference
                // hash the same way the resident server did.
                normalized.event_id = await computeWireEventId(ev as Record<string, unknown>);
              }
              if (ev.type === 'm.room.create' && typeof ev.room_id !== 'string') {
                // v4+ create events also omit room_id; it is the event ID
                // with the sigil swapped.
                normalized.room_id = `!${String(normalized.event_id).slice(1)}`;
              }
              await storeEventIdempotent(
                this.env.DB,
                normalized as unknown as Parameters<typeof storeEventIdempotent>[1]
              );

              // Keep the memberships table in sync with the remote state --
              // federation fan-out picks destinations from it.
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
                  await updateMembership(
                    this.env.DB,
                    roomId,
                    evStateKey,
                    membership,
                    String(normalized.event_id)
                  );
                }
              }
            } catch (storeErr) {
              // Never let one malformed remote event abort the whole join.
              console.warn('[RoomJoinWorkflow] Skipping remote state event', {
                error: storeErr instanceof Error ? storeErr.message : 'Unknown error',
              });
            }
          }
        });
      }

      // Step 5: Get room members for notification
      const members = await step.do('get-members', async () => {
        const memberList = await getRoomMembers(this.env.DB, roomId);
        // Exclude the joining user from notifications
        return memberList.filter(m => m.userId !== userId).map(m => ({ userId: m.userId }));
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

  // Make an authenticated make_join request to a remote server
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

    const memberContent: any = {
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
      const hashed = {
        ...baseEvent,
        hashes: {
          sha256: await calculateContentHash(baseEvent as unknown as Record<string, unknown>),
        },
      };
      const eventId = await computeWireEventId(hashed as unknown as Record<string, unknown>);
      const signed = await signJson(
        redactEventForSigning(hashed as unknown as Record<string, unknown>),
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
