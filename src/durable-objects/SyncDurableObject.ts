// Sync Durable Object for user-specific sync state
// Handles both WebSocket-based traditional sync and HTTP-based sliding sync

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

interface SyncSession {
  userId: string;
  deviceId: string | null;
  lastSyncToken: string;
}

interface PendingEvent {
  event_id: string;
  room_id: string;
  type: string;
  timestamp: number;
}

// Sliding sync connection state (stored in DO storage, not KV)
interface SlidingSyncConnectionState {
  pos: number;
  lastAccess: number;
  roomStates: Record<string, {
    lastStreamOrdering: number;
    sentState: boolean;
  }>;
  listStates: Record<string, {
    roomIds: string[];
    count: number;
  }>;
  roomNotificationCounts?: Record<string, number>;
  roomFullyReadMarkers?: Record<string, string>;
  initialSyncComplete?: boolean;
  roomSentAsRead?: Record<string, boolean>;
}

// Long-poll resolver entry. The `resolved` flag prevents double-resolution
// when a notify and a timeout race for the same waiter.
interface WaitEntry {
  resolve: (hasEvents: boolean) => void;
  resolved: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_EVENTS_CACHE = 1000;
const STORAGE_DELETE_BATCH_SIZE = 128;

export class SyncDurableObject extends DurableObject<Env> {
  private sessions: Map<WebSocket, SyncSession> = new Map();
  private pendingEvents: PendingEvent[] = [];
  private pendingEventsById: Map<string, PendingEvent> = new Map();
  private pendingEventsLoaded: boolean = false;
  private pendingEventsLoadPromise: Promise<void> | null = null;
  // In-memory cache for sliding sync state (persisted to storage on save)
  private slidingSyncStates: Map<string, SlidingSyncConnectionState> = new Map();
  // Waiting resolvers for long-polling requests, keyed by a unique waiter id
  // so deletes by key are race-free with notify clearing the whole map.
  private waitingResolvers: Map<string, WaitEntry> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/websocket') {
      return this.handleWebSocket(request);
    }

    if (path === '/notify') {
      return this.handleNotify(request);
    }

    if (path === '/pending') {
      return this.handlePending(request);
    }

    // Sliding sync connection state endpoints
    if (path === '/sliding-sync/state') {
      if (request.method === 'GET') {
        return this.getSlidingSyncState(request);
      } else if (request.method === 'PUT') {
        return this.saveSlidingSyncState(request);
      }
    }

