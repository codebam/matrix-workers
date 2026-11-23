/**
 * The top-level `origin` is not cosmetic: room versions 1-10 protect it from
 * redaction ([Room Version 11](https://spec.matrix.org/latest/rooms/v11/) is
 * where it stops being protected), so a spec-compliant verifier signs and
 * derives the reference-hash event ID with it retained. Tuwunel requires
 * `origin` on /send_join PDUs, which is why the join workflow adds it before
 * derivation and asks for the pre-v11 redaction form explicitly.
 *
 * This server's default v3-10 derivation is the modern (origin-less) shape to
 * stay byte-compatible with current Synapse traffic, so the spec form is an
 * explicit opt-in. Room version 11 drops origin from the keep-list entirely.
 */
import { describe, expect, it } from 'vitest';
import { calculateContentHash } from '../src/utils/crypto';
import { computeWireEventId } from '../src/utils/event-signing';

const BASE = {
  room_id: '!room:example.com',
  sender: '@user:codebam.ca',
  type: 'm.room.member',
  state_key: '@user:codebam.ca',
  content: { membership: 'join' },
  origin_server_ts: 1_700_000_000_000,
  depth: 5,
  auth_events: ['$auth:example.com'],
  prev_events: ['$prev:example.com'],
};

const WITH_ORIGIN = { ...BASE, origin: 'codebam.ca' };
const SPEC = { preserveLegacyFields: true } as const;

describe('event origin on the federation wire', () => {
  it('v10: origin changes the content hash', async () => {
    expect(await calculateContentHash(WITH_ORIGIN)).not.toBe(
      await calculateContentHash(BASE)
    );
  });

  it('v10: with the spec redaction form, origin is part of the reference-hash event ID', async () => {
    expect(await computeWireEventId(WITH_ORIGIN, '10', SPEC)).not.toBe(
      await computeWireEventId(BASE, '10', SPEC)
    );
    // The default v10 derivation is origin-insensitive — send_join must opt in
    // explicitly, as RoomJoinWorkflow does.
    expect(await computeWireEventId(WITH_ORIGIN, '10')).toBe(
      await computeWireEventId(BASE, '10')
    );
  });

  it('v11: origin is no longer redaction-protected, so the ID is unchanged', async () => {
    expect(await computeWireEventId(WITH_ORIGIN, '11', SPEC)).toBe(
      await computeWireEventId(BASE, '11', SPEC)
    );
  });
});
