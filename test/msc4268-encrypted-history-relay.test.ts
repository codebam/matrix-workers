/**
 * MSC4268 (Matrix v1.19): encrypted history sharing relays client-built
 * `m.room_key_bundle` to-device messages and lets invitees query the device
 * keys they need. The server must not validate the to-device type, gate
 * /keys/query on membership, or rewrite the outbound m.direct_to_device EDU.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  userId: '@alice:example.com',
  deviceId: 'ALICEDEV',
}));

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', authState.userId);
      c.set('deviceId', authState.deviceId);
      c.set('auth', {
        userId: authState.userId,
        deviceId: authState.deviceId,
        accessToken: 't',
      });
      await next();
    };
  },
}));

import toDeviceApp from '../src/api/to-device';
import syncApp from '../src/api/sync';
import keysApp from '../src/api/keys';
import {
  createEnv,
  createSharedDb,
  createUserKeysStub,
  jsonInit,
  parseResponse,
  ROOM,
  USER,
} from './spec-stabilization-harness';

const BOB = '@bob:example.com';
const INVITEE = '@invitee:example.com';
const REMOTE = '@carol:remote.example.org';
const BUNDLE = {
  room_id: ROOM,
  session_id: 'session-abc',
  shared_history: true,
  key_backup: {
    url: 'mxc://example.com/history-bundle',
    key: { alg: 'A256-GCM', k: 'AAEAAQ', ext: true },
  },
};

beforeEach(() => {
  authState.userId = USER;
  authState.deviceId = 'ALICEDEV';
});

describe('MSC4268 m.room_key_bundle to-device relay', () => {
  it('delivers a shared_history bundle to the target device via /sync', async () => {
    const db = createSharedDb();
    const env = createEnv({ db });

    const put = await parseResponse(
      await toDeviceApp.request(
        `http://localhost/_matrix/client/v3/sendToDevice/m.room_key_bundle/txn-bundle-1`,
        jsonInit('PUT', { messages: { [BOB]: { BOBDEV: BUNDLE } } }),
        env
      )
    );
    expect(put.status).toBe(200);
    expect(db.toDevice).toHaveLength(1);
    expect(db.toDevice[0]).toMatchObject({
      recipient_user_id: BOB,
      recipient_device_id: 'BOBDEV',
      sender_user_id: USER,
      event_type: 'm.room_key_bundle',
    });
    expect(JSON.parse(db.toDevice[0].content)).toEqual(BUNDLE);

    // Switch the authenticated device to the bundle recipient.
    authState.userId = BOB;
    authState.deviceId = 'BOBDEV';
    const sync = await parseResponse(
      await syncApp.request('http://localhost/_matrix/client/v3/sync', {}, env)
    );
    expect(sync.status).toBe(200);
    expect(sync.body.to_device.events).toEqual([
      { sender: USER, type: 'm.room_key_bundle', content: BUNDLE },
    ]);
    expect(sync.body.to_device.events[0].content.shared_history).toBe(true);
  });
});

describe('MSC4268 invitee device-key query', () => {
  it('an INVITED-only user receives a joined member\'s device keys from /keys/query', async () => {
    const deviceKeys = {
      BOBDEV: {
        user_id: BOB,
        device_id: 'BOBDEV',
        algorithms: ['m.megolm.v1.aes-sha2'],
        keys: { 'curve25519:BOBDEV': 'device-key' },
      },
    };
    const db = createSharedDb({
      memberships: [
        { room_id: ROOM, user_id: INVITEE, membership: 'invite' },
        { room_id: ROOM, user_id: BOB, membership: 'join' },
      ],
    });
    const env = createEnv({
      db,
      userKeys: createUserKeysStub({ deviceKeys }),
    });
    authState.userId = INVITEE;

    const res = await parseResponse(
      await keysApp.request(
        'http://localhost/_matrix/client/v3/keys/query',
        jsonInit('POST', { device_keys: { [BOB]: [] } }),
        env
      )
    );
    expect(res.status).toBe(200);
    expect(res.body.device_keys[BOB]).toEqual(deviceKeys);
    expect(res.body.failures).toEqual({});
    // The caller really is invite-only in the room — no join gate applied.
    expect(db.memberships.find((m) => m.user_id === INVITEE)?.membership).toBe('invite');
  });
});

describe('MSC4268 outbound m.direct_to_device EDU', () => {
  it('forwards the bundle event type and content verbatim', async () => {
    const federationDo = createEnv()._federationDo;
    const db = createSharedDb();
    const env = createEnv({ db, federationDo });

    const put = await parseResponse(
      await toDeviceApp.request(
        'http://localhost/_matrix/client/v3/sendToDevice/m.room_key_bundle/txn-remote-1',
        jsonInit('PUT', { messages: { [REMOTE]: { CDEV: BUNDLE } } }),
        env
      )
    );
    expect(put.status).toBe(200);
    expect(federationDo.fetches).toHaveLength(1);
    const edu = federationDo.fetches[0].body as {
      destination: string;
      edu_type: string;
      content: { sender: string; type: string; messages: unknown };
    };
    expect(edu.destination).toBe('remote.example.org');
    expect(edu.edu_type).toBe('m.direct_to_device');
    expect(edu.content.type).toBe('m.room_key_bundle');
    expect(edu.content.sender).toBe(USER);
    expect(edu.content.messages).toEqual({ [REMOTE]: { CDEV: BUNDLE } });
    // Remote recipients must not be stored as local to_device rows.
    expect(db.toDevice).toHaveLength(0);
  });
});
