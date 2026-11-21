/**
 * Direct coverage for the pure signal-frame decoder in livekit-calls-shim.ts.
 * No WebSocket, Calls REST or Worker bindings are involved: the decoder only
 * turns protobuf-JSON text or a raw protobuf frame into a tagged request.
 */
import { describe, expect, it } from 'vitest';
import { decodeSignalRequest } from '../src/services/livekit-calls-shim';

describe('decodeSignalRequest', () => {
  it('passes protobuf-JSON offer and answer payloads through', () => {
    const offer = { type: 'offer', sdp: 'v=0', id: 7 };

    expect(decodeSignalRequest(JSON.stringify({ offer }))).toEqual({
      message: 'offer',
      value: offer,
    });
    expect(decodeSignalRequest(JSON.stringify({ answer: { ...offer, type: 'answer' } }))).toEqual({
      message: 'answer',
      value: { ...offer, type: 'answer' },
    });
  });

  it('normalizes subscription track SIDs to strings and subscribe to a boolean', () => {
    expect(
      decodeSignalRequest(
        JSON.stringify({ subscription: { trackSids: [1, 'two'], subscribe: true } })
      )
    ).toEqual({ message: 'subscription', value: { trackSids: ['1', 'two'], subscribe: true } });

    expect(
      decodeSignalRequest(
        JSON.stringify({ subscription: { trackSids: 'not-an-array', subscribe: 1 } })
      )
    ).toEqual({ message: 'subscription', value: { trackSids: [], subscribe: false } });
  });

  it('coerces a JSON ping to a number', () => {
    expect(decodeSignalRequest('{"ping":"42"}')).toEqual({ message: 'ping', value: 42 });
  });

  it('decodes a binary ping varint from both Uint8Array and ArrayBuffer', () => {
    // field 14, wire type 0 (0x70), value 42
    const frame = new Uint8Array([0x70, 0x2a]);

    expect(decodeSignalRequest(frame)).toEqual({ message: 'ping', value: 42 });
    expect(decodeSignalRequest(frame.buffer)).toEqual({ message: 'ping', value: 42 });
  });

  it('returns unknown for malformed, unrecognized or non-byte input', () => {
    expect(decodeSignalRequest('not json')).toEqual({ message: 'unknown' });
    expect(decodeSignalRequest('{}')).toEqual({ message: 'unknown' });
    expect(decodeSignalRequest(null)).toEqual({ message: 'unknown' });
    expect(decodeSignalRequest(123)).toEqual({ message: 'unknown' });
  });
});
