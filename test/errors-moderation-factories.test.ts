import { describe, expect, it } from 'vitest';
import { Errors, MatrixApiError } from '../src/utils/errors';
import { ErrorCodes } from '../src/types';

function pinsFactory(
  error: MatrixApiError,
  errcode: string,
  status: number,
  message: string,
  extra: Record<string, unknown> = {}
) {
  expect(error).toBeInstanceOf(MatrixApiError);
  expect(error.name).toBe('MatrixApiError');
  expect(error.errcode).toBe(errcode);
  expect(error.status).toBe(status);
  expect(error.message).toBe(message);
  expect(error.toJSON()).toEqual({ errcode, error: message, ...extra });

  const response = error.toResponse();
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toBe('application/json');
}

describe('moderation and MSC error factories', () => {
  it('inviteBlocked uses the stabilized flat M_INVITE_BLOCKED errcode', () => {
    pinsFactory(
      Errors.inviteBlocked(),
      ErrorCodes.M_INVITE_BLOCKED,
      403,
      'The recipient does not accept invites from you'
    );
    pinsFactory(Errors.inviteBlocked('blocked'), ErrorCodes.M_INVITE_BLOCKED, 403, 'blocked');
  });

  it('userLocked keeps the session with soft_logout on the wire', () => {
    const error = Errors.userLocked();
    pinsFactory(error, ErrorCodes.M_USER_LOCKED, 401, 'This account has been locked', {
      soft_logout: true,
    });
    expect(error.softLogout).toBe(true);
    pinsFactory(Errors.userLocked('locked'), ErrorCodes.M_USER_LOCKED, 401, 'locked', {
      soft_logout: true,
    });
  });

  it('userSuspended reports 403 without a soft logout', () => {
    const error = Errors.userSuspended();
    pinsFactory(
      error,
      ErrorCodes.M_USER_SUSPENDED,
      403,
      'You cannot perform this action while suspended.'
    );
    expect(error.softLogout).toBeUndefined();
    expect(error.toJSON()).not.toHaveProperty('soft_logout');
  });

  it('delayTooLarge keeps the unstable MSC4140 errcode', () => {
    pinsFactory(
      Errors.delayTooLarge(),
      ErrorCodes.ORG_MATRIX_MSC4140_DELAY_TOO_LARGE,
      400,
      'The requested delay exceeds the maximum allowed'
    );
    pinsFactory(
      Errors.delayTooLarge('delay too long'),
      ErrorCodes.ORG_MATRIX_MSC4140_DELAY_TOO_LARGE,
      400,
      'delay too long'
    );
  });

  it('concurrentWrite reports a stale rendezvous payload as 412', () => {
    pinsFactory(
      Errors.concurrentWrite(),
      ErrorCodes.M_CONCURRENT_WRITE,
      412,
      'The rendezvous payload was modified concurrently'
    );
    pinsFactory(Errors.concurrentWrite('stale ETag'), ErrorCodes.M_CONCURRENT_WRITE, 412, 'stale ETag');
  });
});
