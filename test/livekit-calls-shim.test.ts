// Tests for the LiveKit -> Cloudflare Calls compatibility shim.
// The Calls REST API and the LiveKit WebSocket frames are both mocked here;
// no network calls and no real LiveKit server are involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodePb,
  handleLiveKitSignalRequest,
  inferMimeType,
  LiveKitShimRegistry,
  LiveKitCallsShimSession,
  verifyLiveKitJwt,
  type LiveKitIdentity,
  type SignalRequestJson,
} from '../src/services/livekit-calls-shim';
import { generateLiveKitToken } from '../src/services/livekit';
import type { Env } from '../src/types';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const CALLS_APP_ID = 'test-app';
const CALLS_APP_SECRET = 'test-calls-secret';

const OFFER_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  'a=rtpmap:96 VP8/90000',
  '',
].join('\r\n');

const ANSWER_SDP = OFFER_SDP.replace('o=- 0 0', 'o=- 1 1');
const SUBSCRIBER_OFFER_SDP = OFFER_SDP.replace('a=mid:0', 'a=mid:1').replace('o=- 0 0', 'o=- 2 2');

// --- minimal protobuf encoder for test-side SignalRequest frames ------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let remaining = Math.floor(value);
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    out.push(byte);
  } while (remaining);
  return new Uint8Array(out);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fnum(field: number, value: number | boolean): Uint8Array {
  return cat(varint(field * 8), varint(typeof value === 'boolean' ? Number(value) : value));
}

function fstr(field: number, value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return cat(varint(field * 8 + 2), varint(bytes.length), bytes);
}

function fmsg(field: number, value: Uint8Array): Uint8Array {
  return cat(varint(field * 8 + 2), varint(value.length), value);
}

function requestFrame(field: number, body: Uint8Array): ArrayBuffer {
  return fmsg(field, body).buffer as ArrayBuffer;
}

function sdBody(type: string, sdp: string, id?: number): Uint8Array {
  return cat(fstr(1, type), fstr(2, sdp), id === undefined ? new Uint8Array() : fnum(3, id));
}

function addTrackBody(cid: string, name: string, type: number, source: number): Uint8Array {
  return cat(fstr(1, cid), fstr(2, name), fnum(3, type), fnum(8, source));
}

function subscriptionBody(sids: string[], subscribe: boolean): Uint8Array {
  return cat(...sids.map((sid) => fstr(1, sid)), fnum(2, subscribe));
}

// --- minimal response decoder ----------------------------------------------

type Body = Map<number, Array<{ wire: number; num: number; bytes?: Uint8Array }>>;

function decodeFrame(frame: unknown): { field: number; body: Body } {
  const bytes = frame instanceof Uint8Array
    ? frame
    : frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : encoder.encode(String(frame));
  const top = decodePb(bytes);
  const [field, entries] = [...top.entries()][0]!;
  return { field: field!, body: decodePb(entries[0]!.bytes!) };
}

function s(body: Body, field: number): string | undefined {
  const value = body.get(field)?.[0]?.bytes;
  return value === undefined ? undefined : decoder.decode(value);
}

function n(body: Body, field: number): number | undefined {
  return body.get(field)?.[0]?.num;
}

function msgs(body: Body, field: number): Body[] {
  return (body.get(field) ?? []).flatMap((entry) => (entry.bytes ? [decodePb(entry.bytes)] : []));
}

function lastSent(ws: FakeSocket, field: number): { field: number; body: Body } | undefined {
  return ws.sent.map(decodeFrame).reverse().find((frame) => frame.field === field);
}

// --- fakes ------------------------------------------------------------------

class FakeSocket {
  accepted = false;
  sent: unknown[] = [];
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.emit('close', {});
  }

  receive(data: unknown): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function makeEnv(): Env {
  return {
    DB: {}, SESSIONS: {}, CACHE: {}, SEARCH: {},
    CALLS_APP_ID, CALLS_APP_SECRET,
    LIVEKIT_API_KEY: API_KEY, LIVEKIT_API_SECRET: API_SECRET,
    SERVER_NAME: 'example.org',
  } as unknown as Env;
}

interface CallsCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

