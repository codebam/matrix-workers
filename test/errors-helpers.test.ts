import { describe, it, expect } from 'vitest';
import {
  MatrixApiError,
  Errors,
  withErrorHandler,
  jsonResponse,
  emptyResponse,
} from '../src/utils/errors';
import { ErrorCodes } from '../src/types';

describe('errors helpers — uncovered pure behaviour', () => {
  it('moderation factories pin MatrixApiError status, errcode and message', () => {
    const locked = Errors.userLocked();
    expect(locked).toBeInstanceOf(MatrixApiError);
    expect(locked.status).toBe(401);
    expect(locked.errcode).toBe(ErrorCodes.M_USER_LOCKED);
    expect(locked.message).toBe('This account has been locked');

    const suspended = Errors.userSuspended();
    expect(suspended.status).toBe(403);
    expect(suspended.errcode).toBe(ErrorCodes.M_USER_SUSPENDED);
    expect(suspended.message).toBe('You cannot perform this action while suspended.');
  });

  it('MSC factories pin MatrixApiError status, errcode and message', () => {
    const delay = Errors.delayTooLarge();
    expect(delay.status).toBe(400);
    expect(delay.errcode).toBe(ErrorCodes.ORG_MATRIX_MSC4140_DELAY_TOO_LARGE);
    expect(delay.message).toBe('The requested delay exceeds the maximum allowed');

    const concurrent = Errors.concurrentWrite();
    expect(concurrent.status).toBe(412);
    expect(concurrent.errcode).toBe(ErrorCodes.M_CONCURRENT_WRITE);
    expect(concurrent.message).toBe('The rendezvous payload was modified concurrently');

    const invite = Errors.inviteBlocked();
    expect(invite.status).toBe(403);
    expect(invite.errcode).toBe(ErrorCodes.M_INVITE_BLOCKED);
    expect(invite.message).toBe('The recipient does not accept invites from you');
  });

  it('MatrixApiError retains softLogout on the instance and in its JSON', () => {
    const err = Errors.userLocked('held');
    expect(err.softLogout).toBe(true);
    expect(err.toJSON()).toEqual({
      errcode: ErrorCodes.M_USER_LOCKED,
      error: 'held',
      soft_logout: true,
    });
  });

  it('jsonResponse pins status, JSON content type and body', async () => {
    const res = jsonResponse({ pinned: 'helpers' }, 207);
    expect(res.status).toBe(207);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({ pinned: 'helpers' });
  });

  it('emptyResponse pins status, JSON content type and empty object body', async () => {
    const res = emptyResponse(418);
    expect(res.status).toBe(418);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({});
  });

  it('withErrorHandler returns the handler result on success', async () => {
    const marker = { outcome: 'ok' as const };
    await expect(withErrorHandler(async () => marker)).resolves.toBe(marker);
  });

  it('withErrorHandler turns a thrown MatrixApiError into its JSON response', async () => {
    const res = await withErrorHandler(async () => {
      throw Errors.userSuspended('held');
    });
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({
      errcode: ErrorCodes.M_USER_SUSPENDED,
      error: 'held',
    });
  });
});
