// Matrix Protocol Types

// User ID format: @localpart:domain
export type UserId = string;

// Room ID format: !opaque_id:domain
export type RoomId = string;

// Event ID format: $base64:domain
export type EventId = string;

// Room alias format: #alias:domain
export type RoomAlias = string;

// Server name format: domain or domain:port
export type ServerName = string;

// Device ID
export type DeviceId = string;

// Membership states
export type Membership = 'join' | 'invite' | 'leave' | 'ban' | 'knock';

// Presence states
export type PresenceState = 'online' | 'offline' | 'unavailable';

// Base event structure
export interface MatrixEvent {
  event_id: EventId;
  room_id: RoomId;
  sender: UserId;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  unsigned?: UnsignedData;
}

export interface UnsignedData {
  age?: number;
  transaction_id?: string;
  prev_content?: Record<string, unknown>;
  // Spec v1.19: on client-formatted state events, the event ID of the state
  // event this one replaces.
  replaces_state?: string;
  redacted_because?: MatrixEvent;
  'm.relations'?: Record<string, unknown>;
}

// Persistent Data Unit (PDU) - events as stored/transmitted
export interface PDU extends MatrixEvent {
  auth_events: EventId[];
  prev_events: EventId[];
  depth: number;
  // Server that created the event. Optional on modern wires, but mandatory on
  // federation membership endpoints (/send_join, /send_knock) and part of the
  // redaction-preserved event in room versions 1-10, so it is hashed/signed
  // when present and must be persisted verbatim.
  origin?: string;
  // MSC4354 / spec v1.20: a message event may be "sticky" for a limited time.
  // The object is part of the federated event (content hash) and is stripped
  // by redaction.
  sticky?: { duration_ms: number };
  hashes?: {
    sha256: string;
  };
  signatures?: Record<ServerName, Record<string, string>>;
  redacts?: EventId; // For m.room.redaction events
}

// Room state event types
export interface RoomCreateContent {
  creator?: UserId;
  room_version?: string;
  'm.federate'?: boolean;
  type?: string;
  predecessor?: {
    room_id: RoomId;
    event_id: EventId;
  };
}

export interface RoomMemberContent {
  membership: Membership;
  displayname?: string;
  avatar_url?: string;
  is_direct?: boolean;
  reason?: string;
  join_authorised_via_users_server?: UserId;
  third_party_invite?: {
    display_name: string;
    signed: {
      mxid: UserId;
      token: string;
      signatures: Record<ServerName, Record<string, string>>;
    };
  };
  // Index signature to allow assignment to Record<string, unknown>
  [key: string]: unknown;
}

export interface RoomPowerLevelsContent {
  ban?: number;
  events?: Record<string, number>;
  events_default?: number;
  invite?: number;
  kick?: number;
  notifications?: {
    room?: number;
  };
  redact?: number;
  state_default?: number;
  users?: Record<UserId, number>;
  users_default?: number;
}

export interface RoomNameContent {
  name: string;
}

export interface RoomTopicContent {
  topic: string;
}

export interface RoomAvatarContent {
  url?: string;
  info?: ImageInfo;
}

export interface ImageInfo {
  h?: number;
  w?: number;
  mimetype?: string;
  size?: number;
  thumbnail_url?: string;
  thumbnail_info?: ThumbnailInfo;
}

export interface ThumbnailInfo {
  h?: number;
  w?: number;
  mimetype?: string;
  size?: number;
}

export interface RoomJoinRulesContent {
  join_rule: 'public' | 'knock' | 'invite' | 'private' | 'restricted' | 'knock_restricted';
  allow?: Array<{
    type: string;
    room_id?: RoomId;
    via?: string[];
  }>;
}

export interface RoomHistoryVisibilityContent {
  history_visibility: 'invited' | 'joined' | 'shared' | 'world_readable';
}

export interface RoomGuestAccessContent {
  guest_access: 'can_join' | 'forbidden';
}

export interface RoomCanonicalAliasContent {
  alias?: RoomAlias;
  alt_aliases?: RoomAlias[];
}

// Message event types
export interface RoomMessageContent {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  'm.relates_to'?: RelatesTo;
  'm.new_content'?: RoomMessageContent;
}