function installCallsFetch(): { calls: CallsCall[]; restore: () => void } {
  const calls: CallsCall[] = [];
  let sessionCounter = 0;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    calls.push({ url, method, body });

    if (url.endsWith('/sessions/new')) {
      sessionCounter++;
      return Response.json({ sessionId: `sess-${sessionCounter}` });
    }
    if (url.includes('/tracks/new')) {
      const tracks = body.tracks as Array<{ location: string; trackName?: string }>;
      const isLocal = tracks[0]?.location === 'local';
      return Response.json({
        sessionDescription: {
          type: isLocal ? 'answer' : 'offer',
          sdp: isLocal ? ANSWER_SDP : SUBSCRIBER_OFFER_SDP,
        },
        tracks: tracks.map((track, index) => ({
          mid: isLocal ? String(index) : '1',
          trackName: track.trackName ?? 'remote',
        })),
        requiresImmediateRenegotiation: false,
      });
    }
    if (url.includes('/renegotiate')) return Response.json({});
    if (url.includes('/tracks/close')) return Response.json({});
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return {
    calls,
    restore: () => vi.unstubAllGlobals(),
  };
}

async function identityFor(room: string, ttl = 3600): Promise<LiveKitIdentity> {
  const token = await generateLiveKitToken(API_KEY, API_SECRET, room, '@alice:example.org', 'alice', ttl);
  const identity = await verifyLiveKitJwt(token, API_KEY, API_SECRET);
  return identity;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function varintFrameValue(frame: unknown, field: number): number | undefined {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame as ArrayBuffer);
  return decodePb(bytes).get(field)?.[0]?.num;
}

// --- tests ------------------------------------------------------------------

