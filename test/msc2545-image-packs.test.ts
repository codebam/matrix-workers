/**
 * MSC2545 (Matrix v1.19): image packs ride two generic paths — a per-room
 * `m.room.image_pack` state event and the `m.image_pack.rooms` room account
 * data index. Element also gates custom emoji on the unstable flag, so
 * /versions must advertise org.matrix.msc2545.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';

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

const getMembership = vi.fn();
const getStateEvent = vi.fn();
const getRoomEvents = vi.fn();
const storeEvent = vi.fn();
const notifyUsersOfEvent = vi.fn();
const getUserRooms = vi.fn();
const getEventsSince = vi.fn();
const getLatestStreamPosition = vi.fn();
const getRoomState = vi.fn();
const getEvent = vi.fn();
const generateEventId = vi.fn();

vi.mock('../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/database')>();
  return {
    ...actual,
    getMembership: (...a: unknown[]) => getMembership(...a),
    getStateEvent: (...a: unknown[]) => getStateEvent(...a),
    getRoomEvents: (...a: unknown[]) => getRoomEvents(...a),
    storeEvent: (...a: unknown[]) => storeEvent(...a),
    notifyUsersOfEvent: (...a: unknown[]) => notifyUsersOfEvent(...a),
    getUserRooms: (...a: unknown[]) => getUserRooms(...a),
    getEventsSince: (...a: unknown[]) => getEventsSince(...a),
    getLatestStreamPosition: (...a: unknown[]) => getLatestStreamPosition(...a),
    getRoomState: (...a: unknown[]) => getRoomState(...a),
    getEvent: (...a: unknown[]) => getEvent(...a),
  };
});

vi.mock('../src/utils/ids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ids')>();
  return {
    ...actual,
    generateEventId: (...a: unknown[]) => generateEventId(...a),
  };
});

vi.mock('../src/services/room-cache', () => ({
  bumpRoomCacheGeneration: vi.fn(async () => undefined),
  invalidateRoomCache: vi.fn(async () => undefined),
}));

import roomsApp from '../src/api/rooms';
import accountDataApp from '../src/api/account-data';
import versionsApp from '../src/api/versions';
import {
  createEnv,
  createSharedDb,
  jsonInit,
  parseResponse,
  ROOM,
  USER,
} from './spec-stabilization-harness';

const USER_ENC = encodeURIComponent(USER);
const ROOM_ENC = encodeURIComponent(ROOM);
const PACK = {
  pack: { display_name: 'Custom emoji' },
  images: {
    wave: { url: 'mxc://example.com/wave', usage: ['emoticon'] },
  },
};

const PL = {
  users_default: 0,
  state_default: 50,
  // MSC2545 rooms explicitly allow ordinary members to publish packs by
  // lowering the power level for this state type to the message default.
  events: { 'm.room.image_pack': 0 },
};

function asPdu(partial: Partial<PDU> & { event_id: string; type: string }): PDU {
  return {
    room_id: ROOM,
    sender: USER,
    content: {},
    origin_server_ts: 1_700_000_000_000,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...partial,
  };
}

function roomsEnv(): Env {
  return createEnv({ db: createSharedDb() });
}

beforeEach(() => {
  getMembership.mockReset().mockResolvedValue({ membership: 'join', eventId: '$join' });
  getRoomEvents.mockReset().mockResolvedValue({ events: [], end: 0 });
  storeEvent.mockReset().mockResolvedValue(1);
  notifyUsersOfEvent.mockReset().mockResolvedValue(undefined);
  getUserRooms.mockReset().mockResolvedValue([]);
  getEventsSince.mockReset().mockResolvedValue([]);
  getLatestStreamPosition.mockReset().mockResolvedValue(0);
  getRoomState.mockReset().mockResolvedValue([]);
  getEvent.mockReset().mockResolvedValue(null);
  generateEventId.mockReset().mockResolvedValue('$image-pack:example.com');
});

describe('MSC2545 m.room.image_pack room state', () => {
  it('an ordinary member can PUT the state event and read it back', async () => {
    let storedPack: PDU | null = null;
    getStateEvent.mockReset().mockImplementation(
      async (_db: unknown, _room: string, type: string, stateKey = '') => {
        if (type === 'm.room.create') {
          return asPdu({ event_id: '$create', type, content: { creator: USER } });
        }
        if (type === 'm.room.power_levels') {
          return asPdu({ event_id: '$pl', type, content: PL, state_key: '' });
        }
        if (type === 'm.room.image_pack' && stateKey === 'default') {
          if (storedPack) return storedPack;
        }
        return null;
      }
    );
    storeEvent.mockImplementation(async (_db: unknown, event: PDU) => {
      storedPack = event;
      return 1;
    });

    const path = `/_matrix/client/v3/rooms/${ROOM_ENC}/state/m.room.image_pack/default`;
    const put = await parseResponse(
      await roomsApp.request(`http://localhost${path}`, jsonInit('PUT', PACK), roomsEnv())
    );
    expect(put.status).toBe(200);

    const stored = storeEvent.mock.calls.at(-1)![1] as PDU;
    expect(stored.type).toBe('m.room.image_pack');
    expect(stored.state_key).toBe('default');
    expect(stored.sender).toBe(USER);
    expect(stored.content).toEqual(PACK);

    const get = await parseResponse(
      await roomsApp.request(`http://localhost${path}`, {}, roomsEnv())
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual(PACK);
  });
});

describe('MSC2545 m.image_pack.rooms room account data', () => {
  it('round-trips the per-room pack index', async () => {
    const db = createSharedDb({
      memberships: [{ room_id: ROOM, user_id: USER, membership: 'join' }],
    });
    const env = createEnv({ db });
    const index = { [ROOM]: { 'm.room.image_pack': ['default'] } };
    const path = `/_matrix/client/v3/user/${USER_ENC}/rooms/${ROOM_ENC}/account_data/m.image_pack.rooms`;

    const put = await parseResponse(
      await accountDataApp.request(`http://localhost${path}`, jsonInit('PUT', index), env)
    );
    expect(put.status).toBe(200);

    const get = await parseResponse(
      await accountDataApp.request(`http://localhost${path}`, {}, env)
    );
    expect(get.status).toBe(200);
    expect(get.body).toEqual(index);
    expect(db.accountData).toEqual([
      {
        user_id: USER,
        room_id: ROOM,
        event_type: 'm.image_pack.rooms',
        content: JSON.stringify(index),
      },
    ]);
  });
});

describe('MSC2545 /versions advertisement', () => {
  it('advertises org.matrix.msc2545 so clients enable custom emoji', async () => {
    const { status, body } = await parseResponse(
      await versionsApp.request('http://localhost/_matrix/client/versions', {}, createEnv())
    );
    expect(status).toBe(200);
    expect(body.unstable_features['org.matrix.msc2545']).toBe(true);
  });
});
