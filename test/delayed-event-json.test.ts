/**
 * Shape pin for delayedEventJson: the MSC4140 GET response is built from the
 * D1 row here, so every field name and the conditional blocks matter.
 */
import { describe, it, expect } from 'vitest';
import type { DelayedEventRow } from '../src/services/delayed-events';
import { delayedEventJson } from '../src/services/delayed-events';

function makeRow(overrides: Partial<DelayedEventRow> = {}): DelayedEventRow {
  return {
    delay_id: 'de_abc123',
    user_id: '@alice:example.com',
    room_id: '!room:example.com',
    event_type: 'm.room.message',
    state_key: null,
    content: JSON.stringify({ msgtype: 'm.text', body: 'later' }),
    delay_ms: 60_000,
    delayed_since_ts: 1_700_000_000_000,
    due_ts: 1_700_000_060_000,
    txn_id: 'txn1',
    finalised_ts: null,
    final_event_id: null,
    final_error: null,
    ...overrides,
  };
}

describe('delayedEventJson', () => {
  it('maps a pending event to the documented flat response fields', () => {
    const json = delayedEventJson(makeRow());

    expect(json).toEqual({
      delay_id: 'de_abc123',
      room_id: '!room:example.com',
      type: 'm.room.message',
      delay_ms: 60_000,
      delayed_since_ts: 1_700_000_000_000,
      content: { msgtype: 'm.text', body: 'later' },
    });
    // Internal-only row fields are never exposed.
    expect(json).not.toHaveProperty('user_id');
    expect(json).not.toHaveProperty('due_ts');
    expect(json).not.toHaveProperty('state_key');
    expect(json).not.toHaveProperty('finalised');
  });

  it('includes state_key for a state event', () => {
    const json = delayedEventJson(makeRow({
      event_type: 'm.room.topic',
      state_key: '',
      content: JSON.stringify({ topic: 'later' }),
    }));

    expect(json).toMatchObject({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'later' },
    });
  });

  it('reports a successful finalisation with its event id', () => {
    const json = delayedEventJson(makeRow({
      finalised_ts: 1_700_000_030_000,
      final_event_id: '$sent:example.com',
    }));

    expect(json.finalised).toEqual({
      finalised_ts: 1_700_000_030_000,
      event_id: '$sent:example.com',
    });
  });

  it('reports a failed finalisation with the parsed error and omits absent fields', () => {
    const error = { errcode: 'M_FORBIDDEN', error: 'nope' };
    const json = delayedEventJson(makeRow({
      finalised_ts: 1_700_000_040_000,
      final_error: JSON.stringify(error),
    }));

    expect(json.finalised).toEqual({
      finalised_ts: 1_700_000_040_000,
      error,
    });

    const bare = delayedEventJson(makeRow({ finalised_ts: 1_700_000_040_000 }));
    expect(bare.finalised).toEqual({ finalised_ts: 1_700_000_040_000 });
  });
});
