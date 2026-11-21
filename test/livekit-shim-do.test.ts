// Unit tests for the per-room Durable Object that owns LiveKit shim state.
// Worker "isolates" are modelled by repeated calls through one stubbed DO
// namespace; Calls REST and the WebSocket pair are both stubbed locally.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveKitShimDurableObject, type LiveKitShimDOOptions } from '../src/durable-objects/LiveKitShimDO';
import { decodePb, handleLiveKitSignalRequest } from '../src/services/livekit-calls-shim';
import { generateLiveKitToken } from '../src/services/livekit';
import type { Env } from '../src/types';

const API_KEY = 'test-api-key';
const API_SECRET = 'test-api-secret';
const CALLS_APP_ID = 'test-app';
const CALLS_APP_SECRET = 'test-calls-secret';

const OFFER_SDP = [
  'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=rtpmap:96 VP8/90000', '',
].join('\r\n');
const ANSWER_SDP = OFFER_SDP.replace('o=- 0 0', 'o=- 1 1');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesOf(frame: unknown): Uint8Array {
  if (frame instanceof Uint8Array) return frame;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return encoder.encode(String(frame));
}

function pbStr(body: Map<number, Array<{ bytes?: Uint8Array }>>, field: number): string | undefined {
  const value = body.get(field)?.[0]?.bytes;
  return value === undefined ? undefined : decoder.decode(value);
}

/** Pull identities from SignalResponse.join (field 1 -> join, 2/3 -> participants). */
function joinIdentities(frame: unknown): { self: string; others: string[] } {
  const joinBytes = decodePb(bytesOf(frame)).get(1)?.[0]?.bytes;
  if (!joinBytes) throw new Error('expected SignalResponse.join');
  const join = decodePb(joinBytes);
  const selfBytes = join.get(2)?.[0]?.bytes;
  if (!selfBytes) throw new Error('expected join.participant');
  return {
    self: pbStr(decodePb(selfBytes), 2)!,
    others: (join.get(3) ?? []).flatMap((entry) => entry.bytes ? [pbStr(decodePb(entry.bytes), 2)!] : []),
  };
}

class FakeSocket {
  accepted = false;
  sent: unknown[] = [];
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  accept(): void { this.accepted = true; }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: unknown): void { this.sent.push(data); }

  close(code?: number): void {
    this.closeCode = code;
    this.emit('close', {});
  }

  receive(data: unknown): void { this.emit('message', { data }); }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }
}

interface Pair { client: FakeSocket; server: FakeSocket }
const pairs: Pair[] = [];

function makeEnv(namespace: DurableObjectNamespace): Env {
  return {
    DB: {}, SESSIONS: {}, CACHE: {},
    CALLS_APP_ID, CALLS_APP_SECRET,
    LIVEKIT_API_KEY: API_KEY, LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_SHIM: namespace,
    SERVER_NAME: 'example.org',
  } as unknown as Env;
}

function installCallsFetch(): { calls: Array<{ url: string; method: string }>; restore: () => void } {
  const calls: Array<{ url: string; method: string }> = [];
  let sessionCounter = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/sessions/new')) {
      sessionCounter++;
      return Response.json({ sessionId: `sess-${sessionCounter}` });
    }
    if (url.includes('/tracks/new')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tracks: Array<{ location: string; trackName?: string }> };
      const local = body.tracks[0]?.location === 'local';
      return Response.json({
        sessionDescription: { type: local ? 'answer' : 'offer', sdp: local ? ANSWER_SDP : OFFER_SDP },
        tracks: body.tracks.map((track, index) => ({ mid: String(index), trackName: track.trackName ?? 'remote' })),
        requiresImmediateRenegotiation: false,
      });
    }
    return Response.json({});
  }));
  return { calls, restore: () => vi.unstubAllGlobals() };
}

