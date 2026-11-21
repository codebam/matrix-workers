import { describe, expect, it } from 'vitest';
import { augmentAuthEvents, buildWireJoinState, type RoomWire } from '../src/services/event-wire';
import type { PDU } from '../src/types/matrix';

// Pure fixtures: no env bindings, no crypto, no network. The wire map models
// what deriveRoomWireEvents produces; only the shape buildWireJoinState reads
// (auth_events refs + idMap for derived IDs) matters here.
function wireEvent(id: string, authEvents: string[] = []): Record<string, unknown> {
  return { event_id: id, type: 'm.room.member', auth_events: authEvents };
}

function wireFrom(
  events: Record<string, unknown>[],
  idMap: Map<string, string> = new Map()
): RoomWire {
  return { idMap, wireById: new Map(events.map((e) => [e.event_id as string, e])) };
}

const SEP = '\u0000';
const slot = (type: string, stateKey = ''): string => `${type}${SEP}${stateKey}`;

function memberEvent(overrides: Partial<PDU> = {}): PDU {
  return {
    event_id: '$join',
    room_id: '!room:example.com',
    sender: '@alice:example.com',
    type: 'm.room.member',
    state_key: '@alice:example.com',
    content: { membership: 'join' },
    origin_server_ts: 1000,
    depth: 2,
    auth_events: [],
    prev_events: [],
    ...overrides,
  } as PDU;
}

describe('buildWireJoinState', () => {
  it('returns the requested state events in order and skips ids absent from the wire', () => {
    const s1 = wireEvent('$s1');
    const s2 = wireEvent('$s2');
    const wire = wireFrom([s1, s2, wireEvent('$other')]);

    const result = buildWireJoinState(wire, ['$s1', '$absent', '$s2']);

    expect(result.state).toEqual([s1, s2]);
    expect(result.authChain).toEqual([]);
  });

  it('walks the auth chain transitively and includes each auth event once', () => {
    const state = wireEvent('$s', ['$a', '$b']);
    const a = wireEvent('$a', ['$c']);
    const b = wireEvent('$b', ['$c', '$d']);
    const c = wireEvent('$c');
    const d = wireEvent('$d');
    const wire = wireFrom([state, a, b, c, d]);

    const { state: servedState, authChain } = buildWireJoinState(wire, ['$s']);

    expect(servedState).toEqual([state]);
    const ids = authChain.map((e) => e.event_id);
    expect(new Set(ids)).toEqual(new Set(['$a', '$b', '$c', '$d']));
    // $c is reachable from both $a and $b but must appear only once.
    expect(ids).toHaveLength(4);
  });

  it('excludes state events and their derived ids from the auth chain', () => {
    const s1 = wireEvent('$s1', ['$s2', '$derived2', '$a']);
    const s2 = wireEvent('$s2');
    const a = wireEvent('$a', ['$derived1']);
    const wire = wireFrom(
      [s1, s2, a],
      new Map([
        ['$s1', '$derived1'],
        ['$s2', '$derived2'],
      ])
    );

    const { state, authChain } = buildWireJoinState(wire, ['$s1', '$s2']);

    expect(state).toEqual([s1, s2]);
    // $s2 is state, $derived2/$derived1 are its derived forms, and neither
    // may leak into the auth chain of the join response.
    expect(authChain.map((e) => e.event_id)).toEqual(['$a']);
  });

  it('skips dangling auth refs and terminates on auth cycles', () => {
    const state = wireEvent('$s', ['$missing', '$x']);
    const x = wireEvent('$x', ['$y']);
    const y = wireEvent('$y', ['$x', '$missing']);
    const wire = wireFrom([state, x, y]);

    const { authChain } = buildWireJoinState(wire, ['$s']);

    const ids = authChain.map((e) => e.event_id);
    expect(new Set(ids)).toEqual(new Set(['$x', '$y']));
    expect(ids).toHaveLength(2);
  });

  it('returns empty state and auth chain for no state ids', () => {
    const wire = wireFrom([wireEvent('$s')]);

    expect(buildWireJoinState(wire, [])).toEqual({ state: [], authChain: [] });
  });
});

describe('augmentAuthEvents', () => {
  it('appends missing expected auth types and the create for legacy rooms', () => {
    const event = memberEvent({ auth_events: ['$pl'] });
    const targets = new Map([
      [slot('m.room.power_levels'), '$pl'],
      [slot('m.room.member', '@alice:example.com'), '$prev-member'],
      [slot('m.room.join_rules'), '$jr'],
    ]);

    augmentAuthEvents(event, targets, false, '$create');

    expect(event.auth_events).toEqual(['$pl', '$prev-member', '$jr', '$create']);
  });

  it('does not duplicate present refs or self-reference the current membership', () => {
    const event = memberEvent({ event_id: '$prev-member', auth_events: ['$jr'] });
    const targets = new Map([
      [slot('m.room.power_levels'), '$pl'],
      [slot('m.room.member', '@alice:example.com'), '$prev-member'],
      [slot('m.room.join_rules'), '$jr'],
    ]);

    augmentAuthEvents(event, targets, false, '$jr');

    expect(event.auth_events).toEqual(['$jr', '$pl']);
  });

  it('omits the create for msc4291 and leaves an already-complete ref list untouched', () => {
    const event = memberEvent({ auth_events: ['$pl', '$prev-member', '$jr'] });
    const targets = new Map([
      [slot('m.room.power_levels'), '$pl'],
      [slot('m.room.member', '@alice:example.com'), '$prev-member'],
      [slot('m.room.join_rules'), '$jr'],
    ]);
    const original = event.auth_events;

    augmentAuthEvents(event, targets, true, '$create');

    expect(event.auth_events).toBe(original);
    expect(event.auth_events).toEqual(['$pl', '$prev-member', '$jr']);
  });

  it('adds join rules, target membership and third-party invite for an invite', () => {
    const event = memberEvent({
      event_id: '$invite',
      sender: '@bob:example.com',
      content: {
        membership: 'invite',
        third_party_invite: { signed: { token: 'tok' } },
      },
    });
    const targets = new Map([
      [slot('m.room.power_levels'), '$pl'],
      [slot('m.room.member', '@bob:example.com'), '$bob-member'],
      [slot('m.room.join_rules'), '$jr'],
      [slot('m.room.member', '@alice:example.com'), '$alice-member'],
      [slot('m.room.third_party_invite', 'tok'), '$tpi'],
    ]);

    augmentAuthEvents(event, targets, true);

    expect(event.auth_events).toEqual([
      '$pl',
      '$bob-member',
      '$jr',
      '$alice-member',
      '$tpi',
    ]);
  });

  it('handles a missing auth_events array and missing content', () => {
    const event = memberEvent({
      auth_events: undefined as unknown as string[],
      content: undefined as unknown as Record<string, unknown>,
    });

    augmentAuthEvents(event, new Map([[slot('m.room.power_levels'), '$pl']]), true);

    expect(event.auth_events).toEqual(['$pl']);
  });
});
