// Pure decision edges of evaluateRestrictedJoin: every case below resolves
// from the caller-supplied room state and stubbed membership lookups alone —
// no bindings and no federation calls are involved.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDU, RoomJoinRulesContent } from '../src/types';

const getMembershipMock = vi.hoisted(() => vi.fn());
const getRoomStateMock = vi.hoisted(() => vi.fn(async () => [] as PDU[]));
const federationGetMock = vi.hoisted(() => vi.fn());

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: getMembershipMock,
    getRoomState: getRoomStateMock,
  };
});

vi.mock('../src/services/federation-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/federation-keys')>();
  return { ...actual, federationGet: federationGetMock };
});

import { evaluateRestrictedJoin } from '../src/services/restricted-joins';

type Params = Parameters<typeof evaluateRestrictedJoin>[0];

const LOCAL = 'example.org';
const ROOM = '!target:example.org';
const ALLOWED_ROOM = '!allowed:example.org';
const JOINER = '@joiner:remote.example';

const NOT_A_MEMBER = 'You are not a member of any room allowed by this room’s join rule';
const NO_AUTHORISER = 'No local member can authorise this restricted join';

function pdu(overrides: Partial<PDU> & Pick<PDU, 'type' | 'content'>): PDU {
  return {
    event_id: '$event:example.org',
    room_id: ROOM,
    sender: '@creator:example.org',
    origin_server_ts: 0,
    auth_events: [],
    prev_events: [],
    depth: 0,
    ...overrides,
  };
}

function joinRules(
  join_rule: RoomJoinRulesContent['join_rule'],
  allow: RoomJoinRulesContent['allow'] = []
): PDU {
  return pdu({ type: 'm.room.join_rules', content: { join_rule, allow } });
}

function powerLevels(invite: number, users: Record<string, number> = {}): PDU {
  return pdu({ type: 'm.room.power_levels', content: { invite, users } });
}

function member(userId: string, membership = 'join', eventId = `$member-${userId}:example.org`): PDU {
  return pdu({
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    event_id: eventId,
    content: { membership },
  });
}

function allowEntry(roomId: string | undefined, via: string[] = []) {
  return { type: 'm.room.join_rules', room_id: roomId, via } as RoomJoinRulesContent['allow'][number];
}

function makeParams(overrides: Partial<Params> = {}): Params {
  return {
    db: {} as D1Database,
    cache: {} as KVNamespace,
    localServerName: LOCAL,
    roomId: ROOM,
    userId: JOINER,
    roomState: [],
    roomVersion: '10',
    ...overrides,
  };
}

beforeEach(() => {
  getMembershipMock.mockReset();
  getRoomStateMock.mockReset();
  getRoomStateMock.mockResolvedValue([]);
  federationGetMock.mockReset();
});