describe('livekit-calls-shim', () => {
  let callsFetch: ReturnType<typeof installCallsFetch>;

  beforeEach(() => {
    callsFetch = installCallsFetch();
  });

  afterEach(() => {
    callsFetch.restore();
    vi.restoreAllMocks();
  });

  describe('JWT validation', () => {
    it('accepts a token minted by the existing generateLiveKitToken helper', async () => {
      const identity = await identityFor('room_a');
      expect(identity).toMatchObject({
        identity: '@alice:example.org',
        room: 'room_a',
        canPublish: true,
        canSubscribe: true,
      });
    });

    it('rejects an expired token', async () => {
      const token = await generateLiveKitToken(API_KEY, API_SECRET, 'room_a', 'alice', undefined, -10);
      await expect(verifyLiveKitJwt(token, API_KEY, API_SECRET)).rejects.toThrow('expired');
    });

    it('rejects a token signed with the wrong secret', async () => {
      const token = await generateLiveKitToken(API_KEY, 'other-secret', 'room_a', 'alice');
      await expect(verifyLiveKitJwt(token, API_KEY, API_SECRET)).rejects.toThrow('signature');
    });

    it('rejects a token for the wrong API key (issuer)', async () => {
      const token = await generateLiveKitToken('other-key', API_SECRET, 'room_a', 'alice');
      await expect(verifyLiveKitJwt(token, API_KEY, API_SECRET)).rejects.toThrow('issuer');
    });

    it('rejects a token without roomJoin or with a missing room', async () => {
      const now = Math.floor(Date.now() / 1000);
      const encode = (payload: object) => Buffer.from(JSON.stringify(payload)).toString('base64url');
      const header = encode({ alg: 'HS256', typ: 'JWT' });
      const key = await crypto.subtle.importKey('raw', encoder.encode(API_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sign = async (payload: object) => {
        const data = `${header}.${encode(payload)}`;
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
        return `${data}.${Buffer.from(sig).toString('base64url')}`;
      };
      const base = { iss: API_KEY, sub: 'alice', nbf: now, exp: now + 100 };
      await expect(verifyLiveKitJwt(await sign({ ...base, video: { room: 'room_a' } }), API_KEY, API_SECRET))
        .rejects.toThrow('roomJoin');
      await expect(verifyLiveKitJwt(await sign({ ...base, video: { roomJoin: true } }), API_KEY, API_SECRET))
        .rejects.toThrow('room');
    });

    it('takes the room exclusively from the JWT, never from client data', async () => {
      const ws = new FakeSocket();
      const registry = new LiveKitShimRegistry(5, 5);
      const identity = await identityFor('room_from_jwt');
      const shim = new LiveKitCallsShimSession(makeEnv(), identity, ws.asWebSocket(), { registry });
      await shim.start({
        addTrackRequests: [],
        // A hostile client could try these; they must not change the room.
        reconnect: false,
        participantSid: 'attacker-sid',
      });
      const join = decodeFrame(ws.sent[0]);
      const room = msgs(join.body, 1)[0]!;
      expect(s(room, 2)).toBe('room_from_jwt');
      expect(s(msgs(join.body, 2)[0]!, 2)).toBe('@alice:example.org');
      expect(s(msgs(join.body, 2)[0]!, 1)).not.toBe('attacker-sid');
      shim.close();
    });
  });

  describe('join / session lifecycle', () => {
    it('creates one Calls session and sends SignalResponse.join', async () => {
      const ws = new FakeSocket();
      const registry = new LiveKitShimRegistry(5, 5);
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_b'), ws.asWebSocket(), { registry });
      await shim.start({ addTrackRequests: [] });

      expect(ws.accepted).toBe(true);
      expect(callsFetch.calls).toHaveLength(1);
      expect(callsFetch.calls[0]).toMatchObject({ method: 'POST' });
      expect(callsFetch.calls[0]!.url).toBe(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`);
      const join = decodeFrame(ws.sent[0]);
      expect(join.field).toBe(1); // SignalResponse.join
      expect(s(msgs(join.body, 1)[0]!, 2)).toBe('room_b');
      expect(n(join.body, 6)).toBe(0); // subscriberPrimary = false
      shim.close();
    });

    it('forwards authenticated upgrades to the room DO and rejects bad requests', async () => {
      const doResponse = new Response(null, { status: 200 });
      const doFetch = vi.fn(async () => doResponse);
      const namespace = {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ fetch: doFetch })),
      } as unknown as DurableObjectNamespace;

      const env = makeEnv();
      const token = await generateLiveKitToken(API_KEY, API_SECRET, 'room_c', 'alice');
      const base = `https://example.org/livekit/signal/rtc/v1?access_token=${encodeURIComponent(token)}`;

      const upgrade = await handleLiveKitSignalRequest(
        new Request(base, { headers: { Upgrade: 'websocket' } }), env, { namespace }
      );
      expect(upgrade).toBe(doResponse);
      expect(namespace.idFromName).toHaveBeenCalledWith('room_c');
      expect(doFetch).toHaveBeenCalledTimes(1);

      const missing = await handleLiveKitSignalRequest(
        new Request('https://example.org/livekit/signal/rtc/v1', { headers: { Upgrade: 'websocket' } }),
        env, { namespace }
      );
      expect(missing.status).toBe(401);
      expect(doFetch).toHaveBeenCalledTimes(1);

      const plain = await handleLiveKitSignalRequest(new Request('https://example.org/livekit/signal'), env, { namespace });
      expect(plain.status).toBe(400);
      expect(doFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('publishing', () => {
    it('translates add_track + offer into Calls local tracks and returns answer + trackPublished', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_d'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });

      ws.receive(requestFrame(4, addTrackBody('cid-1', 'camera', 1, 1)));
      await settled();
      ws.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 7)));
      await vi.waitFor(() => expect(lastSent(ws, 6)).toBeDefined());

      const tracksCall = callsFetch.calls.find((call) => call.url.includes('/tracks/new'))!;
      expect(tracksCall.method).toBe('POST');
      expect(tracksCall.body).toMatchObject({
        sessionDescription: { type: 'offer', sdp: OFFER_SDP },
        tracks: [{ location: 'local', trackName: 'camera' }],
      });

      const answer = lastSent(ws, 2)!;
      expect(s(answer.body, 1)).toBe('answer');
      expect(s(answer.body, 2)).toBe(ANSWER_SDP);
      expect(n(answer.body, 3)).toBe(7); // offer id echoed

      const published = lastSent(ws, 6)!;
      expect(s(published.body, 1)).toBe('cid-1');
      const track = msgs(published.body, 2)[0]!;
      expect(s(track, 1)).toMatch(/^TR_/);
      expect(s(track, 3)).toBe('camera');
      expect(s(track, 11)).toBe('video/vp8');
      expect(s(track, 12)).toBe('0');
      shim.close();
    });

    it('handles add_track requests bundled into the join_request', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_d2'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({
        addTrackRequests: [{ cid: 'cid-join', name: 'mic', type: 0, source: 2 }],
        publisherOffer: { type: 'offer', sdp: OFFER_SDP, id: 1 },
      });
      await vi.waitFor(() => expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new'))).toBe(true));
      const tracksCall = callsFetch.calls.find((call) => call.url.includes('/tracks/new'))!;
      expect(tracksCall.body.tracks).toEqual([{ location: 'local', trackName: 'mic' }]);
      shim.close();
    });

    it('enforces the per-participant track cap', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_e'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
        maxTracksPerParticipant: 1,
      });
      await shim.start({ addTrackRequests: [] });
      ws.receive(requestFrame(4, addTrackBody('cid-1', 'cam', 1, 1)));
      ws.receive(requestFrame(4, addTrackBody('cid-2', 'mic', 0, 2)));
      await settled();
      expect(ws.closeCode).toBe(1013);
      shim.close();
    });

    it('rejects oversized SDP before it reaches the Calls API', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_e2'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });
      ws.receive(requestFrame(1, sdBody('offer', 'x'.repeat(130_000), 1)));
      await settled();
      expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new'))).toBe(false);
      expect(ws.closeCode).toBe(1013);
      shim.close();
    });
  });

  describe('subscribing', () => {
    it('pulls a published track from Calls and forwards the answer via renegotiate', async () => {
      const registry = new LiveKitShimRegistry(5, 5);
      const env = makeEnv();
      const publisherWs = new FakeSocket();
      const publisher = new LiveKitCallsShimSession(env, await identityFor('room_f'), publisherWs.asWebSocket(), { registry });
      await publisher.start({ addTrackRequests: [] });
      publisherWs.receive(requestFrame(4, addTrackBody('cid-pub', 'screen', 1, 3)));
      publisherWs.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 3)));
      await vi.waitFor(() => expect(lastSent(publisherWs, 6)).toBeDefined());
      const published = lastSent(publisherWs, 6)!;
      const trackSid = s(msgs(published.body, 2)[0]!, 1)!;

      const subscriberWs = new FakeSocket();
      const subscriber = new LiveKitCallsShimSession(env, {
        identity: '@bob:example.org', room: 'room_f', canPublish: true, canSubscribe: true, canPublishData: false,
      }, subscriberWs.asWebSocket(), { registry });
      await subscriber.start({ addTrackRequests: [] });

      subscriberWs.receive(requestFrame(6, subscriptionBody([trackSid], true)));
      await vi.waitFor(() => expect(lastSent(subscriberWs, 3)).toBeDefined());
      const remoteCall = callsFetch.calls.find((call) => JSON.stringify(call.body).includes('"remote"'));
      expect(remoteCall?.body).toMatchObject({
        tracks: [{ location: 'remote', sessionId: 'sess-1', trackName: 'screen' }],
      });
      const offer = lastSent(subscriberWs, 3)!;
      expect(s(offer.body, 2)).toBe(SUBSCRIBER_OFFER_SDP);
      const offerId = n(offer.body, 3)!;
      expect(offerId).toBeGreaterThan(0);

      subscriberWs.receive(requestFrame(2, sdBody('answer', ANSWER_SDP, offerId)));
      await vi.waitFor(() => expect(callsFetch.calls.some((call) => call.url.includes('/renegotiate'))).toBe(true));
      const renegotiate = callsFetch.calls.find((call) => call.url.includes('/renegotiate'))!;
      expect(renegotiate.method).toBe('PUT');
      expect(renegotiate.body).toEqual({ sessionDescription: { type: 'answer', sdp: ANSWER_SDP } });
      publisher.close();
      subscriber.close();
    });

    it('does not subscribe when the JWT forbids subscribing', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), {
        identity: 'carol', room: 'room_g', canPublish: true, canSubscribe: false, canPublishData: false,
      }, ws.asWebSocket(), { registry: new LiveKitShimRegistry(5, 5) });
      await shim.start({ addTrackRequests: [] });
      ws.receive(requestFrame(6, subscriptionBody(['TR_missing'], true)));
      await settled();
      expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new'))).toBe(false);
      shim.close();
    });
  });

  describe('close, errors and caps', () => {
    it('removes the participant, notifies the room and closes published Calls tracks', async () => {
      const registry = new LiveKitShimRegistry(5, 5);
      const env = makeEnv();
      const firstWs = new FakeSocket();
      const first = new LiveKitCallsShimSession(env, await identityFor('room_h'), firstWs.asWebSocket(), { registry });
      await first.start({ addTrackRequests: [] });
      firstWs.receive(requestFrame(4, addTrackBody('cid-1', 'cam', 1, 1)));
      firstWs.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 1)));
      await vi.waitFor(() => expect(lastSent(firstWs, 6)).toBeDefined());

      const secondWs = new FakeSocket();
      const second = new LiveKitCallsShimSession(env, {
        identity: 'bob', room: 'room_h', canPublish: true, canSubscribe: true, canPublishData: false,
      }, secondWs.asWebSocket(), { registry });
      await second.start({ addTrackRequests: [] });
      expect(n(msgs(decodeFrame(secondWs.sent[0]).body, 3)[0]!, 3)).toBeDefined();

      first.close();
      expect(registry.size).toBe(1);
      expect(firstWs.closeCode).toBe(1000);
      const update = lastSent(secondWs, 5);
      expect(update).toBeDefined();
      expect(n(msgs(update!.body, 1)[0]!, 3)).toBe(3); // ParticipantInfo.State.DISCONNECTED
      await vi.waitFor(() => expect(callsFetch.calls.some((call) => call.url.includes('/tracks/close'))).toBe(true));
      const closeCall = callsFetch.calls.find((call) => call.url.includes('/tracks/close'))!;
      expect(closeCall.body).toMatchObject({ tracks: [{ mid: '0' }], force: true });
      second.close();
    });

    it('enforces the global and per-room participant caps before creating Calls sessions', async () => {
      const registry = new LiveKitShimRegistry(1, 1);
      const env = makeEnv();
      const first = new LiveKitCallsShimSession(env, await identityFor('room_i'), new FakeSocket().asWebSocket(), { registry });
      await first.start({ addTrackRequests: [] });
      expect(callsFetch.calls).toHaveLength(1);

      const rejectedWs = new FakeSocket();
      const second = new LiveKitCallsShimSession(env, {
        identity: 'bob', room: 'room_i', canPublish: true, canSubscribe: true, canPublishData: false,
      }, rejectedWs.asWebSocket(), { registry });
      await second.start({ addTrackRequests: [] });
      expect(rejectedWs.accepted).toBe(false);
      expect(rejectedWs.closeCode).toBe(1013);
      expect(callsFetch.calls).toHaveLength(1);
      first.close();
    });

    it('rejects duplicate identities in the same room', async () => {
      const registry = new LiveKitShimRegistry(5, 5);
      const env = makeEnv();
      const first = new LiveKitCallsShimSession(env, await identityFor('room_j'), new FakeSocket().asWebSocket(), { registry });
      await first.start({ addTrackRequests: [] });
      const duplicateWs = new FakeSocket();
      const duplicate = new LiveKitCallsShimSession(env, await identityFor('room_j'), duplicateWs.asWebSocket(), { registry });
      await duplicate.start({ addTrackRequests: [] });
      expect(duplicateWs.closeCode).toBe(1013);
      expect(registry.size).toBe(1);
      first.close();
    });

    it('answers deprecated pings and ignores unsupported requests without breaking the socket', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_k'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });
      ws.receive(cat(varint(14 * 8), varint(42)).buffer as ArrayBuffer);
      ws.receive(requestFrame(13, fstr(1, 'simulate')));
      await settled();
      expect(varintFrameValue(ws.sent.at(-1), 18)).toBe(42);
      expect(ws.closeCode).toBeUndefined();
      shim.close();
    });
  });

  describe('helpers', () => {
    it('infers mime types for local tracks from SDP m-lines', () => {
      expect(inferMimeType(OFFER_SDP, '0', 1)).toBe('video/vp8');
      const audio = OFFER_SDP.replace('m=video 9 UDP/TLS/RTP/SAVPF 96', 'm=audio 9 UDP/TLS/RTP/SAVPF 111')
        .replace('a=rtpmap:96 VP8/90000', 'a=rtpmap:111 opus/48000/2');
      expect(inferMimeType(audio, '0', 0)).toBe('audio/opus');
    });

    it('decodes JSON-mode SignalRequests', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_l'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });
      const frame: SignalRequestJson = { message: 'subscription', value: { trackSids: [], subscribe: true } };
      ws.receive(JSON.stringify({ [frame.message]: frame.value }));
      await settled();
      expect(ws.closeCode).toBeUndefined();
      shim.close();
    });
  });
});
