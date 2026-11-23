// Third-party invite (3PID invite) verification, shared by the federation
// exchange endpoint and the `3pid/onbind` notification from an identity
// server.
//
// The signed blob issued by the identity server contains `mxid`, `token` and
// `signatures`; the room's `m.room.third_party_invite` state event (keyed by
// the token) carries the identity server's public key(s). Verification is
// deterministic: the signed object is `{mxid, sender, token, signatures}` and
// must verify under one of the keys stored in that state event — no network
// call is needed, which is what makes event acceptance deterministic.

import { verifySignature } from '../utils/crypto';

export interface SignedThirdPartyInvite {
  mxid: string;
  token: string;
  signatures: Record<string, Record<string, string>>;
}

export interface ThirdPartyInviteStateContent {
  display_name?: string;
  key_validity_url?: string;
  public_key?: string;
  public_keys?: Array<{ public_key: string; key_validity_url?: string }>;
}

export interface ThirdPartyInviteState {
  event_id: string;
  sender: string;
  content: ThirdPartyInviteStateContent;
}

/** Load the `m.room.third_party_invite` state event for `token` in `roomId`. */
export async function loadThirdPartyInviteState(
  db: D1Database,
  roomId: string,
  token: string
): Promise<ThirdPartyInviteState | null> {
  const row = await db.prepare(`
    SELECT e.event_id, e.content, e.sender
    FROM room_state rs
    JOIN events e ON rs.event_id = e.event_id
    WHERE rs.room_id = ? AND rs.event_type = 'm.room.third_party_invite' AND rs.state_key = ?
  `).bind(roomId, token).first<{ event_id: string; content: string; sender: string }>();

  if (!row) return null;

  let content: ThirdPartyInviteStateContent;
  try {
    content = JSON.parse(row.content) as ThirdPartyInviteStateContent;
  } catch {
    return null;
  }

  return { event_id: row.event_id, sender: row.sender, content };
}

/**
 * Verify a signed third-party invite against the room state that issued it.
 *
 * `signed` comes from the inbound invite (identity server signature), `sender`
 * is the user who issued the original 3PID invite, and `token` identifies the
 * `m.room.third_party_invite` state event.
 */
export async function verifySignedThirdPartyInvite(
  db: D1Database,
  args: {
    roomId: string;
    sender: string;
    signed: SignedThirdPartyInvite;
  }
): Promise<
  | { ok: true; displayName?: string; stateEventId: string }
  | { ok: false; reason: string }
> {
  const { roomId, sender, signed } = args;
  const { mxid, token, signatures } = signed;
  if (!mxid || !token || !signatures || typeof signatures !== 'object') {
    return { ok: false, reason: 'Incomplete signed third-party invite' };
  }

  const state = await loadThirdPartyInviteState(db, roomId, token);
  if (!state) {
    return { ok: false, reason: 'No third-party invite found with matching token' };
  }

  // The signature covers the inviter's identity, not the invitee's: the
  // signed object is the one the identity server issued when the 3PID was
  // tested, and the inviter's server name is part of it.
  const signedForVerification: Record<string, unknown> = {
    mxid,
    sender,
    token,
    signatures,
  };

  const publicKeys = [...(state.content.public_keys ?? [])];
  if (state.content.public_key) {
    publicKeys.push({ public_key: state.content.public_key });
  }
  if (publicKeys.length === 0) {
    return { ok: false, reason: 'Third-party invite has no public key' };
  }

  for (const keyInfo of publicKeys) {
    const publicKey = keyInfo.public_key;
    if (!publicKey) continue;

    for (const [signingServer, keySignatures] of Object.entries(signatures)) {
      for (const [keyId, signature] of Object.entries(keySignatures ?? {})) {
        if (!signature) continue;
        try {
          if (
            await verifySignature(
              signedForVerification,
              signingServer,
              keyId,
              publicKey
            )
          ) {
            return {
              ok: true,
              displayName: state.content.display_name,
              stateEventId: state.event_id,
            };
          }
        } catch {
          // Try the next key/signature; a malformed signature is not fatal.
        }
      }
    }
  }

  return { ok: false, reason: 'Could not verify third-party invite signature' };
}