export interface RelatesTo {
  rel_type?: string;
  event_id?: EventId;
  key?: string;
  'm.in_reply_to'?: {
    event_id: EventId;
  };
  is_falling_back?: boolean;
}

// Text message
export interface TextMessageContent extends RoomMessageContent {
  msgtype: 'm.text';
}

// Image message
export interface ImageMessageContent extends RoomMessageContent {
  msgtype: 'm.image';
  url?: string;
  file?: EncryptedFile;
  info?: ImageInfo;
}

// File message
export interface FileMessageContent extends RoomMessageContent {
  msgtype: 'm.file';
  url?: string;
  file?: EncryptedFile;
  filename?: string;
  info?: {
    mimetype?: string;
    size?: number;
  };
}

export interface EncryptedFile {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: {
    sha256: string;
  };
  v: string;
}

// Reaction content
export interface ReactionContent {
  'm.relates_to': {
    rel_type: 'm.annotation';
    event_id: EventId;
    key: string;
  };
}

// Redaction content
export interface RedactionContent {
  reason?: string;
}

// Sync response types
export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<RoomId, JoinedRoom>;
    invite?: Record<RoomId, InvitedRoom>;
    leave?: Record<RoomId, LeftRoom>;
    knock?: Record<RoomId, KnockedRoom>;
  };
  presence?: {
    events: PresenceEvent[];
  };
  account_data?: {
    events: AccountDataEvent[];
  };
  to_device?: {
    events: ToDeviceEvent[];
  };
  device_lists?: {
    changed?: UserId[];
    left?: UserId[];
  };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
}

export interface JoinedRoom {
  summary?: RoomSummary;
  state?: {
    events: MatrixEvent[];
  };
  timeline?: {
    events: MatrixEvent[];
    limited?: boolean;
    prev_batch?: string;
    // MSC4222: room state after the timeline window (current state). The
    // spec places this INSIDE the timeline object.
    state_after?: {
      events: MatrixEvent[];
    };
  };
  ephemeral?: {
    events: EphemeralEvent[];
  };
  account_data?: {
    events: AccountDataEvent[];
  };
  unread_notifications?: {
    highlight_count?: number;
    notification_count?: number;
  };
}

export interface InvitedRoom {
  invite_state?: {
    events: StrippedStateEvent[];
  };
}

export interface LeftRoom {
  state?: {
    events: MatrixEvent[];
  };
  timeline?: {
    events: MatrixEvent[];
    limited?: boolean;
    prev_batch?: string;
  };
  account_data?: {
    events: AccountDataEvent[];
  };
}

export interface KnockedRoom {
  knock_state?: {
    events: StrippedStateEvent[];
  };
}

export interface RoomSummary {
  'm.heroes'?: UserId[];
  'm.joined_member_count'?: number;
  'm.invited_member_count'?: number;
}

export interface StrippedStateEvent {
  content: Record<string, unknown>;
  state_key: string;
  type: string;
  sender: UserId;
}

export interface EphemeralEvent {
  type: string;
  content: Record<string, unknown>;
}

export interface AccountDataEvent {
  type: string;
  content: Record<string, unknown>;
}

export interface PresenceEvent {
  type: 'm.presence';
  sender: UserId;
  content: {
    presence: PresenceState;
    last_active_ago?: number;
    status_msg?: string;
    currently_active?: boolean;
  };
}

export interface ToDeviceEvent {
  sender: UserId;
  type: string;
  content: Record<string, unknown>;
}

// User types
export interface User {
  user_id: UserId;
  localpart: string;
  display_name?: string;
  avatar_url?: string;
  is_guest: boolean;
  is_deactivated: boolean;
  admin: boolean;
  created_at: number;
}

export interface Device {
  device_id: DeviceId;
  user_id: UserId;
  display_name?: string;
  last_seen_ts?: number;
  last_seen_ip?: string;
}

// Room types
export interface Room {
  room_id: RoomId;
  room_version: string;
  is_public: boolean;
  creator_id?: UserId;
  created_at: number;
}

// Error types
export interface MatrixError {
  errcode: string;
  error: string;
  retry_after_ms?: number;
  // M_USER_LOCKED responses set this so clients retain session state.
  soft_logout?: boolean;
}

