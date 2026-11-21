// LiveKit -> Cloudflare Calls compatibility shim.
//
// LiveKit clients (Element Web/X) terminate their signaling WebSocket at a
// LiveKit server. This module terminates that WebSocket in the Worker and
// translates the minimum viable call flow into Cloudflare Calls sessions:
//
//   join_request (query) + SignalResponse.join   -> one Calls session per publisher PC
//   SignalRequest.offer / add_track              -> POST /sessions/{id}/tracks/new (local)
//   SignalResponse.track_published               -> synthesized TrackInfo for the client
//   SignalRequest.subscription                   -> POST /sessions/{id}/tracks/new (remote)
//   SignalResponse.offer / SignalRequest.answer  -> subscriber negotiation + /renegotiate
//
// Wire details verified against livekit/protocol livekit_rtc.proto and
// livekit/client-sdk-js SignalClient.ts (see the report accompanying this
// change): signals are protobuf binary by default, JSON when the SDK opts in;
// JoinRequest is carried base64url-encoded in the `join_request` query param
// (WrappedJoinRequest, optionally gzip compressed), and the JWT is in
// `access_token`.
//
// Room state lives in LiveKitShimDurableObject (one instance per Matrix room);
// the Worker only verifies the JWT and forwards the upgrade to that DO, which
// owns every participant socket. Deliberate gaps: data channels, simulcast
// layers, E2EE/SIF trailer, recording/egress, ICE trickle forwarding, and
// reconnect/resume. See the report for details.

import type { Env } from '../types';
import {
  addTracks,
  closeTracks,
  createSession,
  renegotiate,
  type SessionDescription,
  type TrackObject,
} from './cloudflare-calls';

// ---------------------------------------------------------------------------
// Public limits and errors
// ---------------------------------------------------------------------------

/** Hard global cap on simultaneously attached shim sockets per Worker isolate. */
export const DEFAULT_MAX_PARTICIPANTS = 50;
/** Hard cap on participants in one LiveKit room per Worker isolate. */
export const DEFAULT_MAX_PER_ROOM = 10;
/** Hard cap on published tracks per participant. */
export const DEFAULT_MAX_TRACKS_PER_PARTICIPANT = 4;
/** Refuse absurd SDPs before they reach the Calls API. */
export const MAX_SDP_BYTES = 128_000;

export class ShimAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShimAuthError';
  }
}

export class ShimCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShimCapacityError';
  }
}

// ---------------------------------------------------------------------------
// Minimal protobuf codec (only the wire types used by LiveKit signaling)
// ---------------------------------------------------------------------------

type Bytes = Uint8Array;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface PbField {
  wire: number;
  num: number;
  bytes?: Bytes;
}
type PbObject = Map<number, PbField[]>;

