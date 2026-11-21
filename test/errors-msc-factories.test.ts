import { describe, expect, it } from 'vitest';
import { Errors, MatrixApiError } from '../src/utils/errors';
import { ErrorCodes } from '../src/types';

// errors.test.ts pins the original factory set. These five helpers arrived
// later (MSC4140/4323/4380 and the rendezvous optimistic-concurrency path)
// and are pure: no env, no I/O, just a status/errcode/message contract.
describe('errors — MSC / concurrency factory helpers', () => {
  it('inviteBlocked is a 403 with the stabilized flat M_INVITE_BLOCKED errcode', () => {
    const err = Errors.inviteBlocked();
    expect(err).toBeInstanceOf(MatrixApiError);
    expect(err.status).toBe(403);
    expect(err.errcode).toBe(ErrorCodes.M_INVITE_BLOCKED);
    expect(err.message).toBe('The recipient does not accept invites from you');
    expect(err.toJSON()).toEqual({
      errcode: 'M_INVITE_BLOCKED',
      error: 'The recipient does not accept invites from you',
    });
  });

  it('inviteBlocked keeps a custom message', () => {
    expect(Errors.inviteBlocked('blocked by policy').message).toBe('blocked by policy');
  });

  it('userLocked is a 401 carrying soft_logout in the object and the body', async () => {
    const err = Errors.userLocked();
    expect(err.status).toBe(401);
    expect(err.errcode).toBe(ErrorCodes.M_USER_LOCKED);
    expect(err.softLogout).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.toJSON()).toEqual({
      errcode: 'M_USER_LOCKED',
      error: 'This account has been locked',
      soft_logout: true,
    });
    const res = err.toResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual(err.toJSON());
  });

  it('userLocked keeps a custom message', () => {
    expect(Errors.userLocked('locked by admin').message).toBe('locked by admin');
  });

  it('userSuspended is a 403 M_USER_SUSPENDED without soft_logout', () => {
    const err = Errors.userSuspended();
    expect(err.status).toBe(403);
    expect(err.errcode).toBe(ErrorCodes.M_USER_SUSPENDED);
    expect(err.softLogout).toBeUndefined();
    expect(err.message).toBe('You cannot perform this action while suspended.');
    expect(err.toJSON()).toEqual({
      errcode: 'M_USER_SUSPENDED',
      error: 'You cannot perform this action while suspended.',
    });
  });

  it('userSuspended keeps a custom message', () => {
    expect(Errors.userSuspended('read-only').message).toBe('read-only');
  });

  it('delayTooLarge is a 400 ORG.MATRIX.MSC4140_DELAY_TOO_LARGE', () => {
    const err = Errors.delayTooLarge();
    expect(err.status).toBe(400);
    expect(err.errcode).toBe(ErrorCodes.ORG_MATRIX_MSC4140_DELAY_TOO_LARGE);
    expect(err.message).toBe('The requested delay exceeds the maximum allowed');
    expect(err.toJSON()).toEqual({
      errcode: 'ORG.MATRIX.MSC4140_DELAY_TOO_LARGE',
      error: 'The requested delay exceeds the maximum allowed',
    });
  });

  it('delayTooLarge keeps a custom message', () => {
    expect(Errors.delayTooLarge('delay above max_delay_ms').message).toBe('delay above max_delay_ms');
  });

  it('concurrentWrite is a 412 M_CONCURRENT_WRITE', async () => {
    const err = Errors.concurrentWrite();
    expect(err.status).toBe(412);
    expect(err.errcode).toBe(ErrorCodes.M_CONCURRENT_WRITE);
    expect(err.message).toBe('The rendezvous payload was modified concurrently');
    const res = err.toResponse();
    expect(res.status).toBe(412);
    await expect(res.json()).resolves.toEqual({
      errcode: 'M_CONCURRENT_WRITE',
      error: 'The rendezvous payload was modified concurrently',
    });
  });

  it('concurrentWrite keeps a custom message', () => {
    expect(Errors.concurrentWrite('stale ETag').message).toBe('stale ETag');
  });
});
