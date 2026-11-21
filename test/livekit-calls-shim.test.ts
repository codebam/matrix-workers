// Tests for the LiveKit -> Cloudflare Calls compatibility shim.
// The Calls REST API and the LiveKit WebSocket frames are both mocked here;
// no network calls and no real LiveKit server are involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIVEKIT_STUN_URLS,
  DEFAULT_SHIM_PING_INTERVAL_SECONDS,
  DEFAULT_SHIM_PING_TIMEOUT_SECONDS,
  decodePb,
  handleLiveKitSignalRequest,
  inferMimeType,
  injectTrickleCandidates,
  LiveKitShimRegistry,
  LiveKitCallsShimSession,
  parseStunUrls,
  verifyLiveKitJwt,
  type LiveKitIdentity,
  type SignalRequestJson,
} from '../src/services/livekit-calls-shim';
import { generateLiveKitToken } from '../src/services/livekit';
import {
  CloudflareCallsError,
  establishDataChannelTransport,
} from '../src/services/cloudflare-calls';
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
const INITIAL_OFFER_SDP = [
  'v=0', 'o=- 3 3 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'a=mid:0', '',
].join('\r\n');

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

function trickleBody(candidateInit: string, target: number): Uint8Array {
  return cat(fstr(1, candidateInit), fnum(2, target));
}

const SRFLX_CANDIDATE = 'candidate:1 1 udp 2130706431 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0';

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

function sentFrames(ws: FakeSocket, field: number): Array<{ field: number; body: Body }> {
  return ws.sent.map(decodeFrame).filter((frame) => frame.field === field);
}

