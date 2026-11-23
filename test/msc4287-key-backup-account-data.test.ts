/**
 * MSC4287 (Matrix v1.19): m.key_backup account data is a plain global
 * account-data type. It must round-trip through PUT/GET and be delivered
 * by both /sync and sliding sync without any E2EE-DO special casing.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'D');
      c.set('auth', { userId: '@alice:example.com', deviceId: 'D', accessToken: 't' });
      await next();
    };
  },
}));

import accountDataApp from '../src/api/account-data';
import syncApp from '../src/api/sync';
import slidingSyncApp from '../src/api/sliding-sync';
import {
  createEnv,
  createSharedDb,
  jsonInit,
  parseResponse,
  USER,
} from './spec-stabilization-harness';

const TYPE = 'm.key_backup';
const ENC_USER = encodeURIComponent(USER);
const GLOBAL_PATH = `/_matrix/client/v3/user/${ENC_USER}/account_data/${TYPE}`;
const POINTER = {
  algorithm: 'm.megolm_backup.v1.aes-hmac-sha2',
  version: '7',
};

function encodePath(path: string, init: RequestInit, env: Env) {
  return accountDataApp.request(`http://localhost${path}`, init, env);
}

describe('MSC4287 m.key_backup account data', () => {
  it('PUT then GET returns the backup pointer unchanged', async () => {
    const env = createEnv({ db: createSharedDb() });
    const put = await parseResponse(await encodePath(GLOBAL_PATH, jsonInit('PUT', POINTER), env));
    expect(put.status).toBe(200);

    const get = await parseResponse(await encodePath(GLOBAL_PATH, {}, env));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(POINTER);
  });

  it('uses the plain D1 path: no USER_KEYS durable-object writes', async () => {
    const env = createEnv({ db: createSharedDb() });
    await encodePath(GLOBAL_PATH, jsonInit('PUT', POINTER), env);
    expect(env._userKeys.deviceKeys).toEqual({});
    expect(env._db.changes).toEqual([
      {
        user_id: USER,
        room_id: '',
        event_type: TYPE,
        stream_position: 1,
      },
    ]);
  });

  it('is delivered in the /sync account_data.events section after the write', async () => {
    const env = createEnv({ db: createSharedDb() });
    const put = await encodePath(GLOBAL_PATH, jsonInit('PUT', POINTER), env);
    expect(put.status).toBe(200);

    const res = await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, env);
    const { status, body } = await parseResponse(res);
    expect(status).toBe(200);
    expect(body.account_data.events).toEqual([{ type: TYPE, content: POINTER }]);
  });

  it.each([
    ['MSC3575', '/_matrix/client/unstable/org.matrix.msc3575/sync'],
    ['MSC4186', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync'],
    ['v4', '/_matrix/client/v4/sync'],
  ])('is delivered in %s sliding-sync extensions.account_data.global', async (_label, path) => {
    const env = createEnv({ db: createSharedDb() });
    const put = await encodePath(GLOBAL_PATH, jsonInit('PUT', POINTER), env);
    expect(put.status).toBe(200);

    const res = await slidingSyncApp.request(
      `http://localhost${path}`,
      jsonInit('POST', { extensions: { account_data: {} } }),
      env
    );
    const { status, body } = await parseResponse(res);
    expect(status).toBe(200);
    expect(body.extensions.account_data.global).toEqual([{ type: TYPE, content: POINTER }]);
  });
});
