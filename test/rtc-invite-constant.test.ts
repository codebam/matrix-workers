import { describe, expect, it } from 'vitest';
import { RTC_INVITE_STATE_FIELD } from '../src/api/to-device';

// to-device.ts exports a single pure constant: the local bookkeeping field
// name used inside MSC4075 RTC invite message content. (Everything else it
// exports is a function, interface or the default Hono app.)
describe('RTC invite state constants (to-device)', () => {
  it('pins the MSC4075 invite state field name', () => {
    expect(RTC_INVITE_STATE_FIELD).toBe('msc4075_state');
  });
});