function lastSent(ws: FakeSocket, field: number): { field: number; body: Body } | undefined {
  return sentFrames(ws, field).at(-1);
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

function localTracksCall(calls: CallsCall[]): CallsCall | undefined {
  return calls.find((call) => call.url.includes('/tracks/new')
    && Array.isArray(call.body.tracks)
    && (call.body.tracks as Array<{ location?: string }>).some((track) => track.location === 'local'));
}

async function answerInitialOffer(ws: FakeSocket, calls: CallsCall[]): Promise<number> {
  const initial = sentFrames(ws, 3)[0]!;
  const id = n(initial.body, 3)!;
  ws.receive(requestFrame(2, sdBody('answer', ANSWER_SDP, id)));
  await vi.waitFor(() => expect(calls.some((call) => call.url.includes('/renegotiate'))).toBe(true));
  return id;
}

function installCallsFetch(options: { failDatachannels?: boolean } = {}): { calls: CallsCall[]; restore: () => void } {
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
    if (url.includes('/datachannels/establish')) {
      if (options.failDatachannels) {
        return new Response(JSON.stringify({
          errorCode: 'invalid_params',
          errorDescription: 'Datachannels unavailable',
        }), { status: 406, headers: { 'Content-Type': 'application/json' } });
      }
      return Response.json({
        sessionDescription: body.sessionDescription
          ? { type: 'answer', sdp: ANSWER_SDP }
          : { type: 'offer', sdp: INITIAL_OFFER_SDP },
        requiresImmediateRenegotiation: !body.sessionDescription,
        dataChannel: { location: 'remote', dataChannelName: 'server-events', id: 0 },
      });
    }
    if (url.includes('/tracks/new')) {
      const tracks = body.tracks as Array<{ location: string; trackName?: string }>;
      const isLocal = tracks[0]?.location === 'local';
      const initialOffer = tracks.length === 0;
      return Response.json({
        sessionDescription: {
          type: isLocal ? 'answer' : 'offer',
          sdp: isLocal ? ANSWER_SDP : initialOffer ? INITIAL_OFFER_SDP : SUBSCRIBER_OFFER_SDP,
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
    it('creates publisher and subscriber Calls sessions and sends join + initial offer', async () => {
      const ws = new FakeSocket();
      const registry = new LiveKitShimRegistry(5, 5);
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_b'), ws.asWebSocket(), { registry });
      await shim.start({ addTrackRequests: [] });

      expect(ws.accepted).toBe(true);
      const sessions = callsFetch.calls.filter((call) => call.url.endsWith('/sessions/new'));
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({ method: 'POST' });
      expect(sessions[0]!.url).toBe(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/new`);
      expect(sessions[1]!.url).toBe(sessions[0]!.url);
      const establish = callsFetch.calls.find((call) => call.url.includes('/datachannels/establish'))!;
      expect(establish.method).toBe('POST');
      expect(establish.url).toBe(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/sess-2/datachannels/establish`);
      expect(establish.body).toEqual({ dataChannel: { location: 'remote', dataChannelName: 'server-events' } });
      expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new')
        && (call.body.tracks as unknown[]).length === 0)).toBe(false);
      const join = decodeFrame(ws.sent[0]);
      expect(join.field).toBe(1); // SignalResponse.join
      expect(s(msgs(join.body, 1)[0]!, 2)).toBe('room_b');
      expect(n(join.body, 6)).toBe(0); // subscriberPrimary = false
      shim.close();
    });

    it('advertises ICE servers, sane ping timers and protocol 17 in the binary JoinResponse', async () => {
      const ws = new FakeSocket();
      const env = makeEnv();
      env.LIVEKIT_STUN_URLS = 'stun:one.example:3478, stun:two.example:3478';
      const shim = new LiveKitCallsShimSession(env, await identityFor('room_transport'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      // SDK 2.25 sends protocol 18; the shim deliberately answers 17 so the
      // SDK falls back from negotiated to in-band data channels.
      await shim.start({
        addTrackRequests: [],
        clientInfo: { sdk: 1, version: '2.25.0', protocol: 18, clientProtocol: 3 },
      });

      const join = decodeFrame(ws.sent[0]);
      expect(n(join.body, 10)).toBe(DEFAULT_SHIM_PING_TIMEOUT_SECONDS);
      expect(n(join.body, 11)).toBe(DEFAULT_SHIM_PING_INTERVAL_SECONDS);
      const serverInfo = msgs(join.body, 12)[0]!;
      expect(n(serverInfo, 3)).toBe(17);
      expect(n(join.body, 6)).toBe(0); // subscriberPrimary = false

      const iceServers = msgs(join.body, 5); // JoinResponse.ice_servers = 5
      expect(iceServers).toHaveLength(1);
      expect(iceServers[0]!.get(1)?.map((entry) => decoder.decode(entry.bytes!))).toEqual([
        'stun:one.example:3478',
        'stun:two.example:3478',
      ]);
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

      const tracksCall = localTracksCall(callsFetch.calls)!;
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

    it('folds trickled publisher candidates into the SDP sent to Calls', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_trickle'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });

      ws.receive(requestFrame(4, addTrackBody('cid-trickle', 'camera', 1, 1)));
      ws.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 7)));
      ws.receive(requestFrame(3, trickleBody(JSON.stringify({
        candidate: SRFLX_CANDIDATE,
        sdpMid: '0',
        sdpMLineIndex: 0,
      }), 0)));
      await vi.waitFor(() => expect(lastSent(ws, 2)).toBeDefined());

      const tracksCall = localTracksCall(callsFetch.calls)!;
      const outboundSdp = (tracksCall.body.sessionDescription as { sdp: string }).sdp;
      expect(outboundSdp).toContain(SRFLX_CANDIDATE);
      // Calls' answer is still passed through verbatim: it already carries its own candidates.
      expect(s(lastSent(ws, 2)!.body, 2)).toBe(ANSWER_SDP);
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
      await vi.waitFor(() => expect(localTracksCall(callsFetch.calls)).toBeDefined());
      const tracksCall = localTracksCall(callsFetch.calls)!;
      expect(tracksCall.body.tracks).toEqual([{ location: 'local', trackName: 'mic' }]);
      shim.close();
    });

    it('answers a trackless publisher offer via datachannels instead of empty tracks', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_trackless'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({
        addTrackRequests: [],
        publisherOffer: { type: 'offer', sdp: OFFER_SDP, id: 7 },
      });
      await vi.waitFor(() => expect(sentFrames(ws, 2).length).toBeGreaterThan(0));

      const establish = callsFetch.calls.find((call) => call.url.includes('/datachannels/establish')
        && call.body.sessionDescription)!;
      expect(establish.url).toContain('/sessions/sess-1/datachannels/establish');
      expect(establish.body.sessionDescription).toEqual({ type: 'offer', sdp: OFFER_SDP });
      expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new')
        && (call.body.tracks as unknown[]).length === 0)).toBe(false);

      const answer = sentFrames(ws, 2).find((frame) => s(frame.body, 1) === 'answer')!;
      expect(s(answer.body, 2)).toBe(ANSWER_SDP);
      expect(n(answer.body, 3)).toBe(7);
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
      expect(localTracksCall(callsFetch.calls)).toBeUndefined();
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
      await answerInitialOffer(subscriberWs, callsFetch.calls);

      subscriberWs.receive(requestFrame(6, subscriptionBody([trackSid], true)));
      await vi.waitFor(() => expect(sentFrames(subscriberWs, 3)).toHaveLength(2));
      const remoteCall = callsFetch.calls.find((call) => call.url.includes('/tracks/new')
        && JSON.stringify(call.body).includes('"remote"'));
      expect(remoteCall?.url).toContain('/sessions/sess-4/tracks/new');
      expect(remoteCall?.body).toMatchObject({
        tracks: [{ location: 'remote', sessionId: 'sess-1', trackName: 'screen' }],
      });
      const offer = lastSent(subscriberWs, 3)!;
      expect(s(offer.body, 2)).toBe(SUBSCRIBER_OFFER_SDP);
      const offerId = n(offer.body, 3)!;
      expect(offerId).toBeGreaterThan(0);

      subscriberWs.receive(requestFrame(2, sdBody('answer', ANSWER_SDP, offerId)));
      await vi.waitFor(() => expect(callsFetch.calls.filter((call) => call.url.includes('/renegotiate'))).toHaveLength(2));
      const renegotiate = callsFetch.calls.filter((call) => call.url.includes('/renegotiate')).at(-1)!;
      expect(renegotiate.method).toBe('PUT');
      expect(renegotiate.body).toEqual({ sessionDescription: { type: 'answer', sdp: ANSWER_SDP } });
      publisher.close();
      subscriber.close();
    });

    it('starts the subscriber PC with one Calls offer, applies its answer, and reuses that session for subscriptions', async () => {
      const registry = new LiveKitShimRegistry(5, 5);
      const env = makeEnv();
      const publisherWs = new FakeSocket();
      const publisher = new LiveKitCallsShimSession(env, await identityFor('room_initial_offer'), publisherWs.asWebSocket(), { registry });
      await publisher.start({ addTrackRequests: [] });
      publisherWs.receive(requestFrame(4, addTrackBody('cid-pub', 'camera', 1, 1)));
      publisherWs.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 3)));
      await vi.waitFor(() => expect(lastSent(publisherWs, 6)).toBeDefined());
      const trackSid = s(msgs(lastSent(publisherWs, 6)!.body, 2)[0]!, 1)!;

      const subscriberWs = new FakeSocket();
      const subscriber = new LiveKitCallsShimSession(env, {
        identity: '@bob:example.org', room: 'room_initial_offer', canPublish: true, canSubscribe: true, canPublishData: false,
      }, subscriberWs.asWebSocket(), { registry });
      await subscriber.start({ addTrackRequests: [] });

      // Join creates a dedicated subscriber session and drives its PC with a
      // single Calls-generated offer, even before any track is subscribed.
      expect(callsFetch.calls.filter((call) => call.url.endsWith('/sessions/new'))).toHaveLength(4);
      const establish = callsFetch.calls.filter((call) => call.url.includes('/datachannels/establish')).at(-1)!;
      expect(establish.url).toContain('/sessions/sess-4/datachannels/establish');
      expect(establish.body).toEqual({ dataChannel: { location: 'remote', dataChannelName: 'server-events' } });
      expect(callsFetch.calls.some((call) => call.url.includes('/tracks/new')
        && (call.body.tracks as unknown[]).length === 0)).toBe(false);
      const initialOffers = sentFrames(subscriberWs, 3);
      expect(initialOffers).toHaveLength(1);
      const initial = initialOffers[0]!;
      expect(s(initial.body, 1)).toBe('offer');
      expect(s(initial.body, 2)).toBe(INITIAL_OFFER_SDP);
      expect(s(initial.body, 2)!.length).toBeGreaterThan(0);
      // A transport-only offer has no LiveKit track mapping (SessionDescription.mid_to_track_id = 4).
      expect(initial.body.get(4)).toBeUndefined();

      // The client answer is submitted to Calls on that same subscriber session.
      const initialId = n(initial.body, 3)!;
      subscriberWs.receive(requestFrame(2, sdBody('answer', ANSWER_SDP, initialId)));
      await vi.waitFor(() => expect(callsFetch.calls.filter((call) => call.url.includes('/renegotiate'))).toHaveLength(1));
      const initialRenegotiate = callsFetch.calls.filter((call) => call.url.includes('/renegotiate')).at(-1)!;
      expect(initialRenegotiate.url).toContain('/sessions/sess-4/renegotiate');
      expect(initialRenegotiate.body).toEqual({ sessionDescription: { type: 'answer', sdp: ANSWER_SDP } });

      // A later subscription reuses sess-4: it adds one new offer (new id),
      // never a second subscriber session or a duplicate initial offer.
      subscriberWs.receive(requestFrame(6, subscriptionBody([trackSid], true)));
      await vi.waitFor(() => expect(sentFrames(subscriberWs, 3)).toHaveLength(2));
      const offers = sentFrames(subscriberWs, 3);
      expect(s(offers[1]!.body, 2)).toBe(SUBSCRIBER_OFFER_SDP);
      expect(n(offers[1]!.body, 3)).toBeGreaterThan(initialId);
      expect(callsFetch.calls.filter((call) => call.url.endsWith('/sessions/new'))).toHaveLength(4);
      const remoteCall = callsFetch.calls.find((call) => call.url.includes('/tracks/new')
        && JSON.stringify(call.body).includes('"remote"'))!;
      expect(remoteCall.url).toContain('/sessions/sess-4/tracks/new');
      expect(remoteCall.body).toMatchObject({ tracks: [{ location: 'remote', sessionId: 'sess-1' }] });
      publisher.close();
      subscriber.close();
    });

    it('folds trickled subscriber candidates into the answer sent to Calls', async () => {
      const registry = new LiveKitShimRegistry(5, 5);
      const env = makeEnv();
      const publisherWs = new FakeSocket();
      const publisher = new LiveKitCallsShimSession(env, await identityFor('room_sub_trickle'), publisherWs.asWebSocket(), { registry });
      await publisher.start({ addTrackRequests: [] });
      publisherWs.receive(requestFrame(4, addTrackBody('cid-pub', 'screen', 1, 3)));
      publisherWs.receive(requestFrame(1, sdBody('offer', OFFER_SDP, 3)));
      await vi.waitFor(() => expect(lastSent(publisherWs, 6)).toBeDefined());
      const trackSid = s(msgs(lastSent(publisherWs, 6)!.body, 2)[0]!, 1)!;

      const subscriberWs = new FakeSocket();
      const subscriber = new LiveKitCallsShimSession(env, {
        identity: '@dave:example.org', room: 'room_sub_trickle', canPublish: true, canSubscribe: true, canPublishData: false,
      }, subscriberWs.asWebSocket(), { registry });
      await subscriber.start({ addTrackRequests: [] });
      await answerInitialOffer(subscriberWs, callsFetch.calls);
      subscriberWs.receive(requestFrame(6, subscriptionBody([trackSid], true)));
      await vi.waitFor(() => expect(sentFrames(subscriberWs, 3)).toHaveLength(2));
      const offerId = n(sentFrames(subscriberWs, 3).at(-1)!.body, 3)!;

      subscriberWs.receive(requestFrame(2, sdBody('answer', ANSWER_SDP, offerId)));
      subscriberWs.receive(requestFrame(3, trickleBody(JSON.stringify({
        candidate: SRFLX_CANDIDATE,
        sdpMid: '0',
        sdpMLineIndex: 0,
      }), 1)));
      await vi.waitFor(() => expect(callsFetch.calls.filter((call) => call.url.includes('/renegotiate'))).toHaveLength(2));
      const renegotiate = callsFetch.calls.filter((call) => call.url.includes('/renegotiate')).at(-1)!;
      expect((renegotiate.body.sessionDescription as { sdp: string }).sdp).toContain(SRFLX_CANDIDATE);
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

  describe('datachannel transport establishment', () => {
    it('requests a transport offer from the documented Calls endpoint and returns the SDP', async () => {
      const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`https://rtc.live.cloudflare.com/v1/apps/${CALLS_APP_ID}/sessions/sess-dc/datachannels/establish`);
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          dataChannel: { location: 'remote', dataChannelName: 'server-events' },
        });
        return Response.json({
          sessionDescription: { type: 'offer', sdp: INITIAL_OFFER_SDP },
          requiresImmediateRenegotiation: true,
          dataChannel: { dataChannelName: 'server-events', id: 0 },
        });
      });
      vi.stubGlobal('fetch', mock);

      const offer = await establishDataChannelTransport(makeEnv(), 'sess-dc');
      expect(mock).toHaveBeenCalledTimes(1);
      expect(offer).toEqual({ type: 'offer', sdp: INITIAL_OFFER_SDP });
    });

    it('throws a clear NO_OFFER error when Calls returns no sessionDescription', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        requiresImmediateRenegotiation: true,
        dataChannel: { dataChannelName: 'server-events', id: 0 },
      })));

      await expect(establishDataChannelTransport(makeEnv(), 'sess-dc')).rejects.toMatchObject({
        name: 'CloudflareCallsError',
        code: 'NO_OFFER',
        statusCode: 500,
      });
      await expect(establishDataChannelTransport(makeEnv(), 'sess-dc')).rejects.toBeInstanceOf(CloudflareCallsError);
    });

    it('falls back to empty tracks with a log when the datachannels endpoint fails', async () => {
      callsFetch.restore();
      callsFetch = installCallsFetch({ failDatachannels: true });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_fallback'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });

      expect(callsFetch.calls.some((call) => call.url.includes('/datachannels/establish'))).toBe(true);
      const emptyTracks = callsFetch.calls.find((call) => call.url.includes('/tracks/new')
        && (call.body.tracks as unknown[]).length === 0)!;
      expect(emptyTracks.url).toContain('/sessions/sess-2/tracks/new');
      expect(emptyTracks.body).toEqual({ tracks: [] });
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('datachannels/establish failed'),
        expect.stringContaining('Calls API error')
      );
      const initial = sentFrames(ws, 3)[0]!;
      expect(s(initial.body, 2)).toBe(INITIAL_OFFER_SDP);
      expect(initial.body.get(4)).toBeUndefined();
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
      expect(callsFetch.calls).toHaveLength(3); // two sessions + initial subscriber offer

      const rejectedWs = new FakeSocket();
      const second = new LiveKitCallsShimSession(env, {
        identity: 'bob', room: 'room_i', canPublish: true, canSubscribe: true, canPublishData: false,
      }, rejectedWs.asWebSocket(), { registry });
      await second.start({ addTrackRequests: [] });
      expect(rejectedWs.accepted).toBe(false);
      expect(rejectedWs.closeCode).toBe(1013);
      expect(callsFetch.calls).toHaveLength(3);
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

    it('answers binary pingReq frames with pongResp', async () => {
      const ws = new FakeSocket();
      const shim = new LiveKitCallsShimSession(makeEnv(), await identityFor('room_ping_req'), ws.asWebSocket(), {
        registry: new LiveKitShimRegistry(5, 5),
      });
      await shim.start({ addTrackRequests: [] });
      ws.receive(requestFrame(16, cat(fnum(1, 1234), fnum(2, 7))));
      await settled();
      const frame = decodeFrame(ws.sent.at(-1));
      expect(frame.field).toBe(20); // SignalResponse.pong_resp = 20
      const pongResp = frame.body;
      expect(n(pongResp, 1)).toBe(1234);
      expect(n(pongResp, 2)).toBeGreaterThan(0);
      expect(ws.closeCode).toBeUndefined();
      shim.close();
    });
  });

  describe('helpers', () => {
    it('parses STUN URL overrides and falls back to the default', () => {
      expect(parseStunUrls(undefined)).toEqual([DEFAULT_LIVEKIT_STUN_URLS]);
      expect(parseStunUrls('')).toEqual([DEFAULT_LIVEKIT_STUN_URLS]);
      expect(parseStunUrls(' stun:a:3478,,stun:b:3478 ')).toEqual(['stun:a:3478', 'stun:b:3478']);
    });

    it('injects trickled candidates into the matching SDP m-section', () => {
      const twoMediaSdp = [
        'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:1', '',
      ].join('\r\n');
      const result = injectTrickleCandidates(twoMediaSdp, [
        { line: SRFLX_CANDIDATE, mid: '1' },
      ]);
      expect(result).toContain(`a=mid:1\r\n${SRFLX_CANDIDATE}`);
      expect(result.indexOf(SRFLX_CANDIDATE)).toBeGreaterThan(result.indexOf('m=video'));
    });

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
