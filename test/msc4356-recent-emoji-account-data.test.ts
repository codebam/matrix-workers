/**
 * MSC4356 (Matrix v1.18): m.recent_emoji is plain global account data.
 * It stores on the D1 path (not the E2EE KV/DO path) and rides /sync's
 * account_data section like any other client-config type.
 */
import { describe, expect, it, vi } from 'vitest';

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
import { createEnv, createSharedDb, jsonInit, parseResponse, USER } from './spec-stabilization-harness';

const TYPE = 'm.recent_emoji';
const PATH = `/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/${TYPE}`;
const RECENTS = { '😀': 5, '🎉': 2, '👍': 1 };

describe('MSC4356 m.recent_emoji account data', () => {
  it('PUT then GET returns the emoji usage map unchanged', async () => {
    const env = createEnv({ db: createSharedDb() });
    const put = await parseResponse(
      await accountDataApp.request(`http://localhost${PATH}`, jsonInit('PUT', RECENTS), env)
    );
    expect(put.status).toBe(200);

    const get = await parseResponse(
      await accountDataApp.request(`http://localhost${PATH}`, {}, env)
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual(RECENTS);
  });

  it('stores via D1 with an account_data change row, never via USER_KEYS', async () => {
    const env = createEnv({ db: createSharedDb() });
    const put = await accountDataApp.request(`http://localhost${PATH}`, jsonInit('PUT', RECENTS), env);
    expect(put.status).toBe(200);
    expect(env._db.accountData).toEqual([
      { user_id: USER, room_id: '', event_type: TYPE, content: JSON.stringify(RECENTS) },
    ]);
    expect(env._db.changes).toEqual([
      { user_id: USER, room_id: '', event_type: TYPE, stream_position: 1 },
    ]);
    expect(env._userKeys.deviceKeys).toEqual({});
  });

  it('is delivered in the /sync account_data.events section after the write', async () => {
    const env = createEnv({ db: createSharedDb() });
    const put = await accountDataApp.request(`http://localhost${PATH}`, jsonInit('PUT', RECENTS), env);
    expect(put.status).toBe(200);

    const { status, body } = await parseResponse(
      await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, env)
    );
    expect(status).toBe(200);
    expect(body.account_data.events).toEqual([{ type: TYPE, content: RECENTS }]);
  });

  it('preserves the latest map on a second PUT and syncs only the new content', async () => {
    const env = createEnv({ db: createSharedDb() });
    await accountDataApp.request(`http://localhost${PATH}`, jsonInit('PUT', RECENTS), env);
    const updated = { '😀': 9 };
    const put = await accountDataApp.request(`http://localhost${PATH}`, jsonInit('PUT', updated), env);
    expect(put.status).toBe(200);

    const { body } = await parseResponse(
      await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, env)
    );
    expect(body.account_data.events).toEqual([{ type: TYPE, content: updated }]);
    expect(env._db.accountData).toHaveLength(1);
  });
});