    // Wait for events endpoint (for long-polling)
    if (path === '/wait-for-events') {
      return this.handleWaitForEvents(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // Get sliding sync connection state for a user/connection
  private async getSlidingSyncState(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const connId = url.searchParams.get('conn_id');

    if (!connId) {
      return new Response(JSON.stringify({ error: 'Missing conn_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const key = `sliding_sync:${connId}`;

    // Check in-memory cache first
    let state = this.slidingSyncStates.get(key);

    // If not in cache, load from storage
    if (!state) {
      state = await this.ctx.storage.get<SlidingSyncConnectionState>(key);
      if (state) {
        this.slidingSyncStates.set(key, state);
      }
    }

    return new Response(JSON.stringify(state || null), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Save sliding sync connection state
  private async saveSlidingSyncState(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const connId = url.searchParams.get('conn_id');

    if (!connId) {
      return new Response(JSON.stringify({ error: 'Missing conn_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const state = await request.json() as SlidingSyncConnectionState;
      const key = `sliding_sync:${connId}`;

      // Update in-memory cache
      this.slidingSyncStates.set(key, state);

      // Persist to storage (DO storage has no rate limits like KV)
      await this.ctx.storage.put(key, state);

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('[SyncDO] Failed to save sliding sync state:', error);
      return new Response(JSON.stringify({ error: 'Failed to save state' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected websocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('user_id');
    const deviceId = url.searchParams.get('device_id');
    const since = url.searchParams.get('since');

    if (!userId) {
      return new Response('Missing user_id', { status: 400 });
    }

    // Store userId for this DO instance (used via tags)

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    this.ctx.acceptWebSocket(server, [userId]);

    const session: SyncSession = {
      userId,
      deviceId,
      lastSyncToken: since || '0',
    };

    server.serializeAttachment(session);
    this.sessions.set(server, session);

    // Send any pending events immediately
    const pending = await this.getPendingEvents(parseInt(since || '0'));
    if (pending.length > 0) {
      server.send(JSON.stringify({
        type: 'sync',
        events: pending,
      }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleNotify(request: Request): Promise<Response> {
    const data = await request.json() as PendingEvent;
    console.log('[SyncDO] /notify received for event:', data.event_id, 'waiting resolvers:', this.waitingResolvers.size);

    // Store pending event
    const key = `event:${data.event_id}`;
    await this.ctx.storage.put(key, data);

    // Update in-memory list/map (respecting cache cap when already hydrated)
    this.pendingEvents.push(data);
    if (this.pendingEventsLoaded) {
      if (this.pendingEventsById.has(data.event_id)) {
        this.pendingEventsById.set(data.event_id, data);
      } else if (this.pendingEventsById.size < MAX_PENDING_EVENTS_CACHE) {
        this.pendingEventsById.set(data.event_id, data);
      } else {
        // Evict oldest entry by insertion order so bounded memory stays fresh
        const oldestKey = this.pendingEventsById.keys().next().value;
        if (oldestKey !== undefined) {
          this.pendingEventsById.delete(oldestKey);
        }
        this.pendingEventsById.set(data.event_id, data);
      }
    }

    // Notify all connected WebSockets
    const message = JSON.stringify({
      type: 'event',
      event: data,
    });

    const webSockets = this.ctx.getWebSockets();
    for (const ws of webSockets) {
      try {
        ws.send(message);
      } catch (e) {
        // WebSocket may be closed
      }
    }

    // Snapshot and clear before resolving so a recursive notify (e.g. via
    // an awaited side-effect) cannot see the same entries again.
    const entries = Array.from(this.waitingResolvers.values());
    this.waitingResolvers.clear();
    let woke = 0;
    for (const entry of entries) {
      if (!entry.resolved) {
        entry.resolved = true;
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        entry.resolve(true);
        woke++;
      }
    }
    if (woke > 0) {
      console.log('[SyncDO] Woke up', woke, 'waiting request(s)');
    }

    return new Response('OK');
  }

  // Wait for events (used by long-polling sliding sync)
  private async handleWaitForEvents(request: Request): Promise<Response> {
    const waiterId = crypto.randomUUID();
    let entry: WaitEntry | null = null;
    try {
      const body = await request.json() as { timeout?: number };
      const timeout = Math.min(body.timeout || 25000, 25000); // Cap at 25s

      console.log('[SyncDO] /wait-for-events started, timeout:', timeout, 'current waiters:', this.waitingResolvers.size);

      // Single shared promise; resolved either by notify (true) or timeout (false).
      // The `resolved` flag ensures only the first resolution wins.
      const hasEvents = await new Promise<boolean>((resolve) => {
        const e: WaitEntry = { resolve, resolved: false };
        entry = e;
        this.waitingResolvers.set(waiterId, e);

        e.timer = setTimeout(() => {
          e.timer = undefined;
          if (!e.resolved) {
            e.resolved = true;
            // Delete by key — safe even if notify already removed us.
            this.waitingResolvers.delete(waiterId);
            resolve(false);
          }
        }, timeout);
      });

      // Defensive cleanup in case the entry is still mapped (e.g. early return path).
      if (entry && this.waitingResolvers.get(waiterId) === entry) {
        this.waitingResolvers.delete(waiterId);
      }

      console.log('[SyncDO] /wait-for-events completed, hasEvents:', hasEvents);

      return new Response(JSON.stringify({ hasEvents }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // Ensure we don't leak a waiter if json() or anything else throws.
      this.waitingResolvers.delete(waiterId);
      console.error('[SyncDO] Error in wait-for-events:', error);
      return new Response(JSON.stringify({ hasEvents: false, error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handlePending(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const since = parseInt(url.searchParams.get('since') || '0');

    const pending = await this.getPendingEvents(since);

    return new Response(JSON.stringify({ events: pending }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Lazy one-time hydration of pending events from DO storage to avoid
  // repeated 1000-row storage.list scans on every /pending or /websocket call.
  private async loadPendingEvents(): Promise<void> {
    if (this.pendingEventsLoaded) return;
    if (this.pendingEventsLoadPromise) {
      await this.pendingEventsLoadPromise;
      return;
    }

    this.pendingEventsLoadPromise = (async () => {
      const allKeys = await this.ctx.storage.list<PendingEvent>({
        prefix: 'event:',
        limit: MAX_PENDING_EVENTS_CACHE,
      });
      this.pendingEventsById.clear();
      for (const [, event] of allKeys) {
        this.pendingEventsById.set(event.event_id, event);
      }
      this.pendingEventsLoaded = true;
    })();

    try {
      await this.pendingEventsLoadPromise;
    } finally {
      this.pendingEventsLoadPromise = null;
    }
  }

  private async getPendingEvents(since: number): Promise<PendingEvent[]> {
    await this.loadPendingEvents();

    const events: PendingEvent[] = [];
    for (const event of this.pendingEventsById.values()) {
      if (event.timestamp > since) {
        events.push(event);
      }
    }

    // Sort by timestamp
    events.sort((a, b) => a.timestamp - b.timestamp);

    return events;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = ws.deserializeAttachment() as SyncSession | null;
    if (!session) return;

    try {
      const data = typeof message === 'string' ? JSON.parse(message) : null;
      if (!data) return;

      switch (data.type) {
        case 'ack':
          // Client acknowledged receipt of events up to this token
          session.lastSyncToken = data.token;
          ws.serializeAttachment(session);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          break;
      }
    } catch (e) {
      console.error('Error handling sync message:', e);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const session = ws.deserializeAttachment() as SyncSession | null;
    if (session) {
      this.sessions.delete(ws);
    }
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('Sync WebSocket error:', error);
    const session = ws.deserializeAttachment() as SyncSession | null;
    if (session) {
      this.sessions.delete(ws);
    }
  }

  // Batch delete storage keys in chunks of 128 (Cloudflare DO limit)
  private async batchDelete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length === 1) {
      await this.ctx.storage.delete(keys[0]);
      return;
    }
    for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH_SIZE) {
      await this.ctx.storage.delete(keys.slice(i, i + STORAGE_DELETE_BATCH_SIZE));
    }
  }

  // Cleanup old events and stale connection state (run periodically via alarm)
  async alarm(): Promise<void> {
    const now = Date.now();
    const eventCutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago
    const connectionCutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago

    // Clean up old pending events in batched deletes
    const allKeys = await this.ctx.storage.list({ prefix: 'event:', limit: 1000 });
    const expiredEventKeys: string[] = [];
    let remainingEvents = 0;
    for (const [key, value] of allKeys) {
      const event = value as PendingEvent;
      if (event.timestamp < eventCutoff) {
        expiredEventKeys.push(key);
        this.pendingEventsById.delete(event.event_id);
      } else {
        remainingEvents++;
      }
    }

    // Clean up in-memory pending events list
    this.pendingEvents = this.pendingEvents.filter(e => e.timestamp >= eventCutoff);

    // Clean up stale sliding sync connection states in batched deletes
    const syncKeys = await this.ctx.storage.list({ prefix: 'sliding_sync:', limit: 100 });
    const expiredSyncKeys: string[] = [];
    let remainingSyncStates = 0;
    for (const [key, value] of syncKeys) {
      const state = value as SlidingSyncConnectionState;
      if (state.lastAccess && state.lastAccess < connectionCutoff) {
        expiredSyncKeys.push(key);
        this.slidingSyncStates.delete(key);
      } else {
        remainingSyncStates++;
      }
    }

    await this.batchDelete([...expiredEventKeys, ...expiredSyncKeys]);

    // Only reschedule cleanup if there are still stored entries to expire later;
    // stops idle/empty user SyncDOs from waking every hour indefinitely.
    if (remainingEvents > 0 || remainingSyncStates > 0) {
      await this.ctx.storage.setAlarm(Date.now() + (60 * 60 * 1000));
    }
  }
}