function makeStorage(): { state: DurableObjectState; alarm: () => number | null } {
  let alarm: number | null = null;
  return {
    state: {
      storage: {
        getAlarm: async () => alarm,
        setAlarm: async (time: number) => { alarm = time; },
        deleteAlarm: async () => { alarm = null; },
      },
    } as unknown as DurableObjectState,
    alarm: () => alarm,
  };
}

function makeNamespace(
  instances: Map<string, LiveKitShimDurableObject>,
  storages: Map<string, ReturnType<typeof makeStorage>>,
  env: Env,
  options?: LiveKitShimDOOptions
): { namespace: DurableObjectNamespace; idFromName: ReturnType<typeof vi.fn> } {
  const idFromName = vi.fn((name: string) => ({ name }) as unknown as DurableObjectId);
  const namespace = {
    idFromName,
    get: (id: { name: string }) => ({
      fetch: async (request: Request) => {
        let instance = instances.get(id.name);
        if (!instance) {
          const storage = makeStorage();
          storages.set(id.name, storage);
          instance = new LiveKitShimDurableObject(storage.state, env, options);
          instances.set(id.name, instance);
        }
        return instance.fetch(request);
      },
    }),
  } as unknown as DurableObjectNamespace;
  return { namespace, idFromName };
}

async function upgradeRequest(room: string, identity: string): Promise<Request> {
  const token = await generateLiveKitToken(API_KEY, API_SECRET, room, identity);
  return new Request(
    `https://example.org/livekit/signal/rtc/v1?access_token=${encodeURIComponent(token)}`,
    { headers: { Upgrade: 'websocket' } }
  );
}

