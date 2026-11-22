import { describe, expect, it } from 'vitest';
import { checkEventAuth } from '../src/services/event-auth';
import {
  computeRedactedContent,
  getRoomVersion,
  getSupportedRoomVersions,
} from '../src/services/room-versions';
import type { PDU } from '../src/types';
import { MSC4583_ROOM_VERSION } from '../src/api/msc4583';

function pdu(partial: Partial<PDU> & Pick<PDU, 'type' | 'sender' | 'event_id'>): PDU {
  return {
    room_id: '!room:example.com',
    content: {},
    origin_server_ts: 1,
    auth_events: [],
    prev_events: [],
    depth: 1,
    ...partial,
  };
}

function state(plContent: Record<string, unknown>): PDU[] {
  return [
    pdu({
      type: 'm.room.create',
      event_id: '$create',
      sender: '@alice:example.com',
      state_key: '',
      depth: 0,
      content: { creator: '@alice:example.com', room_version: MSC4583_ROOM_VERSION },
    }),
    pdu({
      type: 'm.room.member',
      event_id: '$join-bob',
      sender: '@bob:example.com',
      state_key: '@bob:example.com',
      content: { membership: 'join' },
    }),
    pdu({
      type: 'm.room.power_levels',
      event_id: '$pl',
      sender: '@alice:example.com',
      state_key: '',
      content: plContent,
    }),
  ];
}

const PL_CONTENT = {
  users: { '@alice:example.com': 100, '@bob:example.com': 0 },
  users_default: 0,
  events_default: 1,
  state_default: 50,
  state_minimum: 50,
  events: { 'm.room.message': 0 },
  invite: 0,
  kick: 50,
  ban: 50,
  redact: 50,
};

describe('MSC4583 room version wiring', () => {
  it('registers the unstable room version with v12 behaviour', () => {
    expect(getRoomVersion(MSC4583_ROOM_VERSION)).toMatchObject({
      version: MSC4583_ROOM_VERSION,
      eventIdFormat: 'v4',
      redactionAlgorithm: 'v11',
      stable: false,
    });
    expect(getSupportedRoomVersions()[MSC4583_ROOM_VERSION]).toBe('unstable');
  });

  it('floors state event power to state_minimum in the MSC room version only', () => {
    const stateEvent = pdu({
      type: 'm.room.message',
      event_id: '$state-msg',
      sender: '@bob:example.com',
      state_key: 'probe',
      content: { body: 'hello', msgtype: 'm.text' },
    });
    const message = pdu({
      type: 'm.room.message',
      event_id: '$msg',
      sender: '@bob:example.com',
      content: { body: 'hello', msgtype: 'm.text' },
    });

    expect(checkEventAuth(stateEvent, state(PL_CONTENT), MSC4583_ROOM_VERSION).allowed).toBe(false);
    expect(checkEventAuth(message, state(PL_CONTENT), MSC4583_ROOM_VERSION).allowed).toBe(true);
    // The same event is legal in v12, which has no state_minimum floor.
    expect(checkEventAuth(stateEvent, state(PL_CONTENT), '12').allowed).toBe(true);
  });

  it('honours a lower state_minimum and rejects escalation of it', () => {
    const lowerPl = { ...PL_CONTENT, state_minimum: 0 };
    const stateEvent = pdu({
      type: 'm.room.message',
      event_id: '$state-msg',
      sender: '@bob:example.com',
      state_key: 'probe',
      content: {},
    });
    expect(checkEventAuth(stateEvent, state(lowerPl), MSC4583_ROOM_VERSION).allowed).toBe(true);

    const escalation = pdu({
      type: 'm.room.power_levels',
      event_id: '$pl-up',
      sender: '@alice:example.com',
      state_key: '',
      content: { ...PL_CONTENT, state_minimum: 200 },
    });
    expect(checkEventAuth(escalation, state(PL_CONTENT), MSC4583_ROOM_VERSION).allowed).toBe(false);
  });

  it('preserves state_minimum through redaction in the MSC room version', () => {
    expect(computeRedactedContent('m.room.power_levels', PL_CONTENT, MSC4583_ROOM_VERSION)).toEqual({
      events: { 'm.room.message': 0 },
      events_default: 1,
      state_default: 50,
      state_minimum: 50,
      users: { '@alice:example.com': 100, '@bob:example.com': 0 },
      users_default: 0,
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
    });
  });
});