// Common error codes
export const ErrorCodes = {
  M_FORBIDDEN: 'M_FORBIDDEN',
  M_UNKNOWN_TOKEN: 'M_UNKNOWN_TOKEN',
  M_MISSING_TOKEN: 'M_MISSING_TOKEN',
  M_BAD_JSON: 'M_BAD_JSON',
  M_NOT_JSON: 'M_NOT_JSON',
  M_NOT_FOUND: 'M_NOT_FOUND',
  M_LIMIT_EXCEEDED: 'M_LIMIT_EXCEEDED',
  M_UNKNOWN: 'M_UNKNOWN',
  M_UNRECOGNIZED: 'M_UNRECOGNIZED',
  M_UNAUTHORIZED: 'M_UNAUTHORIZED',
  M_USER_DEACTIVATED: 'M_USER_DEACTIVATED',
  M_USER_IN_USE: 'M_USER_IN_USE',
  M_INVALID_USERNAME: 'M_INVALID_USERNAME',
  M_ROOM_IN_USE: 'M_ROOM_IN_USE',
  M_INVALID_ROOM_STATE: 'M_INVALID_ROOM_STATE',
  M_THREEPID_IN_USE: 'M_THREEPID_IN_USE',
  M_THREEPID_NOT_FOUND: 'M_THREEPID_NOT_FOUND',
  M_THREEPID_AUTH_FAILED: 'M_THREEPID_AUTH_FAILED',
  M_THREEPID_DENIED: 'M_THREEPID_DENIED',
  M_SERVER_NOT_TRUSTED: 'M_SERVER_NOT_TRUSTED',
  M_UNSUPPORTED_ROOM_VERSION: 'M_UNSUPPORTED_ROOM_VERSION',
  M_INCOMPATIBLE_ROOM_VERSION: 'M_INCOMPATIBLE_ROOM_VERSION',
  M_BAD_STATE: 'M_BAD_STATE',
  M_GUEST_ACCESS_FORBIDDEN: 'M_GUEST_ACCESS_FORBIDDEN',
  M_CAPTCHA_NEEDED: 'M_CAPTCHA_NEEDED',
  M_CAPTCHA_INVALID: 'M_CAPTCHA_INVALID',
  M_MISSING_PARAM: 'M_MISSING_PARAM',
  M_INVALID_PARAM: 'M_INVALID_PARAM',
  M_TOO_LARGE: 'M_TOO_LARGE',
  M_EXCLUSIVE: 'M_EXCLUSIVE',
  M_RESOURCE_LIMIT_EXCEEDED: 'M_RESOURCE_LIMIT_EXCEEDED',
  M_CANNOT_LEAVE_SERVER_NOTICE_ROOM: 'M_CANNOT_LEAVE_SERVER_NOTICE_ROOM',
  // Optimistic-concurrency conflict on a state event write — the auth basis
  // (power levels / membership) changed between the permission check and the
  // attempted write. Clients should re-fetch state and retry.
  M_CONFLICT: 'M_CONFLICT',
  // MSC4323 (stable since spec v1.18): the recipient blocks all invites.
  M_INVITE_BLOCKED: 'M_INVITE_BLOCKED',
  // Account moderation (spec v1.12/v1.13 error codes; MSC4323 endpoints
  // arrived in v1.18). M_USER_LOCKED carries soft_logout: true on 401s.
  M_USER_LOCKED: 'M_USER_LOCKED',
  M_USER_SUSPENDED: 'M_USER_SUSPENDED',
  // MSC4335 (stable since spec v1.18): account-scoped resource limits
  // (storage quota, room/device counts, feature usage). Emitted when the
  // admin API grows quotas; MUST carry info_uri, MAY carry can_upgrade.
  M_USER_LIMIT_EXCEEDED: 'M_USER_LIMIT_EXCEEDED',
  // MSC4155 (unstable): the recipient's invite permission config blocks the
  // inviter.
  ORG_MATRIX_MSC4155_M_INVITE_BLOCKED: 'ORG.MATRIX.MSC4155.M_INVITE_BLOCKED',
  // MSC4140 (unstable): requested delay exceeds the server's max_delay_ms.
  ORG_MATRIX_MSC4140_DELAY_TOO_LARGE: 'ORG.MATRIX.MSC4140_DELAY_TOO_LARGE',
  // MSC3886: rendezvous payload write with a stale If-Match ETag.
  M_CONCURRENT_WRITE: 'M_CONCURRENT_WRITE',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
