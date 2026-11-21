import { describe, it, expect } from 'vitest';
import { applyMessageEventFilter } from '../src/api/rooms';

/**
 * Pins the pure message-event filter used by GET /rooms/:roomId/messages.
 * Pattern semantics (exact match vs trailing-wildcard prefix) and contains_url
 * are easy to drift, so they are asserted here without any D1 or bindings.
 */
const events = [
  {
    type: 'm.room.message',
    room_id: '!a:example.com',
    sender: '@alice:example.com',
    content: { url: 'https://example.com/x' },
  },
  {
    type: 'm.room.message',
    room_id: '!b:example.com',
    sender: '@bob:example.com',
    content: {},
  },
  {
    type: 'm.reaction',
    room_id: '!a:example.com',
    sender: '@alice:example.com',
    content: { url: '' },
  },
  {
    type: 'm.room.member',
    room_id: '!c:example.com',
    sender: '@carol:example.com',
    content: { url: 'https://example.com/y' },
  },
];

const ids = (list: Array<{ type: string; room_id: string }>) =>
  list.map((event) => `${event.type}@${event.room_id}`);

describe('applyMessageEventFilter — pure room message filtering', () => {
  it('returns every event for an empty filter', () => {
    expect(applyMessageEventFilter(events, {})).toEqual(events);
  });

  it('applies an exact type whitelist and a trailing-wildcard type pattern', () => {
    expect(ids(applyMessageEventFilter(events, { types: ['m.room.message'] }))).toEqual([
      'm.room.message@!a:example.com',
      'm.room.message@!b:example.com',
    ]);
    expect(ids(applyMessageEventFilter(events, { types: ['m.room.*'] }))).toEqual([
      'm.room.message@!a:example.com',
      'm.room.message@!b:example.com',
      'm.room.member@!c:example.com',
    ]);
  });

  it('excludes not_types matches', () => {
    expect(ids(applyMessageEventFilter(events, { not_types: ['m.room.message'] }))).toEqual([
      'm.reaction@!a:example.com',
      'm.room.member@!c:example.com',
    ]);
  });

  it('treats empty pattern arrays as no constraint', () => {
    expect(
      applyMessageEventFilter(events, {
        types: [],
        not_types: [],
        rooms: [],
        senders: [],
      })
    ).toEqual(events);
  });

  it('filters rooms and not_rooms with prefix wildcards', () => {
    expect(ids(applyMessageEventFilter(events, { rooms: ['!a:*'] }))).toEqual([
      'm.room.message@!a:example.com',
      'm.reaction@!a:example.com',
    ]);
    expect(ids(applyMessageEventFilter(events, { not_rooms: ['!a:*'] }))).toEqual([
      'm.room.message@!b:example.com',
      'm.room.member@!c:example.com',
    ]);
  });

  it('filters senders and not_senders exactly', () => {
    expect(ids(applyMessageEventFilter(events, { senders: ['@alice:example.com'] }))).toEqual([
      'm.room.message@!a:example.com',
      'm.reaction@!a:example.com',
    ]);
    expect(ids(applyMessageEventFilter(events, { not_senders: ['@alice:example.com'] }))).toEqual([
      'm.room.message@!b:example.com',
      'm.room.member@!c:example.com',
    ]);
  });

  it('contains_url requires a non-empty string url on the event content', () => {
    expect(ids(applyMessageEventFilter(events, { contains_url: true }))).toEqual([
      'm.room.message@!a:example.com',
      'm.room.member@!c:example.com',
    ]);
    expect(ids(applyMessageEventFilter(events, { contains_url: false }))).toEqual([
      'm.room.message@!b:example.com',
      'm.reaction@!a:example.com',
    ]);
  });

  it('combines whitelist and blacklist constraints (AND semantics)', () => {
    expect(
      ids(
        applyMessageEventFilter(events, {
          types: ['m.room.*'],
          not_types: ['m.room.member'],
          rooms: ['!a:*'],
          not_rooms: ['!b:*'],
          senders: ['@alice:example.com', '@carol:example.com'],
          not_senders: ['@carol:example.com'],
        })
      )
    ).toEqual(['m.room.message@!a:example.com']);
  });

  it('ignores non-string patterns when a valid pattern is present', () => {
    expect(
      ids(applyMessageEventFilter(events, { types: [42 as unknown as string, 'm.reaction'] }))
    ).toEqual(['m.reaction@!a:example.com']);
  });
});