describe('LiveKitShimDurableObject', () => {
  let callsFetch: ReturnType<typeof installCallsFetch>;

  beforeEach(() => {
    callsFetch = installCallsFetch();
    pairs.length = 0;
    vi.stubGlobal('WebSocketPair', class {
      constructor() {
        const pair: Pair = { client: new FakeSocket(), server: new FakeSocket() };
        pairs.push(pair);
        return { 0: pair.client, 1: pair.server } as unknown as object;
      }
    });
    // Node's Response rejects 101; Workers accepts it with a webSocket field.
    const NodeResponse = globalThis.Response;
    class WorkersResponse extends NodeResponse {
      webSocket?: unknown;
      constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
        const { webSocket, ...rest } = init ?? {};
        super(body, webSocket ? { ...rest, status: 200 } : rest);
        this.webSocket = webSocket;
      }
    }
    vi.stubGlobal('Response', WorkersResponse);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shares one registry per room across isolates and lists other participants', async () => {
    const instances = new Map<string, LiveKitShimDurableObject>();
    const storages = new Map<string, ReturnType<typeof makeStorage>>();
    const env = makeEnv({} as DurableObjectNamespace);
    const { namespace, idFromName } = makeNamespace(instances, storages, env);

    await handleLiveKitSignalRequest(await upgradeRequest('room_shared', '@alice:example.org'), env, { namespace });
    expect(joinIdentities(pairs[0]!.server.sent[0]).others).toEqual([]);

    await handleLiveKitSignalRequest(await upgradeRequest('room_shared', '@bob:example.org'), env, { namespace });
    expect(joinIdentities(pairs[1]!.server.sent[0]).self).toBe('@bob:example.org');
    expect(joinIdentities(pairs[1]!.server.sent[0]).others).toEqual(['@alice:example.org']);

    await handleLiveKitSignalRequest(await upgradeRequest('room_other', '@carol:example.org'), env, { namespace });
    expect(joinIdentities(pairs[2]!.server.sent[0]).others).toEqual([]);
    expect(instances.size).toBe(2);
    expect(idFromName).toHaveBeenCalledWith('room_shared');
    expect(callsFetch.calls.filter((call) => call.url.endsWith('/sessions/new'))).toHaveLength(3);
  });

  it('treats SDK v0 joins without a join_request as full joins', async () => {
    const instances = new Map<string, LiveKitShimDurableObject>();
    const storages = new Map<string, ReturnType<typeof makeStorage>>();
    const env = makeEnv({} as DurableObjectNamespace);
    const { namespace } = makeNamespace(instances, storages, env);

    // The v0 path (forced by the shim's /rtc/v1 404) sends only query markers.
    const token = await generateLiveKitToken(API_KEY, API_SECRET, 'room_v0', '@dave:example.org');
    const request = new Request(
      `https://example.org/livekit/signal/rtc?access_token=${encodeURIComponent(token)}`
        + '&auto_subscribe=1&sdk=js&version=2.25.0&protocol=18&client_protocol=3',
      { headers: { Upgrade: 'websocket' } }
    );
    await handleLiveKitSignalRequest(request, env, { namespace });

    const join = joinIdentities(pairs[0]!.server.sent[0]);
    expect(join.self).toBe('@dave:example.org');
    // A full join opens the subscriber transport: publisher and subscriber
    // sessions plus the subscriber's datachannel establish.
    expect(callsFetch.calls.filter((call) => call.url.endsWith('/sessions/new'))).toHaveLength(2);
    expect(callsFetch.calls.some((call) => call.url.includes('/datachannels/establish'))).toBe(true);
  });

  it('enforces per-room and global caps in the DO before creating Calls sessions', async () => {
    const instances = new Map<string, LiveKitShimDurableObject>();
    const storages = new Map<string, ReturnType<typeof makeStorage>>();
    const env = makeEnv({} as DurableObjectNamespace);
    const { namespace } = makeNamespace(instances, storages, env, { maxParticipants: 2, maxPerRoom: 1 });

    await handleLiveKitSignalRequest(await upgradeRequest('room_cap', '@alice:example.org'), env, { namespace });
    await handleLiveKitSignalRequest(await upgradeRequest('room_cap', '@bob:example.org'), env, { namespace });
    expect(pairs[1]!.server.closeCode).toBe(1013);
    expect(pairs[1]!.server.sent).toHaveLength(0);
    expect(callsFetch.calls).toHaveLength(1);

    await handleLiveKitSignalRequest(await upgradeRequest('room_second', '@bob:example.org'), env, { namespace });
    expect(pairs[2]!.server.sent.length).toBeGreaterThan(0);
  });

  it('expires idle sessions on alarm and reschedules until sockets are gone', async () => {
    const instances = new Map<string, LiveKitShimDurableObject>();
    const storages = new Map<string, ReturnType<typeof makeStorage>>();
    const env = makeEnv({} as DurableObjectNamespace);
    let nowSeconds = 1_700_000_000;
    const { namespace } = makeNamespace(instances, storages, env, {
      idleTtlSeconds: 2,
      now: () => nowSeconds,
    });

    await handleLiveKitSignalRequest(await upgradeRequest('room_ttl', '@alice:example.org'), env, { namespace });
    const instance = instances.get('room_ttl')!;
    const storage = storages.get('room_ttl')!;
    expect(storage.alarm()).not.toBeNull();

    await instance.alarm();
    expect(pairs[0]!.server.closeCode).toBeUndefined();

    // A signaling message refreshes the idle deadline.
    nowSeconds += 1;
    pairs[0]!.server.receive(new ArrayBuffer(0));
    nowSeconds += 1;
    await instance.alarm();
    expect(pairs[0]!.server.closeCode).toBeUndefined();

    nowSeconds += 2;
    await instance.alarm();
    expect(pairs[0]!.server.closeCode).toBe(1000);
    expect(storage.alarm()).toBeNull();
  });

  it('rejects non-upgrade requests before touching the registry', async () => {
    const state = makeStorage().state;
    const env = makeEnv({} as DurableObjectNamespace);
    const doInstance = new LiveKitShimDurableObject(state, env);
    const response = await doInstance.fetch(new Request('https://example.org/livekit/signal'));
    expect(response.status).toBe(400);
    expect(pairs).toHaveLength(0);
  });
});
