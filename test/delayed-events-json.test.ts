import { describe, it, expect } from 'vitest';
import { delayedEventJson } from '../src/services/delayed-events';
import type { DelayedEventRow } from '../src/services/delayed-events';

function makeRow(overrides: Partial<DelayedEventRow> = {}): DelayedEventRow {
  return {
    delay_id: 'de_abc',
    user_id: '@alice:example.com',
    room_id: '!room:example.com',
    event_type: 'm.room.message',
    state_key: null,
    content: JSON.stringify({ msgtype: 'm.text', body: 'hello' }),
    delay_ms: 5000,
    delayed_since_ts: 1_700_000_000_000,
    due_ts: 1_700_000_005_000,
    txn_id: 'txn-1',
    finalised_ts: null,
    final_event_id: null,
    final_error: null,
    ...overrides,
  };
}

describe('delayedEventJson', () => {
  it('returns only the client-facing fields for a pending event', () => {
    expect(delayedEventJson(makeRow())).toEqual({
      delay_id: 'de_abc',
      room_id: '!room:example.com',
      type: 'm.room.message',
      delay_ms: 5000,
      delayed_since_ts: 1_700_000_000_000,
      content: { msgtype: 'm.text', body: 'hello' },
    });
  });

  it('omits state_key for a non-state event', () => {
    expect('state_key' in delayedEventJson(makeRow())).toBe(false);
  });

  it('includes state_key for a state event, including the empty string', () => {
    expect(delayedEventJson(makeRow({ state_key: '' })).state_key).toBe('');
    expect(delayedEventJson(makeRow({ state_key: 'm.room.topic' })).state_key).toBe(
      'm.room.topic'
    );
  });

  it('does not leak internal columns such as user_id, due_ts or txn_id', () => {
    const body = delayedEventJson(makeRow());
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('due_ts');
    expect(body).not.toHaveProperty('txn_id');
    expect(body).not.toHaveProperty('finalised');
  });

  it('adds a finalised object with just the timestamp when finalised with no outcome', () => {
    const body = delayedEventJson(makeRow({ finalised_ts: 1_700_000_003_000 }));
    expect(body.finalised).toEqual({ finalised_ts: 1_700_000_003_000 });
  });

  it('adds the final event_id when the event was sent', () => {
    const body = delayedEventJson(
      makeRow({
        finalised_ts: 1_700_000_003_000,
        final_event_id: '$evt:example.com',
      })
    );
    expect(body.finalised).toEqual({
      finalised_ts: 1_700_000_003_000,
      event_id: '$evt:example.com',
    });
  });

  it('parses final_error JSON into the finalised error field', () => {
    const error = { errcode: 'M_FORBIDDEN', error: 'nope' };
    const body = delayedEventJson(
      makeRow({
        finalised_ts: 1_700_000_003_000,
        final_error: JSON.stringify(error),
      })
    );
    expect(body.finalised).toEqual({
      finalised_ts: 1_700_000_003_000,
      error,
    });
  });

  it('includes state_key and a fully populated finalised object together', () => {
    const error = { errcode: 'M_UNKNOWN', error: 'boom' };
    const body = delayedEventJson(
      makeRow({
        state_key: 'm.room.name',
        finalised_ts: 9,
        final_event_id: '$e:example.com',
        final_error: JSON.stringify(error),
      })
    );
    expect(body).toEqual({
      delay_id: 'de_abc',
      room_id: '!room:example.com',
      type: 'm.room.message',
      state_key: 'm.room.name',
      delay_ms: 5000,
      delayed_since_ts: 1_700_000_000_000,
      content: { msgtype: 'm.text', body: 'hello' },
      finalised: {
        finalised_ts: 9,
        event_id: '$e:example.com',
        error,
      },
    });
  });

  it('parses content JSON rather than returning the raw string', () => {
    expect(delayedEventJson(makeRow({ content: '[1,2,3]' })).content).toEqual([1, 2, 3]);
    expect(delayedEventJson(makeRow({ content: 'null' })).content).toBeNull();
  });
});
