/**
 * Direct coverage for the pure wire-assembly helper in event-wire.ts.
 * A RoomWire is just two maps, so no Env / D1 bindings or signing keys are
 * needed here — the existing federation tests cover the async derivation.
 */
import { describe, expect, it } from 'vitest';
import { buildWireJoinState, type RoomWire } from '../src/services/event-wire';

function event(id: string, authEvents: string[] = []): Record<string, unknown> {
  return { event_id: id, type: 'm.room.member', auth_events: authEvents, content: {} };
}

function makeWire(
  entries: Array<[string, string[]]>,
  idMap: Array<[string, string]> = []
): RoomWire {
  const wireById = new Map<string, Record<string, unknown>>();
  for (const [id, auth] of entries) wireById.set(id, event(id, auth));
  return { idMap: new Map(idMap), wireById };
}

function ids(events: Array<Record<string, unknown>>): string[] {
  return events.map((e) => String(e.event_id)).sort();
}

describe('buildWireJoinState', () => {
  it('returns the requested state events and an empty chain when nothing is referenced', () => {
    const wire = makeWire([['s1', []], ['s2', []]]);

    const result = buildWireJoinState(wire, ['s1', 's2']);

    expect(ids(result.state)).toEqual(['s1', 's2']);
    expect(result.authChain).toEqual([]);
  });

  it('walks the auth chain transitively, deduplicating shared ancestors', () => {
    const wire = makeWire([
      ['s', ['a', 'b']],
      ['a', ['root']],
      ['b', ['root']],
      ['root', []],
    ]);

    const result = buildWireJoinState(wire, ['s']);

    expect(ids(result.state)).toEqual(['s']);
    expect(ids(result.authChain)).toEqual(['a', 'b', 'root']);
  });

  it('omits state events (raw and derived ids) and refs absent from the wire map', () => {
    const stored = event('s', ['s', 'other', 'unknown']);
    const wire: RoomWire = {
      idMap: new Map([['stored-s', 's']]),
      wireById: new Map([
        ['s', stored],
        ['stored-s', stored],
        ['other', event('other', ['s'])],
      ]),
    };

    const result = buildWireJoinState(wire, ['stored-s']);

    expect(result.state).toEqual([stored]);
    expect(ids(result.authChain)).toEqual(['other']);
  });

  it('terminates on cyclic auth references', () => {
    const wire = makeWire([
      ['s', ['a']],
      ['a', ['b']],
      ['b', ['a']],
    ]);

    const result = buildWireJoinState(wire, ['s']);

    expect(ids(result.authChain)).toEqual(['a', 'b']);
  });

  it('returns empty collections for state ids missing from the wire map', () => {
    const result = buildWireJoinState(makeWire([['s', []]]), ['missing']);

    expect(result).toEqual({ state: [], authChain: [] });
  });
});
