import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMessageEventFilter, buildMsc4291CreateEvent } from '../src/api/rooms';
import { calculateContentHash } from '../src/utils/crypto';
import { computeEventReferenceHash } from '../src/utils/event-signing';

// Pure fixtures: direct calls only, no env bindings, DB or network.
type Filter = Parameters<typeof applyMessageEventFilter>[1];

const events = [
  {
    type: 'm.room.message',
    room_id: '!a:example.com',
    sender: '@alice:example.com',
    content: { url: 'mxc://example.com/one' },
  },
  {
    type: 'm.room.message',
    room_id: '!a:example.com',
    sender: '@bob:example.com',
    content: { body: 'hello' },
  },
  {
    type: 'm.room.member',
    room_id: '!b:example.com',
    sender: '@alice:example.com',
    content: { membership: 'join' },
  },
  {
    type: 'm.reaction',
    room_id: '!b:example.com',
    sender: '@bob:example.com',
    content: { url: '' },
  },
];

describe('applyMessageEventFilter', () => {
  it('keeps everything for an empty filter and ignores unknown keys', () => {
    expect(applyMessageEventFilter(events, {})).toEqual(events);
    expect(applyMessageEventFilter(events, { limit: 1, not_rooms: [] } as Filter)).toEqual(events);
  });

  it('whitelists exact types and trailing-star prefixes; an empty list is unrestricted', () => {
    expect(applyMessageEventFilter(events, { types: ['m.room.*'] })).toEqual([
      events[0],
      events[1],
      events[2],
    ]);
    expect(applyMessageEventFilter(events, { types: ['m.reaction'] })).toEqual([events[3]]);
    expect(applyMessageEventFilter(events, { types: [] })).toEqual(events);
  });

  it('excludes exact and wildcard not_types, including "*"', () => {
    expect(applyMessageEventFilter(events, { not_types: ['m.room.member'] })).toEqual([
      events[0],
      events[1],
      events[3],
    ]);
    expect(applyMessageEventFilter(events, { not_types: ['m.room.*'] })).toEqual([events[3]]);
    expect(applyMessageEventFilter(events, { not_types: ['*'] })).toEqual([]);
  });

  it('filters rooms and not_rooms with trailing-star prefixes', () => {
    expect(applyMessageEventFilter(events, { rooms: ['!a:*'] })).toEqual([events[0], events[1]]);
    expect(applyMessageEventFilter(events, { not_rooms: ['!b:example.com'] })).toEqual([
      events[0],
      events[1],
    ]);
  });

  it('filters senders and not_senders', () => {
    expect(applyMessageEventFilter(events, { senders: ['@alice:example.com'] })).toEqual([
      events[0],
      events[2],
    ]);
    expect(applyMessageEventFilter(events, { not_senders: ['@b*'] })).toEqual([
      events[0],
      events[2],
    ]);
  });

  it('keys contains_url off a non-empty string content.url', () => {
    expect(applyMessageEventFilter(events, { contains_url: true })).toEqual([events[0]]);
    // Empty string and missing content both count as "no URL".
    expect(applyMessageEventFilter(events, { contains_url: false })).toEqual([
      events[1],
      events[2],
      events[3],
    ]);
    const withoutContent = [{ type: 'm.custom', room_id: '!a:example.com', sender: '@alice:example.com' }];
    expect(applyMessageEventFilter(withoutContent, { contains_url: false })).toEqual(withoutContent);
    expect(applyMessageEventFilter(withoutContent, { contains_url: true })).toEqual([]);
  });

  it('intersects whitelist, blacklist and contains_url constraints', () => {
    expect(
      applyMessageEventFilter(events, {
        types: ['m.room.message'],
        not_senders: ['@bob:example.com'],
        contains_url: true,
      })
    ).toEqual([events[0]]);
  });

  it('ignores non-array patterns and non-string entries', () => {
    expect(applyMessageEventFilter(events, { types: 'm.reaction' } as unknown as Filter)).toEqual(events);
    expect(
      applyMessageEventFilter(events, { types: [123, 'm.reaction'] } as unknown as Filter)
    ).toEqual([events[3]]);
    expect(
      applyMessageEventFilter(events, { senders: [null, '@alice:example.com'] } as unknown as Filter)
    ).toEqual([events[0], events[2]]);
  });

  it('returns a new array without mutating the input events', () => {
    const input = [...events];
    const result = applyMessageEventFilter(input, { not_types: ['m.reaction'] });

    expect(result).not.toBe(input);
    expect(result).toEqual([events[0], events[1], events[2]]);
    expect(input).toEqual(events);
  });
});

const NOW = 1_700_000_000_000;
const CREATOR = '@creator:example.com';

describe('buildMsc4291CreateEvent', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an implicit-create PDU with no room_id/event_id and server-owned content', async () => {
    const built = await buildMsc4291CreateEvent('12', CREATOR, undefined, {
      creator: '@spoof:example.com',
      room_version: '11',
      name: 'Test room',
    });

    expect(built.pduBase).toEqual({
      sender: CREATOR,
      type: 'm.room.create',
      state_key: '',
      content: { name: 'Test room', room_version: '12' },
      origin_server_ts: NOW,
      depth: 0,
      auth_events: [],
      prev_events: [],
    });
    expect(built.pduBase).not.toHaveProperty('room_id');
    expect(built.pduBase).not.toHaveProperty('event_id');
    expect(built.hashes.sha256).toBe(await calculateContentHash(built.pduBase));
  });

  it('derives room and event IDs from the create reference hash', async () => {
    const built = await buildMsc4291CreateEvent('12', CREATOR);

    const refHash = await computeEventReferenceHash({ ...built.pduBase, hashes: built.hashes });
    expect(built.roomId).toBe(`!${refHash}`);
    expect(built.eventId).toBe(`$${refHash}`);
    // Synapse resolves the implicit create as "$" + roomId.slice(1).
    expect(built.eventId).toBe(`$${built.roomId.slice(1)}`);
  });

  it('embeds a predecessor when upgrading into an MSC4291 room', async () => {
    const predecessor = { room_id: '!old:example.com', event_id: '$tombstone' };

    const built = await buildMsc4291CreateEvent('12', CREATOR, predecessor);

    expect(built.pduBase.content).toEqual({ room_version: '12', predecessor });
  });

  it('is deterministic for identical inputs and changes IDs when content changes', async () => {
    const a = await buildMsc4291CreateEvent('12', CREATOR);
    const b = await buildMsc4291CreateEvent('12', CREATOR);
    const c = await buildMsc4291CreateEvent('12', CREATOR, undefined, { name: 'Different' });

    expect(b).toEqual(a);
    expect(c.eventId).not.toBe(a.eventId);
    expect(c.roomId).not.toBe(a.roomId);
  });
});
