// Federation Durable Object for server-to-server communication

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { getServerSigningKey, signFederationRequest } from '../services/federation-keys';
import { discoverServer, buildServerUrl } from '../services/server-discovery';
import { federationFetch } from '../services/federation-http';

interface FederationTarget {
  serverName: string;
  lastContact: number;
  retryCount: number;
  nextRetry: number | null;
}

interface OutboundEvent {
  event_id: string;
  room_id: string;
  destination: string;
  pdu: any;
  created_at: number;
  retry_count: number;
}

interface OutboundEdu {
  edu_type: string;
  destination: string;
  content: any;
  created_at: number;
}

// An invite queued for delivery via PUT /_matrix/federation/v2/invite/...
// The invitee's server is not in the room yet, so invites cannot travel in
// /send transactions alongside regular PDUs.
interface OutboundInvite {
  room_id: string;
  event_id: string;
  destination: string;
  event: any;
  room_version: string;
  invite_room_state: any[];
  created_at: number;
  retry_count: number;
}

const STORAGE_BATCH_LIMIT = 128;

export class FederationDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // Batch storage puts in chunks of 128 (Cloudflare DO storage limit)
  private async batchPut(entries: Record<string, unknown>): Promise<void> {
    const pairs = Object.entries(entries);
    if (pairs.length === 0) return;
    if (pairs.length === 1) {
      await this.ctx.storage.put(pairs[0][0], pairs[0][1]);
      return;
    }
    for (let i = 0; i < pairs.length; i += STORAGE_BATCH_LIMIT) {
      const chunk = Object.fromEntries(pairs.slice(i, i + STORAGE_BATCH_LIMIT));
      await this.ctx.storage.put(chunk);
    }
  }

  // Batch storage deletes in chunks of 128 (Cloudflare DO storage limit)
  private async batchDelete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    if (keys.length === 1) {
      await this.ctx.storage.delete(keys[0]);
      return;
    }
    for (let i = 0; i < keys.length; i += STORAGE_BATCH_LIMIT) {
      await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH_LIMIT));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/send') {
      return this.handleSend(request);
    }

    if (path === '/queue') {
      return this.handleQueue(request);
    }

    if (path === '/receive') {
      return this.handleReceive(request);
    }

    if (path === '/status') {
      return this.handleStatus(request);
    }

    if (path === '/keys') {
      return this.handleKeys(request);
    }

    if (path === '/send-edu') {
      return this.handleSendEdu(request);
    }

    if (path === '/invite') {
      return this.handleInvite(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // Queue an event for federation to a remote server
  private async handleSend(request: Request): Promise<Response> {
    const data = await request.json() as {
      destination: string;
      event_id: string;
      room_id: string;
      pdu: any;
    };

    const outboundEvent: OutboundEvent = {
      event_id: data.event_id,
      room_id: data.room_id,
      destination: data.destination,
      pdu: data.pdu,
      created_at: Date.now(),
      retry_count: 0,
    };

    // Check queue size to prevent unbounded growth when remote server is down
    const allQueueKeys = await this.ctx.storage.list<OutboundEvent>({ prefix: `queue:${data.destination}:`, limit: 10000 });
    if (allQueueKeys.size >= 10000) {
      console.warn(`[federation] Queue for ${data.destination} full (${allQueueKeys.size} events), rejecting`);
      return new Response(JSON.stringify({
        errcode: 'M_LIMIT_EXCEEDED',
        error: 'Federation queue full for destination',
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    // Store in queue
    const key = `queue:${data.destination}:${data.event_id}`;
    await this.ctx.storage.put(key, outboundEvent);

    console.log(`[federation] Queued PDU ${data.event_id} for ${data.destination}`);

    // Reuse the queue snapshot we just listed (plus the newly queued event)
    // to avoid a duplicate full storage.list scan in processFederationQueue.
    allQueueKeys.set(key, outboundEvent);
    const preloadedEvents = Array.from(allQueueKeys.values());

    // Try to send immediately
    await this.processFederationQueue(data.destination, preloadedEvents);

    return new Response('Queued');
  }

  // Durable queue-only endpoint: store the PDU and arm the alarm, without an
  // immediate remote send. Called synchronously by the send path so queueing
  // survives even if waitUntil subrequests are cancelled; the alarm drains it.
  private async handleQueue(request: Request): Promise<Response> {
    const data = await request.json() as {
      destination: string;
      event_id: string;
      room_id: string;
      pdu: any;
    };
    const now = Date.now();
    const outboundEvent: OutboundEvent = {
      event_id: data.event_id,
      room_id: data.room_id,
      destination: data.destination,
      pdu: data.pdu,
      created_at: now,
      retry_count: 0,
    };
    // Register a due target so alarm() drains this destination, batching both puts.
    const existing = await this.ctx.storage.get(`server:${data.destination}`) as FederationTarget | undefined;
    await this.batchPut({
      [`queue:${data.destination}:${data.event_id}`]: outboundEvent,
      [`server:${data.destination}`]: {
        serverName: data.destination,
        lastContact: existing?.lastContact ?? 0,
        retryCount: existing?.retryCount ?? 0,
        nextRetry: now,
      },
    });
    const targetAlarm = now + 100;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm <= now || currentAlarm > targetAlarm) {
      await this.ctx.storage.setAlarm(targetAlarm);
    }
    return new Response('Queued');
  }

  // Handle incoming federation request
  private async handleReceive(request: Request): Promise<Response> {
    const origin = request.headers.get('X-Matrix-Origin');
    if (!origin) {
      return new Response(JSON.stringify({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing origin header',
      }), { status: 400 });
    }

    // Verify request signature (simplified)
    // In production, verify against the server's signing keys

    const data = await request.json() as {
      pdus: any[];
      edus?: any[];
    };

    // Process incoming PDUs and batch-write with server status update
    const now = Date.now();
    const processedPdus: string[] = [];
    const writes: Record<string, unknown> = {};
    for (const pdu of data.pdus || []) {
      writes[`received:${pdu.event_id}`] = {
        pdu,
        origin,
        received_at: now,
      };
      processedPdus.push(pdu.event_id);
    }

    const target: FederationTarget = {
      serverName: origin,
      lastContact: now,
      retryCount: 0,
      nextRetry: null,
    };
    writes[`server:${origin}`] = target;
    await this.batchPut(writes);

    return new Response(JSON.stringify({
      pdus: processedPdus.reduce((acc, id) => ({ ...acc, [id]: {} }), {}),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get federation status for a server
  private async handleStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const serverName = url.searchParams.get('server');

    if (serverName) {
      const target = await this.ctx.storage.get(`server:${serverName}`) as FederationTarget | undefined;
      return new Response(JSON.stringify(target || { serverName, status: 'unknown' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // List all known servers
    const servers: FederationTarget[] = [];
    const allKeys = await this.ctx.storage.list({ prefix: 'server:' });
    for (const [, value] of allKeys) {
      servers.push(value as FederationTarget);
    }

    return new Response(JSON.stringify({ servers }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle server key requests
  private async handleKeys(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const serverName = url.searchParams.get('server');

    if (!serverName) {
      return new Response(JSON.stringify({
        errcode: 'M_MISSING_PARAM',
        error: 'Missing server parameter',
      }), { status: 400 });
    }

    // Get cached keys
    const cachedKeys = await this.ctx.storage.get(`keys:${serverName}`);
    if (cachedKeys) {
      const keys = cachedKeys as { data: any; expires: number };
      if (keys.expires > Date.now()) {
        return new Response(JSON.stringify(keys.data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Fetch keys from remote server
    try {
      const response = await fetch(`https://${serverName}/_matrix/key/v2/server`, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();

        // Cache for 24 hours
        await this.ctx.storage.put(`keys:${serverName}`, {
          data,
          expires: Date.now() + (24 * 60 * 60 * 1000),
        });

        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch (e) {
      console.error(`Failed to fetch keys from ${serverName}:`, e);
    }

    return new Response(JSON.stringify({
      errcode: 'M_NOT_FOUND',
      error: 'Server keys not found',
    }), { status: 404 });
  }

  // Queue an EDU for federation to a remote server
  private async handleSendEdu(request: Request): Promise<Response> {
    const data = await request.json() as {
      destination: string;
      edu_type: string;
      content: any;
    };

    const edu: OutboundEdu = {
      edu_type: data.edu_type,
      destination: data.destination,
      content: data.content,
      created_at: Date.now(),
    };

    // Store in EDU queue
    const key = `edu:${data.destination}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await this.ctx.storage.put(key, edu);

    // Try to send immediately
    await this.processFederationQueue(data.destination);

    return new Response('Queued');
  }

  private async processFederationQueue(destination: string, preloadedEvents?: OutboundEvent[]): Promise<void> {
    let events: OutboundEvent[];
    if (preloadedEvents) {
      events = preloadedEvents;
    } else {
      const prefix = `queue:${destination}:`;
      const allKeys = await this.ctx.storage.list({ prefix });
      events = [];
      for (const [, value] of allKeys) {
        events.push(value as OutboundEvent);
      }
    }

    // Collect pending EDUs
    const eduPrefix = `edu:${destination}:`;
    const eduKeys = await this.ctx.storage.list({ prefix: eduPrefix });
    const edus: OutboundEdu[] = [];
    const eduKeyNames: string[] = [];
    for (const [key, value] of eduKeys) {
      edus.push(value as OutboundEdu);
      eduKeyNames.push(key);
    }

    if (events.length === 0 && edus.length === 0) return;

    // Sort by creation time
    events.sort((a, b) => a.created_at - b.created_at);
    edus.sort((a, b) => a.created_at - b.created_at);

    // Batch events for transmission
    const pdus = events.map(e => e.pdu);
    const eduPayloads = edus.map(e => ({
      edu_type: e.edu_type,
      content: e.content,
    }));

    try {
      const txnId = Date.now().toString();
      const path = `/_matrix/federation/v1/send/${txnId}`;
      const content = { pdus, edus: eduPayloads };

      // Sign the outbound federation request
      const signingKey = await getServerSigningKey(this.env.DB);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if (signingKey) {
        const authHeader = await signFederationRequest(
          'PUT',
          path,
          this.env.SERVER_NAME,
          destination,
          signingKey,
          content
        );
        headers['Authorization'] = authHeader;
      } else {
        console.warn(`[federation] No signing key available — sending unsigned request to ${destination}`);
      }

      // Discover the remote server's endpoint
      let serverUrl: string;
      try {
        const discovery = await discoverServer(destination, this.env.CACHE);
        serverUrl = buildServerUrl(discovery);
      } catch {
        serverUrl = `https://${destination}`;
      }

      const response = await federationFetch(`${serverUrl}${path}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(content),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      console.log(
        `[federation] Transaction ${txnId} to ${destination}: HTTP ${response.status} ` +
          `(${events.length} PDU(s), ${edus.length} EDU(s))`
      );

      if (response.ok) {
        // Parse the response to check for per-PDU failures
        let responseBody: any = {};
        try {
          responseBody = await response.json();
        } catch {
          // If response body is not JSON, treat all as accepted
        }

        console.log(
          `[federation] Transaction ${txnId} results from ${destination}: ` +
            JSON.stringify(responseBody?.pdus ?? {}).slice(0, 1200)
        );

        // Batch-remove accepted/maxed-out events and sent EDUs from queue
        const pduResults = responseBody?.pdus || {};
        const keysToDelete: string[] = [];
        for (const event of events) {
          const result = pduResults[event.event_id];
          if (result?.error) {
            console.warn(`[federation] PDU ${event.event_id} rejected by ${destination}: ${result.error}`);
            // Keep in queue for retry unless it's a permanent failure
            if (event.retry_count >= 32) {
              console.error(`[federation] Dropping PDU ${event.event_id} after 32 retries to ${destination}`);
              keysToDelete.push(`queue:${destination}:${event.event_id}`);
            }
          } else {
            // Accepted — remove from queue
            keysToDelete.push(`queue:${destination}:${event.event_id}`);
          }
        }
        // Remove sent EDUs (EDUs are fire-and-forget per spec)
        for (const key of eduKeyNames) {
          keysToDelete.push(key);
        }
        await this.batchDelete(keysToDelete);

        // Update server status
        const target: FederationTarget = {
          serverName: destination,
          lastContact: Date.now(),
          retryCount: 0,
          nextRetry: null,
        };
        await this.ctx.storage.put(`server:${destination}`, target);
      } else {
        // Schedule retry (with max retry cap)
        const maxedOut = events.some(e => e.retry_count >= 32);
        if (maxedOut) {
          // Batch-drop events that have exceeded max retries
          const droppedKeys: string[] = [];
          for (const event of events) {
            if (event.retry_count >= 32) {
              console.error(`[federation] Dropping PDU ${event.event_id} after ${event.retry_count} retries to ${destination}`);
              droppedKeys.push(`queue:${destination}:${event.event_id}`);
            }
          }
          await this.batchDelete(droppedKeys);
          // Re-filter events that still have retries left
          const remainingEvents = events.filter(e => e.retry_count < 32);
          if (remainingEvents.length > 0) {
            await this.scheduleRetry(destination, remainingEvents);
          }
        } else {
          await this.scheduleRetry(destination, events);
        }
      }
    } catch (e) {
      console.error(`Federation send to ${destination} failed:`, e);
      await this.scheduleRetry(destination, events);
    }
  }

  private async scheduleRetry(destination: string, events: OutboundEvent[]): Promise<void> {
    const target = await this.ctx.storage.get(`server:${destination}`) as FederationTarget | undefined;
    const retryCount = (target?.retryCount || 0) + 1;

    // Exponential backoff: 1min, 2min, 4min ... capped at 1 day
    const delay = Math.min(60000 * Math.pow(2, retryCount - 1), 86400000);
    const nextRetry = Date.now() + delay;

    // Batch server status and updated retry counts into storage puts
    const newTarget: FederationTarget = {
      serverName: destination,
      lastContact: target?.lastContact || 0,
      retryCount,
      nextRetry,
    };
    const updates: Record<string, unknown> = {
      [`server:${destination}`]: newTarget,
    };

    for (const event of events) {
      event.retry_count = retryCount;
      updates[`queue:${destination}:${event.event_id}`] = event;
    }
    await this.batchPut(updates);

    // Set alarm for retry
    await this.ctx.storage.setAlarm(nextRetry);
  }

  // Queue an invite for delivery over the federation invite endpoint.
  private async handleInvite(request: Request): Promise<Response> {
    const data = await request.json() as {
      destination: string;
      room_id: string;
      event_id: string;
      room_version: string;
      event: any;
      invite_room_state: any[];
    };

    const invite: OutboundInvite = {
      room_id: data.room_id,
      event_id: data.event_id,
      destination: data.destination,
      event: data.event,
      room_version: data.room_version,
      invite_room_state: data.invite_room_state ?? [],
      created_at: Date.now(),
      retry_count: 0,
    };

    await this.ctx.storage.put(`invite:${data.destination}:${data.event_id}`, invite);
    console.log(`[federation] Queued invite ${data.event_id} for ${data.destination}`);

    // Try to send immediately
    await this.processInviteQueue(data.destination);

    return new Response('Queued');
  }

  // Deliver queued invites. Each invite is its own PUT to
  // /_matrix/federation/v2/invite/{roomId}/{eventId} -- receiving servers
  // validate the invite_room_state entries as signed PDUs, so this cannot be
  // folded into the /send transaction batching above.
  private async processInviteQueue(destination: string): Promise<void> {
    const prefix = `invite:${destination}:`;
    const allKeys = await this.ctx.storage.list({ prefix });
    if (allKeys.size === 0) return;

    const invites: OutboundInvite[] = [];
    for (const [, value] of allKeys) {
      invites.push(value as OutboundInvite);
    }
    invites.sort((a, b) => a.created_at - b.created_at);

    let failures = 0;
    let successes = 0;
    const keysToDelete: string[] = [];
    const invitesToUpdate: Record<string, unknown> = {};

    // Hoist signing key and server discovery once per destination batch
    let signingKey: Awaited<ReturnType<typeof getServerSigningKey>> | undefined;
    let signingKeyLoaded = false;
    let serverUrl: string | undefined;

    for (const invite of invites) {
      try {
        const path = `/_matrix/federation/v2/invite/${encodeURIComponent(invite.room_id)}/${encodeURIComponent(invite.event_id)}`;
        const content = {
          event: invite.event,
          room_version: invite.room_version,
          invite_room_state: invite.invite_room_state,
        };

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };

        if (!signingKeyLoaded) {
          signingKey = await getServerSigningKey(this.env.DB);
          signingKeyLoaded = true;
        }
        if (signingKey) {
          headers['Authorization'] = await signFederationRequest(
            'PUT',
            path,
            this.env.SERVER_NAME,
            destination,
            signingKey,
            content
          );
        } else {
          console.warn(`[federation] No signing key available — sending unsigned invite to ${destination}`);
        }

        if (!serverUrl) {
          try {
            const discovery = await discoverServer(destination, this.env.CACHE);
            serverUrl = buildServerUrl(discovery);
          } catch {
            serverUrl = `https://${destination}`;
          }
        }

        const response = await federationFetch(`${serverUrl}${path}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(content),
          signal: AbortSignal.timeout(30000),
        });

        console.log(`[federation] Invite ${invite.event_id} to ${destination}: HTTP ${response.status}`);

        if (response.ok) {
          keysToDelete.push(`invite:${destination}:${invite.event_id}`);
          successes += 1;
        } else {
          let bodyText = '';
          try {
            bodyText = (await response.text()).slice(0, 300);
          } catch {
            // Non-text body; the status code is the useful part
          }
          console.warn(`[federation] Invite ${invite.event_id} rejected by ${destination}: HTTP ${response.status} ${bodyText}`);
          invite.retry_count += 1;
          if (invite.retry_count >= 32) {
            console.error(`[federation] Dropping invite ${invite.event_id} after ${invite.retry_count} retries to ${destination}`);
            keysToDelete.push(`invite:${destination}:${invite.event_id}`);
          } else {
            invitesToUpdate[`invite:${destination}:${invite.event_id}`] = invite;
            failures += 1;
          }
        }
      } catch (e) {
        console.error(`[federation] Invite ${invite.event_id} to ${destination} failed:`, e);
        invite.retry_count += 1;
        if (invite.retry_count >= 32) {
          keysToDelete.push(`invite:${destination}:${invite.event_id}`);
        } else {
          invitesToUpdate[`invite:${destination}:${invite.event_id}`] = invite;
          failures += 1;
        }
      }
    }

    await this.batchDelete(keysToDelete);

    if (failures > 0) {
      // Exponential backoff shared with the PDU queue, so a down destination
      // is not hammered by either path.
      const target = await this.ctx.storage.get(`server:${destination}`) as FederationTarget | undefined;
      const retryCount = (target?.retryCount || 0) + 1;
      const delay = Math.min(60000 * Math.pow(2, retryCount - 1), 86400000);
      const nextRetry = Date.now() + delay;
      invitesToUpdate[`server:${destination}`] = {
        serverName: destination,
        lastContact: successes > 0 ? Date.now() : (target?.lastContact || 0),
        retryCount,
        nextRetry,
      };
      await this.batchPut(invitesToUpdate);
      await this.ctx.storage.setAlarm(nextRetry);
    } else if (successes > 0) {
      invitesToUpdate[`server:${destination}`] = {
        serverName: destination,
        lastContact: Date.now(),
        retryCount: 0,
        nextRetry: null,
      };
      await this.batchPut(invitesToUpdate);
    } else {
      await this.batchPut(invitesToUpdate);
    }
  }

  async alarm(): Promise<void> {
    // Process all destinations with pending retries
    const allKeys = await this.ctx.storage.list({ prefix: 'server:' });

    for (const [, value] of allKeys) {
      const target = value as FederationTarget;
      if (target.nextRetry && target.nextRetry <= Date.now()) {
        await this.processInviteQueue(target.serverName);
        await this.processFederationQueue(target.serverName);
      }
    }
  }
}
