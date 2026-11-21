// One Durable Object per LiveKit room (idFromName(roomId)).
//
// The Worker verifies the LiveKit JWT and forwards the upgrade request here;
// this DO creates the shim session, accepts the server end of the WebSocket
// pair, and owns every participant socket and all room state. The Worker never
// sees a signaling socket, so there is no per-isolate registry to drift out of
// sync. A DO alarm closes sessions that go idle past the TTL.
//
// Socket state is intentionally not persisted: a DO restart drops live sockets
// (reconnect/resume is an existing shim gap) rather than resurrecting a stale
// registry with dead WebSockets. Only the alarm timestamp is durable.

import type { Env } from '../types';
import {
  decodeJoinRequestParam,
  DEFAULT_MAX_PARTICIPANTS,
  DEFAULT_MAX_PER_ROOM,
  LiveKitCallsShimSession,
  LiveKitShimRegistry,
  verifyLiveKitJwt,
  type JoinRequestJson,
  type LiveKitIdentity,
} from '../services/livekit-calls-shim';

/** Idle cutoff for a participant socket. Live traffic keeps it alive. */
export const DEFAULT_SHIM_IDLE_TTL_SECONDS = 300;

export interface LiveKitShimDOOptions {
  /** Overridable in unit tests; production uses the shared shim caps. */
  maxParticipants?: number;
  maxPerRoom?: number;
  idleTtlSeconds?: number;
  /** Seconds since epoch; defaults to Date.now()/1000. */
  now?: () => number;
}

interface TrackedSession {
  session: LiveKitCallsShimSession;
  expiresAt: number;
}

export class LiveKitShimDurableObject implements DurableObject {
  private readonly registry: LiveKitShimRegistry;
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly idleTtlSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
    options: LiveKitShimDOOptions = {}
  ) {
    this.registry = new LiveKitShimRegistry(
      options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
      options.maxPerRoom ?? DEFAULT_MAX_PER_ROOM
    );
    this.idleTtlSeconds = options.idleTtlSeconds ?? DEFAULT_SHIM_IDLE_TTL_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 400 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get('access_token')
      ?? request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Missing access_token' }, { status: 401 });

    let identity: LiveKitIdentity;
    let joinRequest: JoinRequestJson;
    try {
      // Verify again in the DO: the room id used for idFromName comes from the
      // JWT, so the state owner must independently trust that same token.
      identity = await verifyLiveKitJwt(token, this.env.LIVEKIT_API_KEY ?? '', this.env.LIVEKIT_API_SECRET ?? '');
      joinRequest = await decodeJoinRequestParam(url.searchParams.get('join_request'));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Invalid credentials' }, { status: 401 });
    }

    const pair = new WebSocketPair();
    const session = new LiveKitCallsShimSession(this.env, identity, pair[1], {
      registry: this.registry,
      now: this.now,
    });
    const sid = session.participantSid;
    this.sessions.set(sid, { session, expiresAt: this.now() + this.idleTtlSeconds });
    pair[1].addEventListener('message', () => this.touch(sid));
    pair[1].addEventListener('close', () => {
      this.sessions.delete(sid);
      void this.scheduleAlarm().catch((error) => {
        console.error('[livekit-shim] alarm reschedule failed:', error);
      });
    });

    // The DO accepts and holds pair[1]; pair[0] goes back through the Worker
    // to the client in the 101 response.
    await session.start(joinRequest);
    void this.scheduleAlarm().catch((error) => {
      console.error('[livekit-shim] alarm schedule failed:', error);
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async alarm(): Promise<void> {
    const now = this.now();
    for (const [sid, entry] of this.sessions) {
      if (entry.expiresAt <= now) {
        entry.session.close(1000);
        this.sessions.delete(sid);
      }
    }
    await this.scheduleAlarm();
  }

  private touch(sid: string): void {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    entry.expiresAt = this.now() + this.idleTtlSeconds;
    void this.scheduleAlarm().catch((error) => {
      console.error('[livekit-shim] alarm reschedule failed:', error);
    });
  }

  private async scheduleAlarm(): Promise<void> {
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.sessions.values()) next = Math.min(next, entry.expiresAt);
    if (!Number.isFinite(next)) {
      await this.state.storage.deleteAlarm();
      return;
    }
    // Add one second so an already-expired session is not re-fired forever.
    const target = (next + 1) * 1000;
    const existing = await this.state.storage.getAlarm();
    if (existing !== target) await this.state.storage.setAlarm(target);
  }
}