function concatBytes(...parts: Bytes[]): Bytes {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varintBytes(value: number): Bytes {
  if (!Number.isFinite(value) || value < 0) return new Uint8Array();
  let remaining = Math.floor(value);
  const out: number[] = [];
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  return new Uint8Array(out);
}

function pbTag(field: number, wire: number): Bytes {
  return varintBytes(field * 8 + wire);
}

function pbNum(field: number, value: number | boolean | undefined): Bytes {
  if (value === undefined) return new Uint8Array();
  return concatBytes(pbTag(field, 0), varintBytes(typeof value === 'boolean' ? Number(value) : value));
}

function pbStr(field: number, value: string | undefined): Bytes {
  if (value === undefined) return new Uint8Array();
  const bytes = textEncoder.encode(value);
  return concatBytes(pbTag(field, 2), varintBytes(bytes.length), bytes);
}

function pbBytes(field: number, value: Bytes | undefined): Bytes {
  if (!value) return new Uint8Array();
  return concatBytes(pbTag(field, 2), varintBytes(value.length), value);
}

function pbMsg(field: number, value: Bytes | undefined): Bytes {
  return pbBytes(field, value);
}

function readVarint(buf: Bytes, pos: number): { value: number; next: number } {
  let value = 0;
  let shift = 1;
  let index = pos;
  while (index < buf.length) {
    const byte = buf[index++]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift *= 128;
  }
  throw new Error('truncated protobuf varint');
}

export function decodePb(buf: Bytes): PbObject {
  const out: PbObject = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    let parsed: PbField;
    if (wire === 0) {
      const value = readVarint(buf, pos);
      pos = value.next;
      parsed = { wire, num: value.value };
    } else if (wire === 2) {
      const length = readVarint(buf, pos);
      pos = length.next;
      if (pos + length.value > buf.length) throw new Error('truncated protobuf field');
      parsed = { wire, num: 0, bytes: buf.slice(pos, pos + length.value) };
      pos += length.value;
    } else if (wire === 5) {
      pos += 4;
      parsed = { wire, num: 0 };
    } else if (wire === 1) {
      pos += 8;
      parsed = { wire, num: 0 };
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error('truncated protobuf field');
    const list = out.get(field) ?? [];
    list.push(parsed);
    out.set(field, list);
  }
  return out;
}

function fieldStr(obj: PbObject, field: number): string | undefined {
  const bytes = fieldBytes(obj, field);
  return bytes === undefined ? undefined : textDecoder.decode(bytes);
}

function fieldBytes(obj: PbObject, field: number): Bytes | undefined {
  return obj.get(field)?.find((entry) => entry.bytes !== undefined)?.bytes;
}

function fieldNum(obj: PbObject, field: number): number | undefined {
  return obj.get(field)?.find((entry) => entry.wire === 0)?.num;
}

function fieldBool(obj: PbObject, field: number): boolean {
  return fieldNum(obj, field) === 1;
}

function fieldMsg(obj: PbObject, field: number): PbObject | undefined {
  const bytes = fieldBytes(obj, field);
  return bytes === undefined ? undefined : decodePb(bytes);
}

function fieldMsgs(obj: PbObject, field: number): PbObject[] {
  return (obj.get(field) ?? []).flatMap((entry) => (entry.bytes ? [decodePb(entry.bytes)] : []));
}

function fieldStrs(obj: PbObject, field: number): string[] {
  return (obj.get(field) ?? []).flatMap((entry) => (entry.bytes ? [textDecoder.decode(entry.bytes)] : []));
}

// ---------------------------------------------------------------------------
// Protobuf-JSON-shaped internal messages (camelCase, as protobuf-json uses)
// ---------------------------------------------------------------------------

export interface SdJson {
  type?: string;
  sdp?: string;
  id?: number;
  midToTrackId?: Record<string, string>;
}

export interface TrackInfoJson {
  sid: string;
  type?: number;
  name?: string;
  muted?: boolean;
  width?: number;
  height?: number;
  source?: number;
  mimeType?: string;
  mid?: string;
  stream?: string;
}

export interface ParticipantInfoJson {
  sid: string;
  identity: string;
  state?: number;
  tracks?: TrackInfoJson[];
  metadata?: string;
  joinedAt?: number;
  name?: string;
  version?: number;
  permission?: { canSubscribe?: boolean; canPublish?: boolean; canPublishData?: boolean; hidden?: boolean };
  isPublisher?: boolean;
}

export interface JoinResponseJson {
  room: { sid: string; name: string; maxParticipants?: number; creationTime?: number; numParticipants?: number; numPublishers?: number };
  participant: ParticipantInfoJson;
  otherParticipants?: ParticipantInfoJson[];
  serverVersion?: string;
  subscriberPrimary?: boolean;
  pingTimeout?: number;
  pingInterval?: number;
  serverInfo?: { version?: string; protocol?: number; region?: string; nodeId?: string };
  enabledPublishCodecs?: Array<{ mime?: string; fmtpLine?: string }>;
}

export type SignalResponseJson =
  | { message: 'join'; value: JoinResponseJson }
  | { message: 'answer' | 'offer'; value: SdJson }
  | { message: 'trickle'; value: { candidateInit?: string; target?: number; final?: boolean } }
  | { message: 'update'; value: { participants: ParticipantInfoJson[] } }
  | { message: 'trackPublished'; value: { cid: string; track: TrackInfoJson } }
  | { message: 'leave'; value: { canReconnect?: boolean; reason?: number; action?: number } }
  | { message: 'pong'; value: number }
  | { message: 'pongResp'; value: { lastPingTimestamp?: number; timestamp?: number } };

export type SignalRequestJson =
  | { message: 'offer' | 'answer'; value: SdJson }
  | { message: 'trickle'; value: { candidateInit?: string; target?: number; final?: boolean } }
  | { message: 'addTrack'; value: { cid?: string; name?: string; type?: number; width?: number; height?: number; muted?: boolean; source?: number; stream?: string } }
  | { message: 'subscription'; value: { trackSids: string[]; subscribe?: boolean } }
  | { message: 'leave'; value: { canReconnect?: boolean; reason?: number; action?: number } }
  | { message: 'ping'; value: number }
  | { message: 'pingReq'; value: { timestamp?: number; rtt?: number } }
  | { message: 'unknown'; value?: undefined };

function encodeSd(sd: SdJson): Bytes {
  const mapEntries = Object.entries(sd.midToTrackId ?? {}).map(([mid, sid]) =>
    pbMsg(4, concatBytes(pbStr(1, mid), pbStr(2, sid)))
  );
  return concatBytes(
    pbStr(1, sd.type),
    pbStr(2, sd.sdp),
    pbNum(3, sd.id),
    ...mapEntries
  );
}

function encodeTrackInfo(track: TrackInfoJson): Bytes {
  return concatBytes(
    pbStr(1, track.sid),
    pbNum(2, track.type),
    pbStr(3, track.name),
    pbNum(4, track.muted),
    pbNum(5, track.width),
    pbNum(6, track.height),
    pbNum(9, track.source),
    pbStr(11, track.mimeType),
    pbStr(12, track.mid),
    pbStr(17, track.stream)
  );
}

function encodePermission(permission: ParticipantInfoJson['permission']): Bytes {
  return concatBytes(
    pbNum(1, permission?.canSubscribe),
    pbNum(2, permission?.canPublish),
    pbNum(3, permission?.canPublishData),
    pbNum(7, permission?.hidden)
  );
}

function encodeParticipant(p: ParticipantInfoJson): Bytes {
  return concatBytes(
    pbStr(1, p.sid),
    pbStr(2, p.identity),
    pbNum(3, p.state),
    ...(p.tracks ?? []).map((track) => pbMsg(4, encodeTrackInfo(track))),
    pbStr(5, p.metadata),
    pbNum(6, p.joinedAt),
    pbStr(9, p.name),
    pbNum(10, p.version),
    pbMsg(11, encodePermission(p.permission)),
    pbNum(13, p.isPublisher)
  );
}

function encodeJoinResponse(join: JoinResponseJson): Bytes {
  const room = join.room;
  const roomBytes = concatBytes(
    pbStr(1, room.sid),
    pbStr(2, room.name),
    pbNum(4, room.maxParticipants),
    pbNum(5, room.creationTime),
    pbNum(9, room.numParticipants),
    pbNum(11, room.numPublishers)
  );
  const serverInfo = join.serverInfo;
  const serverInfoBytes = concatBytes(
    pbStr(2, serverInfo?.version),
    pbNum(3, serverInfo?.protocol),
    pbStr(4, serverInfo?.region),
    pbStr(5, serverInfo?.nodeId)
  );
  return concatBytes(
    pbMsg(1, roomBytes),
    pbMsg(2, encodeParticipant(join.participant)),
    ...(join.otherParticipants ?? []).map((p) => pbMsg(3, encodeParticipant(p))),
    pbStr(4, join.serverVersion),
    pbNum(6, join.subscriberPrimary),
    pbNum(10, join.pingTimeout),
    pbNum(11, join.pingInterval),
    pbMsg(12, serverInfoBytes),
    ...(join.enabledPublishCodecs ?? []).map((codec) =>
      pbMsg(14, concatBytes(pbStr(1, codec.mime), pbStr(2, codec.fmtpLine)))
    )
  );
}

/** Encode a SignalResponse as protobuf binary (the LiveKit SDK default). */
export function encodeSignalResponse(msg: SignalResponseJson): Bytes {
  switch (msg.message) {
    case 'join':
      return pbMsg(1, encodeJoinResponse(msg.value));
    case 'answer':
      return pbMsg(2, encodeSd(msg.value));
    case 'offer':
      return pbMsg(3, encodeSd(msg.value));
    case 'trickle':
      return pbMsg(4, concatBytes(
        pbStr(1, msg.value.candidateInit),
        pbNum(2, msg.value.target),
        pbNum(3, msg.value.final)
      ));
    case 'update':
      return pbMsg(5, concatBytes(...msg.value.participants.map((p) => pbMsg(1, encodeParticipant(p)))));
    case 'trackPublished':
      return pbMsg(6, concatBytes(
        pbStr(1, msg.value.cid),
        pbMsg(2, encodeTrackInfo(msg.value.track))
      ));
    case 'leave':
      return pbMsg(8, concatBytes(
        pbNum(1, msg.value.canReconnect),
        pbNum(2, msg.value.reason),
        pbNum(3, msg.value.action)
      ));
    case 'pong':
      return pbNum(18, msg.value);
    case 'pongResp':
      return pbMsg(20, concatBytes(
        pbNum(1, msg.value.lastPingTimestamp),
        pbNum(2, msg.value.timestamp)
      ));
  }
}

/** Decode one SignalRequest frame. Accepts binary protobuf or protobuf-JSON. */
export function decodeSignalRequest(data: unknown): SignalRequestJson {
  if (typeof data === 'string') return decodeJsonRequest(data);
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : undefined;
  if (!bytes) return { message: 'unknown' };
  const obj = decodePb(bytes);
  const offer = fieldMsg(obj, 1);
  if (offer) return { message: 'offer', value: decodeSdObj(offer) };
  const answer = fieldMsg(obj, 2);
  if (answer) return { message: 'answer', value: decodeSdObj(answer) };
  const trickle = fieldMsg(obj, 3);
  if (trickle) {
    return {
      message: 'trickle',
      value: {
        candidateInit: fieldStr(trickle, 1),
        target: fieldNum(trickle, 2),
        final: fieldBool(trickle, 3),
      },
    };
  }
  const addTrack = fieldMsg(obj, 4);
  if (addTrack) {
    return {
      message: 'addTrack',
      value: {
        cid: fieldStr(addTrack, 1),
        name: fieldStr(addTrack, 2),
        type: fieldNum(addTrack, 3),
        width: fieldNum(addTrack, 4),
        height: fieldNum(addTrack, 5),
        muted: fieldBool(addTrack, 6),
        source: fieldNum(addTrack, 8),
        stream: fieldStr(addTrack, 15),
      },
    };
  }
  const subscription = fieldMsg(obj, 6);
  if (subscription) {
    return {
      message: 'subscription',
      value: { trackSids: fieldStrs(subscription, 1), subscribe: fieldBool(subscription, 2) },
    };
  }
  const leave = fieldMsg(obj, 8);
  if (leave) {
    return {
      message: 'leave',
      value: { canReconnect: fieldBool(leave, 1), reason: fieldNum(leave, 2), action: fieldNum(leave, 3) },
    };
  }
  const ping = fieldNum(obj, 14);
  if (ping !== undefined) return { message: 'ping', value: ping };
  const pingReq = fieldMsg(obj, 16);
  if (pingReq) {
    return { message: 'pingReq', value: { timestamp: fieldNum(pingReq, 1), rtt: fieldNum(pingReq, 2) } };
  }
  return { message: 'unknown' };
}

function decodeSdObj(obj: PbObject): SdJson {
  const midToTrackId: Record<string, string> = {};
  for (const entry of fieldMsgs(obj, 4)) {
    const mid = fieldStr(entry, 1);
    const sid = fieldStr(entry, 2);
    if (mid !== undefined && sid !== undefined) midToTrackId[mid] = sid;
  }
  return { type: fieldStr(obj, 1), sdp: fieldStr(obj, 2), id: fieldNum(obj, 3), midToTrackId };
}

function decodeJsonRequest(data: string): SignalRequestJson {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { message: 'unknown' };
  }
  const known = ['offer', 'answer', 'trickle', 'addTrack', 'subscription', 'leave', 'ping', 'pingReq'] as const;
  const key = known.find((name) => raw[name] !== undefined);
  if (!key) return { message: 'unknown' };
  const value = raw[key] as Record<string, unknown>;
  switch (key) {
    case 'offer':
    case 'answer':
      return { message: key, value: (value ?? {}) as SdJson };
    case 'addTrack':
      return { message: key, value: (value ?? {}) as Extract<SignalRequestJson, { message: 'addTrack' }>['value'] };
    case 'subscription':
      return {
        message: key,
        value: {
          trackSids: Array.isArray(value?.trackSids) ? value.trackSids.map(String) : [],
          subscribe: value?.subscribe === true,
        },
      };
    case 'trickle':
    case 'leave':
    case 'pingReq':
      return { message: key, value: (value ?? {}) as never };
    case 'ping':
      return { message: 'ping', value: Number(raw.ping) };
  }
}