describe('evaluateRestrictedJoin — early decision edges (no network)', () => {
  it('rejects an unsupported room version before reading state', async () => {
    const decision = await evaluateRestrictedJoin(
      makeParams({ roomVersion: '6', roomState: [joinRules('restricted')] })
    );

    expect(decision).toEqual({ error: 'Restricted joins are not supported in this room version' });
    expect(getMembershipMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('rejects a non-restricted rule and a missing join_rules event', async () => {
    const explicit = await evaluateRestrictedJoin(makeParams({ roomState: [joinRules('invite')] }));
    const missing = await evaluateRestrictedJoin(makeParams({ roomState: [] }));

    expect(explicit).toEqual({ error: 'This room does not use a restricted join rule' });
    expect(missing).toEqual({ error: 'This room does not use a restricted join rule' });
    expect(getMembershipMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('rejects knock_restricted on a version that does not support it', async () => {
    const decision = await evaluateRestrictedJoin(
      makeParams({ roomVersion: '8', roomState: [joinRules('knock_restricted')] })
    );

    expect(decision).toEqual({ error: 'knock_restricted requires room version 10 or later' });
    expect(getMembershipMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('allows knock_restricted past the version gate on v10', async () => {
    const decision = await evaluateRestrictedJoin(
      makeParams({ roomState: [joinRules('knock_restricted')] })
    );

    expect(decision).toEqual({ error: NOT_A_MEMBER });
  });
});

describe('evaluateRestrictedJoin — no membership edges (no network)', () => {
  it('returns the not-a-member decision for an empty allow list without any lookup', async () => {
    getMembershipMock.mockResolvedValue({ membership: 'join', eventId: '$m:example.org' });

    const decision = await evaluateRestrictedJoin(
      makeParams({ roomState: [joinRules('restricted')] })
    );

    expect(decision).toEqual({ error: NOT_A_MEMBER });
    expect(getMembershipMock).not.toHaveBeenCalled();
    expect(getRoomStateMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('ignores malformed allow entries', async () => {
    const malformed = [
      undefined,
      null,
      { type: 'm.room.join_rules' },
      allowEntry(''),
      allowEntry(42 as unknown as string),
    ] as RoomJoinRulesContent['allow'];

    const decision = await evaluateRestrictedJoin(
      makeParams({ roomState: [joinRules('restricted', malformed)] })
    );

    expect(decision).toEqual({ error: NOT_A_MEMBER });
    expect(getMembershipMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('stays not-a-member when the allowed room has no local membership and no via servers', async () => {
    getMembershipMock.mockResolvedValue(null);

    const decision = await evaluateRestrictedJoin(
      makeParams({ roomState: [joinRules('restricted', [allowEntry(ALLOWED_ROOM)])] })
    );

    expect(decision).toEqual({ error: NOT_A_MEMBER });
    expect(getMembershipMock).toHaveBeenCalledWith(expect.anything(), ALLOWED_ROOM, JOINER);
    expect(federationGetMock).not.toHaveBeenCalled();
  });
});

describe('evaluateRestrictedJoin — insufficient authorising state', () => {
  beforeEach(() => {
    // The joiner is in the allowed room, so evaluation reaches the local
    // authoriser scan; everything after that comes from room state alone.
    getMembershipMock.mockResolvedValue({ membership: 'join', eventId: '$allowed:example.org' });
  });

  function withAllowedRoom(...state: PDU[]) {
    return makeParams({
      roomState: [joinRules('restricted', [allowEntry(ALLOWED_ROOM)]), ...state],
    });
  }

  it('rejects when room state has no member events at all', async () => {
    const decision = await evaluateRestrictedJoin(withAllowedRoom(powerLevels(50)));

    expect(decision).toEqual({ error: NO_AUTHORISER });
    expect(getRoomStateMock).not.toHaveBeenCalled();
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('does not accept a remote member with sufficient power', async () => {
    const decision = await evaluateRestrictedJoin(
      withAllowedRoom(
        powerLevels(50, { '@admin:remote.example': 100 }),
        member('@admin:remote.example')
      )
    );

    expect(decision).toEqual({ error: NO_AUTHORISER });
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('does not accept a local member whose power is below invite', async () => {
    const decision = await evaluateRestrictedJoin(
      withAllowedRoom(
        powerLevels(50, { '@low:example.org': 10 }),
        member('@low:example.org')
      )
    );

    expect(decision).toEqual({ error: NO_AUTHORISER });
    expect(federationGetMock).not.toHaveBeenCalled();
  });

  it('does not accept a local member who is not joined', async () => {
    const decision = await evaluateRestrictedJoin(
      withAllowedRoom(
        powerLevels(50, { '@left:example.org': 100 }),
        member('@left:example.org', 'leave')
      )
    );

    expect(decision).toEqual({ error: NO_AUTHORISER });
  });

  it('skips underpowered locals and returns the first qualifying local member', async () => {
    const decision = await evaluateRestrictedJoin(
      withAllowedRoom(
        powerLevels(50, { '@low:example.org': 10, '@mod:example.org': 50 }),
        member('@low:example.org'),
        member('@mod:example.org', 'join', '$mod:example.org')
      )
    );

    expect(decision).toEqual({ authorizedBy: '@mod:example.org', authEventId: '$mod:example.org' });
    expect(federationGetMock).not.toHaveBeenCalled();
  });
});
