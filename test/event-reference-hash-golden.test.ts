import { describe, expect, it } from 'vitest';
import { computeEventReferenceHash, computeWireEventId } from '../src/utils/event-signing';

// Golden fixture taken from Synapse's own Rust test suite
// (rust/src/events/mod.rs, test_room_id_for_create_event_format_v4), which
// asserts the derived room ID for this create event in v12 is
// "!BeXKh925K_M46DwsuJFR0EyBpE1P7CFUDGuWW4xw55Y".
const SYNAPSE_GOLDEN = {
  auth_events: [],
  prev_events: [],
  type: 'm.room.create',
  sender: '@erikj:jki.re',
  content: {
    room_version: '12',
    predecessor: { room_id: '!VuNGkDTdbMOOxSmuDa:jki.re' },
  },
  depth: 1,
  state_key: '',
  origin_server_ts: 1775568141481,
  hashes: { sha256: 'qBX+glsKvogXFrvsEN0eh13pO2kpuE6o/b4yREPtOqw' },
  signatures: {
    'jki.re': {
      'ed25519:auto':
        'n/4gHQRagk3r1r24L/7a+oaMMf9cysVfQRYdjpDZcf4ppkVym33rhTW18Vy4zMa1L5nsWLkxsBvbrRRDYUOhBQ',
    },
  },
  unsigned: { age_ts: 1775568141481 },
};

describe('golden: synapse reference hash for a v12 create event', () => {
  it('matches synapse room_id derivation', async () => {
    const ref = await computeEventReferenceHash(SYNAPSE_GOLDEN as Record<string, unknown>);
    const wireId = await computeWireEventId(SYNAPSE_GOLDEN as Record<string, unknown>);
    console.log('our refhash:', ref);
    console.log('our wire id:', wireId);
    console.log('synapse room id expected: !BeXKh925K_M46DwsuJFR0EyBpE1P7CFUDGuWW4xw55Y');
    console.log('=> room id from our refhash:', `!${ref}`);
    expect(`!${ref}`).toBe('!BeXKh925K_M46DwsuJFR0EyBpE1P7CFUDGuWW4xw55Y');
  });
});