// ---------------------------------------------------------------------------
// JWT verification (mirrors generateLiveKitToken's conventions)
// ---------------------------------------------------------------------------

export interface LiveKitIdentity {
  identity: string;
  room: string;
  name?: string;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
}

function base64UrlBytes(value: string): Bytes {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Verify an HS256 LiveKit JWT. Throws ShimAuthError on any validation failure. */
export async function verifyLiveKitJwt(
  token: string,
  apiKey: string,
  apiSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<LiveKitIdentity> {
  if (!apiKey || !apiSecret) throw new ShimAuthError('LiveKit is not configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new ShimAuthError('Malformed JWT');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(textDecoder.decode(base64UrlBytes(headerB64))) as Record<string, unknown>;
    claims = JSON.parse(textDecoder.decode(base64UrlBytes(payloadB64))) as Record<string, unknown>;
  } catch {
    throw new ShimAuthError('Malformed JWT');
  }
  if (header.alg !== 'HS256') throw new ShimAuthError('Unsupported JWT algorithm');
  if (typeof claims.iss !== 'string' || claims.iss !== apiKey) throw new ShimAuthError('JWT issuer mismatch');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new ShimAuthError('JWT missing subject');
  if (typeof claims.exp !== 'number' || !Number.isInteger(claims.exp) || claims.exp <= nowSeconds) {
    throw new ShimAuthError('JWT expired');
  }
  if (typeof claims.nbf !== 'number' || !Number.isInteger(claims.nbf) || claims.nbf > nowSeconds) {
    throw new ShimAuthError('JWT not yet valid');
  }
  const video = claims.video;
  if (!video || typeof video !== 'object') throw new ShimAuthError('JWT missing video grant');
  const grant = video as Record<string, unknown>;
  if (grant.roomJoin !== true) throw new ShimAuthError('JWT does not grant roomJoin');
  if (typeof grant.room !== 'string' || grant.room.length === 0) throw new ShimAuthError('JWT missing room');
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlBytes(signatureB64),
    textEncoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new ShimAuthError('JWT signature mismatch');
  return {
    identity: claims.sub,
    room: grant.room,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    canPublish: grant.canPublish === true,
    canSubscribe: grant.canSubscribe === true,
    canPublishData: grant.canPublishData === true,
  };
}

// ---------------------------------------------------------------------------
// JoinRequest in the query string
// ---------------------------------------------------------------------------

export interface JoinRequestJson {
  clientInfo?: { sdk?: number; version?: string; protocol?: number; clientProtocol?: number };
  connectionSettings?: { autoSubscribe?: boolean };
  reconnect?: boolean;
  participantSid?: string;
  addTrackRequests: Extract<SignalRequestJson, { message: 'addTrack' }>['value'][];
  publisherOffer?: SdJson;
}

export async function decodeJoinRequestParam(raw: string | null): Promise<JoinRequestJson> {
  const empty: JoinRequestJson = { addTrackRequests: [] };
  if (!raw) return empty;
  try {
    const wrapped = decodePb(base64UrlBytes(raw));
    const compression = fieldNum(wrapped, 1);
    let payload = fieldBytes(wrapped, 2);
    if (!payload) return empty;
    if (compression === 1) {
      if (typeof DecompressionStream === 'undefined') throw new Error('gzip unsupported');
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'));
      payload = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const join = decodePb(payload);
    const clientInfo = fieldMsg(join, 1);
    const connectionSettings = fieldMsg(join, 2);
    const publisherOffer = fieldMsg(join, 6);
    return {
      clientInfo: clientInfo ? {
        sdk: fieldNum(clientInfo, 1),
        version: fieldStr(clientInfo, 2),
        protocol: fieldNum(clientInfo, 3),
        clientProtocol: fieldNum(clientInfo, 12),
      } : undefined,
      connectionSettings: connectionSettings ? { autoSubscribe: fieldBool(connectionSettings, 1) } : undefined,
      reconnect: fieldBool(join, 7),
      participantSid: fieldStr(join, 9),
      addTrackRequests: fieldMsgs(join, 5).map((obj) => {
        return {
          cid: fieldStr(obj, 1),
          name: fieldStr(obj, 2),
          type: fieldNum(obj, 3),
          width: fieldNum(obj, 4),
          height: fieldNum(obj, 5),
          muted: fieldBool(obj, 6),
          source: fieldNum(obj, 8),
          stream: fieldStr(obj, 15),
        };
      }),
      publisherOffer: publisherOffer ? decodeSdObj(publisherOffer) : undefined,
    };
  } catch (error) {
    throw new ShimAuthError(`Invalid join_request: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Registry with hard caps. Each LiveKitShimDurableObject owns exactly one of
// these, so room state is shared by every Worker isolate that forwards a
// signaling upgrade to the same DO.
// ---------------------------------------------------------------------------

interface ShimParticipant {
  sid: string;
  room: string;
  identity: LiveKitIdentity;
  ws: WebSocket;
  publisherSessionId: string;
  subscriberSessionId?: string;
  tracks: PublishedTrack[];
  pending: Map<string, PendingTrack>;
  joinedAt: number;
  closed: boolean;
  nextOfferId: number;
  pendingOffers: Map<number, { trackSid: string; needsRenegotiation: boolean }>;
  subscribedMids: Map<string, string>;
  queues: Map<string, Promise<void>>;
  tricklesDropped: number;
  jsonMode: boolean;
}

interface PendingTrack {
  cid: string;
  trackName: string;
  type: number;
  source: number;
  width: number;
  height: number;
  muted: boolean;
  stream?: string;
}

interface PublishedTrack {
  sid: string;
  cid: string;
  trackName: string;
  type: number;
  source: number;
  width: number;
  height: number;
  muted: boolean;
  stream?: string;
  mimeType: string;
  mid: string;
  ownerSid: string;
  publisherSessionId: string;
}

export class LiveKitShimRegistry {
  private readonly participants = new Map<string, ShimParticipant>();

  constructor(
    public readonly maxParticipants: number = DEFAULT_MAX_PARTICIPANTS,
    public readonly maxPerRoom: number = DEFAULT_MAX_PER_ROOM
  ) {}

  get size(): number {
    return this.participants.size;
  }

  add(participant: ShimParticipant): void {
    if (this.participants.size >= this.maxParticipants) {
      throw new ShimCapacityError('Global participant cap reached');
    }
    const inRoom = this.inRoom(participant.room);
    if (inRoom.length >= this.maxPerRoom) {
      throw new ShimCapacityError('Room participant cap reached');
    }
    if (inRoom.some((p) => p.identity.identity === participant.identity.identity)) {
      throw new ShimCapacityError('Duplicate participant identity');
    }
    this.participants.set(participant.sid, participant);
  }

  remove(sid: string): void {
    this.participants.delete(sid);
  }

  inRoom(room: string): ShimParticipant[] {
    return [...this.participants.values()].filter((p) => !p.closed && p.room === room);
  }

  findTrack(sid: string): { track: PublishedTrack; owner: ShimParticipant } | undefined {
    for (const owner of this.participants.values()) {
      const track = owner.tracks.find((t) => t.sid === sid);
      if (track) return { track, owner };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SDP helpers
// ---------------------------------------------------------------------------

/** Best-effort mime type for a Calls-assigned mid, used in TrackInfo. */
export function inferMimeType(sdp: string, mid?: string, type = 1): string {
  const sections: Array<{ mid?: string; kind: string; payloads: string[] }> = [];
  const rtpmap = new Map<string, string>();
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      const parts = line.slice(2).split(' ');
      sections.push({ kind: parts[0] === 'audio' ? 'audio' : 'video', payloads: parts.slice(3) });
    } else if (line.startsWith('a=mid:') && sections.length) {
      sections[sections.length - 1]!.mid = line.slice(6).trim();
    } else if (line.startsWith('a=rtpmap:')) {
      const match = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
      if (match) rtpmap.set(match[1]!, match[2]!);
    }
  }
  const section = (mid && sections.find((candidate) => candidate.mid === mid))
    || sections[0]
    || { kind: type === 0 ? 'audio' : 'video', payloads: [] as string[] };
  const encoding = section.payloads.map((payload) => rtpmap.get(payload)).find(Boolean);
  return `${section.kind}/${(encoding ?? (section.kind === 'audio' ? 'opus' : 'vp8')).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// WebSocket terminator
// ---------------------------------------------------------------------------

export interface ShimOptions {
  /** Room-scoped registry; supplied by the DO, never by the Worker isolate. */
  registry: LiveKitShimRegistry;
  maxTracksPerParticipant?: number;
  now?: () => number;
  /** Server protocol advertised to clients; 17 avoids negotiated data channels. */
  serverProtocol?: number;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function sendFrame(ws: WebSocket, msg: SignalResponseJson, jsonMode: boolean): void {
  ws.send(jsonMode ? JSON.stringify({ [msg.message]: msg.value }) : encodeSignalResponse(msg));
}

function participantInfo(participant: ShimParticipant, state: number): ParticipantInfoJson {
  return {
    sid: participant.sid,
    identity: participant.identity.identity,
    state,
    tracks: participant.tracks.map((track) => ({
      sid: track.sid,
      type: track.type,
      name: track.trackName,
      muted: track.muted,
      width: track.width,
      height: track.height,
      source: track.source,
      mimeType: track.mimeType,
      mid: track.mid,
      stream: track.stream,
    })),
    joinedAt: participant.joinedAt,
    name: participant.identity.name,
    isPublisher: true,
  };
}

export class LiveKitCallsShimSession {
  private readonly participant: ShimParticipant;
  private readonly registry: LiveKitShimRegistry;
  private readonly maxTracks: number;
  private readonly now: () => number;
  private readonly serverProtocol: number;
  private closed = false;

  constructor(
    private readonly env: Env,
    identity: LiveKitIdentity,
    ws: WebSocket,
    options: ShimOptions
  ) {
    this.registry = options.registry;
    this.maxTracks = options.maxTracksPerParticipant ?? DEFAULT_MAX_TRACKS_PER_PARTICIPANT;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.serverProtocol = options.serverProtocol ?? 17;
    this.participant = {
      sid: randomId('PA'),
      room: identity.room,
      identity,
      ws,
      publisherSessionId: '',
      tracks: [],
      pending: new Map(),
      joinedAt: this.now(),
      closed: false,
      nextOfferId: 1,
      pendingOffers: new Map(),
      subscribedMids: new Map(),
      queues: new Map(),
      tricklesDropped: 0,
      jsonMode: false,
    };
  }

  get participantSid(): string {
    return this.participant.sid;
  }

  async start(joinRequest: JoinRequestJson): Promise<void> {
    const ws = this.participant.ws;
    try {
      this.registry.add(this.participant);
    } catch (error) {
      this.fail(error);
      return;
    }
    ws.accept();
    this.participant.jsonMode = false;
    ws.addEventListener('message', (event: MessageEvent) => {
      void this.onMessage(event.data);
    });
    ws.addEventListener('close', () => this.close());
    ws.addEventListener('error', () => this.close());

    try {
      const session = await createSession(this.env);
      this.participant.publisherSessionId = session.sessionId;
      this.sendJoin(joinRequest);
      for (const request of joinRequest.addTrackRequests) this.handleAddTrack(request);
      if (joinRequest.publisherOffer?.sdp) await this.handleOffer(joinRequest.publisherOffer);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    console.error('[livekit-shim] session failed:', error);
    this.close(error instanceof ShimCapacityError ? 1013 : 1011);
  }

  private send(msg: SignalResponseJson): void {
    if (this.closed) return;
    try {
      sendFrame(this.participant.ws, msg, this.participant.jsonMode);
    } catch (error) {
      console.error('[livekit-shim] send failed:', error);
    }
  }

  private sendJoin(joinRequest: JoinRequestJson): void {
    const p = this.participant;
    const others = this.registry.inRoom(p.room).filter((other) => other.sid !== p.sid);
    this.send({
      message: 'join',
      value: {
        room: {
          sid: randomId('RM'),
          name: p.room,
          maxParticipants: this.registry.maxPerRoom,
          creationTime: p.joinedAt,
          numParticipants: others.length + 1,
          numPublishers: others.length + 1,
        },
        participant: participantInfo(p, 1), // JOINED
        otherParticipants: others.map((other) => participantInfo(other, other.tracks.length ? 2 : 1)),
        serverVersion: 'livekit-calls-shim',
        subscriberPrimary: false, // publisher PC first; server offers drive subscriber PC
        pingTimeout: 0,
        pingInterval: 0,
        serverInfo: { version: 'shim-1', protocol: this.serverProtocol, nodeId: 'calls-shim' },
        enabledPublishCodecs: [
          { mime: 'audio/opus' },
          { mime: 'video/vp8' },
          { mime: 'video/h264' },
        ],
      },
    });
    // Ignore join-time metadata/attributes from the client: room and identity
    // come from the verified JWT only.
    void joinRequest;
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.participant.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.participant.queues.set(key, next);
    return next;
  }

  private async onMessage(data: unknown): Promise<void> {
    if (this.closed) return;
    const request = decodeSignalRequest(data);
    if (typeof data === 'string') this.participant.jsonMode = true;
    try {
      switch (request.message) {
        case 'addTrack':
          this.handleAddTrack(request.value);
          break;
        case 'offer':
          await this.handleOffer(request.value);
          break;
        case 'subscription':
          await this.handleSubscription(request.value);
          break;
        case 'answer':
          await this.handleAnswer(request.value);
          break;
        case 'trickle':
          // Calls has no REST trickle endpoint; its SDP carries candidates.
          this.participant.tricklesDropped++;
          break;
        case 'ping':
          this.send({ message: 'pong', value: request.value });
          break;
        case 'pingReq':
          this.send({
            message: 'pongResp',
            value: { lastPingTimestamp: request.value.timestamp, timestamp: this.now() * 1000 },
          });
          break;
        case 'leave':
          this.close(1000);
          break;
        case 'unknown':
        default:
          break;
      }
    } catch (error) {
      console.error('[livekit-shim] message failed:', error);
      this.fail(error);
    }
  }

  private handleAddTrack(track: Extract<SignalRequestJson, { message: 'addTrack' }>['value']): void {
    const p = this.participant;
    if (!p.identity.canPublish) return;
    if (!track.cid || p.pending.has(track.cid) || p.tracks.some((t) => t.cid === track.cid)) return;
    if (p.pending.size + p.tracks.length >= this.maxTracks) {
      this.fail(new ShimCapacityError('Published track cap reached'));
      return;
    }
    p.pending.set(track.cid, {
      cid: track.cid,
      trackName: track.name || track.cid,
      type: track.type ?? 1,
      source: track.source ?? 0,
      width: track.width ?? 0,
      height: track.height ?? 0,
      muted: track.muted ?? false,
      stream: track.stream,
    });
  }

  private async handleOffer(sd: SdJson): Promise<void> {
    const sdp = sd.sdp ?? '';
    if (sdp.length > MAX_SDP_BYTES) throw new ShimCapacityError('SDP too large');
    if (!sdp) return;
    const p = this.participant;
    await this.enqueue('publisher', async () => {
      const pending = [...p.pending.values()];
      const tracks: TrackObject[] = pending.map((track) => ({ location: 'local', trackName: track.trackName }));
      const response = await addTracks(this.env, p.publisherSessionId, {
        sessionDescription: { type: 'offer', sdp } as SessionDescription,
        tracks,
      });
      const answer = response.sessionDescription;
      if (!answer || answer.type !== 'answer') throw new Error('Calls did not return an answer');
      const published: PublishedTrack[] = [];
      response.tracks.forEach((result, index) => {
        const pendingTrack = pending[index];
        if (!pendingTrack) return;
        if (result.errorCode) {
          console.error('[livekit-shim] track rejected:', result.errorCode, result.errorDescription);
          return;
        }
        p.pending.delete(pendingTrack.cid);
        const track: PublishedTrack = {
          ...pendingTrack,
          sid: randomId('TR'),
          mimeType: inferMimeType(answer.sdp, result.mid, pendingTrack.type),
          mid: result.mid,
          ownerSid: p.sid,
          publisherSessionId: p.publisherSessionId,
        };
        p.tracks.push(track);
        published.push(track);
      });
      this.send({ message: 'answer', value: { type: 'answer', sdp: answer.sdp, id: sd.id } });
      for (const track of published) {
        this.send({
          message: 'trackPublished',
          value: { cid: track.cid, track: participantTrackInfo(track) },
        });
      }
      if (published.length) this.broadcastUpdate();
      // Calls may set requiresImmediateRenegotiation on a publish; the client
      // offer/answer pair is already complete here, so only the subscriber
      // path (which receives a Calls offer) needs the follow-up exchange.
    });
  }

  private async handleSubscription(value: Extract<SignalRequestJson, { message: 'subscription' }>['value']): Promise<void> {
    const p = this.participant;
    if (!p.identity.canSubscribe || value.subscribe === false) return;
    for (const trackSid of value.trackSids ?? []) {
      const found = this.registry.findTrack(trackSid);
      if (!found || found.owner.sid === p.sid) continue;
      await this.enqueue('subscriber', async () => {
        if (!p.subscriberSessionId) {
          const session = await createSession(this.env);
          p.subscriberSessionId = session.sessionId;
        }
        const response = await addTracks(this.env, p.subscriberSessionId, {
          tracks: [{
            location: 'remote',
            sessionId: found.track.publisherSessionId,
            trackName: found.track.trackName,
          }],
        });
        const offer = response.sessionDescription;
        if (!offer || offer.type !== 'offer') throw new Error('Calls did not return an offer');
        const mid = response.tracks[0]?.mid;
        p.subscribedMids.set(trackSid, mid ?? '');
        this.sendCallsOffer(offer, mid ? { [mid]: trackSid } : undefined, response.requiresImmediateRenegotiation, trackSid);
      });
    }
  }

  private sendCallsOffer(
    offer: SessionDescription,
    midToTrackId?: Record<string, string>,
    needsRenegotiation = false,
    trackSid?: string
  ): void {
    const p = this.participant;
    const id = ++p.nextOfferId;
    if (trackSid || needsRenegotiation) {
      p.pendingOffers.set(id, { trackSid: trackSid ?? '', needsRenegotiation });
    }
    this.send({ message: 'offer', value: { type: 'offer', sdp: offer.sdp, id, midToTrackId } });
  }

  private async handleAnswer(sd: SdJson): Promise<void> {
    const p = this.participant;
    const pending = sd.id === undefined ? undefined : p.pendingOffers.get(sd.id);
    if (!pending || !p.subscriberSessionId) return;
    if ((sd.sdp ?? '').length > MAX_SDP_BYTES) throw new ShimCapacityError('SDP too large');
    p.pendingOffers.delete(sd.id!);
    await this.enqueue('subscriber', async () => {
      const response = await renegotiate(this.env, p.subscriberSessionId!, {
        sessionDescription: { type: 'answer', sdp: sd.sdp ?? '' } as SessionDescription,
      });
      if (response.sessionDescription?.type === 'offer') {
        this.sendCallsOffer(response.sessionDescription, undefined, true, pending.trackSid || undefined);
      }
    });
  }

  private broadcastUpdate(): void {
    const changed = participantInfo(this.participant, 2);
    for (const other of this.registry.inRoom(this.participant.room)) {
      if (other.sid === this.participant.sid) continue;
      sendFrame(other.ws, { message: 'update', value: { participants: [changed] } }, other.jsonMode);
    }
  }

  /** Detach the socket, release capacity, close Calls tracks, notify the room. */
  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    const p = this.participant;
    p.closed = true;
    this.registry.remove(p.sid);
    for (const other of this.registry.inRoom(p.room)) {
      sendFrame(other.ws, { message: 'update', value: { participants: [participantInfo(p, 3)] } }, other.jsonMode);
    }
    const mids = p.tracks.map((track) => track.mid).filter(Boolean);
    if (p.publisherSessionId && mids.length) {
      void closeTracks(this.env, p.publisherSessionId, mids, true).catch((error) => {
        console.warn('[livekit-shim] track cleanup failed:', error);
      });
    }
    try {
      p.ws.close(code, 'shim session closed');
    } catch {
      // already closed
    }
  }
}

function participantTrackInfo(track: PublishedTrack): TrackInfoJson {
  return {
    sid: track.sid,
    type: track.type,
    name: track.trackName,
    muted: track.muted,
    width: track.width,
    height: track.height,
    source: track.source,
    mimeType: track.mimeType,
    mid: track.mid,
    stream: track.stream,
  };
}

// ---------------------------------------------------------------------------
// HTTP upgrade entry point
// ---------------------------------------------------------------------------

export interface HandleOptions {
  /** Injectable for tests; defaults to `env.LIVEKIT_SHIM`. */
  namespace?: DurableObjectNamespace;
}

/**
 * Handle a LiveKit signaling upgrade. Wire this at `/livekit/signal/*` so that
 * both `/livekit/signal/rtc/v1` (current SDK) and `/livekit/signal/rtc`
 * (v0 path) are covered. Requires Upgrade: websocket, a valid LiveKit JWT in
 * `access_token`, and optional base64url `join_request`.
 *
 * The Worker verifies credentials, then forwards the *unmodified* upgrade
 * request to the room's Durable Object and returns its 101 response verbatim.
 * The DO accepts the server socket and owns the registry and all broadcasts;
 * no signaling state is kept in the Worker isolate.
 */
export async function handleLiveKitSignalRequest(
  request: Request,
  env: Env,
  options: HandleOptions = {}
): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 400 });
  }
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return Response.json({ error: 'LiveKit not configured' }, { status: 503 });
  }
  const url = new URL(request.url);
  const token = url.searchParams.get('access_token')
    ?? request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Missing access_token' }, { status: 401 });

  let room: string;
  try {
    const identity = await verifyLiveKitJwt(token, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
    room = identity.room;
    // Reject malformed join requests here as before; the DO decodes them too.
    await decodeJoinRequestParam(url.searchParams.get('join_request'));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Invalid credentials' }, { status: 401 });
  }

  const namespace = options.namespace ?? env.LIVEKIT_SHIM;
  if (!namespace) return Response.json({ error: 'LiveKit shim DO not configured' }, { status: 503 });
  return await namespace.get(namespace.idFromName(room)).fetch(request);
}

/** Exposed so the route can advertise the capability in discovery responses. */
export const LIVEKIT_SHIM_SIGNAL_PATH = '/livekit/signal';
