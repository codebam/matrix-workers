import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../src/types';
import { Errors } from '../src/utils/errors';

// MSC4380 stabilised the invite-blocked errcode as the flat M_INVITE_BLOCKED.
// The factory that produces it has no direct test in errors.test.ts, so pin
// its exact wire shape here.
describe('Errors.inviteBlocked', () => {
  it('returns a 403 with the stable flat errcode and default message', () => {
    const err = Errors.inviteBlocked();

    expect(err.errcode).toBe(ErrorCodes.M_INVITE_BLOCKED);
    expect(err.status).toBe(403);
    expect(err.toJSON()).toEqual({
      errcode: 'M_INVITE_BLOCKED',
      error: 'The recipient does not accept invites from you'
    });
  });

  it('keeps a caller-supplied message in the serialised error', () => {
    expect(Errors.inviteBlocked('blocked by policy').toJSON()).toEqual({
      errcode: 'M_INVITE_BLOCKED',
      error: 'blocked by policy'
    });
  });
});
