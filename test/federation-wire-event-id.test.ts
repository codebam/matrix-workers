/**
 * Regression: federation PDUs must not carry an explicit event_id for room
 * versions 3+ (Synapse derives it from the reference hash and rejects PDUs
 * that carry one). This broke inbound send_join/state resolution for legacy
 * (v10) rooms while v12 rooms worked. Room versions 1-2 keep event_id.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { omitWireEventId } from '../src/utils/event-signing';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  optionalFederationAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

import federation from '../src/api/federation';

const ROOM = '!wire:example.com';
const EV = '$wire1';

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EV,
    room_id: ROOM,
    sender: '@alice:example.com',
    event_type: 'm.room.message',
    state_key: null,
    content: JSON.stringify({ body: 'hi', msgtype: 'm.text' }),
    origin_server_ts: 1,
    depth: 1,
    auth_events: '[]',
    prev_events: '[]',
    hashes: null,
    signatures: null,
    ...overrides,
  };
}

function createDb(roomVersion: string, rows: ReturnType<typeof eventRow>[] = [eventRow()]) {
  const db = {
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>() {
          if (sql.includes('FROM rooms WHERE room_id')) {
            return { room_id: ROOM, room_version: roomVersion, is_public: 0, creator_id: null, created_at: 0 } as T;
          }
          if (sql.includes('FROM events WHERE event_id')) {
            return (rows.find((r) => r.event_id === args[0]) ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes('FROM room_state rs')) {
            return { results: rows as T[] };
          }
          if (sql.includes('FROM events')) {
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      });
      return { ...stmt([]), bind: (...args: unknown[]) => stmt(args) };
    },
  };
  return { DB: db, SERVER_NAME: 'example.com' } as unknown as Env;
}

async function get(env: Env, path: string) {
  const res = await federation.request(`http://localhost${path}`, {}, env);
  return { status: res.status, body: (await res.json()) as any };
}

describe('omitWireEventId', () => {
  it('keeps event_id for room versions 1-2 only', () => {
    const pdu = { event_id: '$x', type: 'm.room.message' };
    expect(omitWireEventId(pdu, '1').event_id).toBe('$x');
    expect(omitWireEventId(pdu, '2').event_id).toBe('$x');
    for (const rv of ['3', '4', '10', '11', '12', 'org.matrix.hydra.11', undefined]) {
      expect(omitWireEventId(pdu, rv).event_id).toBeUndefined();
    }
  });
});

describe('federation wire format per room version', () => {
  it('/event omits event_id for v10 and keeps it for v1', async () => {
    const v10 = await get(createDb('10'), `/_matrix/federation/v1/event/${encodeURIComponent(EV)}`);
    expect(v10.status).toBe(200);
    expect(v10.body.pdus[0].event_id).toBeUndefined();
    expect(v10.body.pdus[0].content.body).toBe('hi');

    const v1 = await get(createDb('1'), `/_matrix/federation/v1/event/${encodeURIComponent(EV)}`);
    expect(v1.body.pdus[0].event_id).toBe(EV);
  });

  it('/state omits event_id on pdus and auth_chain for v10', async () => {
    const { status, body } = await get(createDb('10'), `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    expect(status).toBe(200);
    expect(body.pdus.length).toBeGreaterThan(0);
    expect(body.pdus.every((p: any) => p.event_id === undefined)).toBe(true);
    expect(body.auth_chain.every((p: any) => p.event_id === undefined)).toBe(true);
  });

  it('/event_auth omits event_id for v10', async () => {
    const create = eventRow({ event_id: '$create', event_type: 'm.room.create', state_key: '' });
    const leaf = eventRow({ auth_events: JSON.stringify(['$create']) });
    const env = createDb('10', [create, leaf]);
    const { body } = await get(env, `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${encodeURIComponent(EV)}`);
    expect(body.auth_chain.length).toBe(1);
    expect(body.auth_chain[0].event_id).toBeUndefined();
    expect(body.auth_chain[0].type).toBe('m.room.create');
  });

  it('/backfill omits event_id for v10', async () => {
    const { status, body } = await get(createDb('10'), `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?limit=5&v=%24wire1`);
    expect(status).toBe(200);
    expect(body.pdus.length).toBeGreaterThan(0);
    expect(body.pdus.every((p: any) => p.event_id === undefined)).toBe(true);
  });
});