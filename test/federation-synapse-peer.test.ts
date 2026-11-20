/**
 * GNU/Linux-class delivery regression: a real resident server (Synapse)
 * auth-checks inbound PDUs against room state. If our stored membership
 * event lacks the auth types Synapse selects (join_rules for joins), the
 * resident outliers it, and every later message from us is rejected with
 * "sender not in room" — HTTP 200 but never displayed.
 *
 * The peer here is an in-process mock implementing Synapse's receive-side
 * rules (see helpers/synapse-peer.ts); no server processes or ports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PDU } from '../src/types';
import { SynapsePeer, peerSigningKey, installNodeEd25519Shim } from './helpers/synapse-peer';
import { prepareOutboundPdu } from '../src/services/event-wire';
import { computeWireEventId } from '../src/utils/event-signing';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('userId', USER);
    c.set('deviceId', 'DEV1');
    await next();
  },
}));
vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('federationOrigin', PEER_SERVER);
    await next();
  },
  optionalFederationAuth: () => async (c: any, next: () => Promise<void>) => {
    c.set('federationOrigin', PEER_SERVER);
    await next();
  },
}));

import roomsApp, { performSendEvent, performStateEvent } from '../src/api/rooms';
import federationApp from '../src/api/federation';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const PEER_SERVER = 'peer.test';
const PEER_USER = '@bob:peer.test';
const ROOM = '!gnulinux:peer.test';
const LOCAL_ROOM = '!local:example.com';

const signing = peerSigningKey();
let peer: SynapsePeer;
let db: ReturnType<typeof makeDb>;
let env: Env;
let restoreShim: () => void;

function rowToPdu(r: any): PDU {
  // Absent keys must stay absent: canonical JSON maps undefined to null,
  // which would change the reference hash vs the signed wire form.
  const pdu: Record<string, unknown> = {
    event_id: r.event_id,
    room_id: r.room_id,
    sender: r.sender,
    type: r.event_type,
    content: JSON.parse(r.content),
    origin_server_ts: r.origin_server_ts,
    depth: r.depth,
    auth_events: JSON.parse(r.auth_events),
    prev_events: JSON.parse(r.prev_events),
  };
  if (r.state_key !== null && r.state_key !== undefined) pdu.state_key = r.state_key;
  if (r.hashes) pdu.hashes = JSON.parse(r.hashes);
  if (r.signatures) pdu.signatures = JSON.parse(r.signatures);
  if (r.unsigned) pdu.unsigned = JSON.parse(r.unsigned);
  return pdu as PDU;
}

function makeDb() {
  const events = new Map<string, any>();
  const state = new Map<string, string>(); // room\0type\0key -> event_id
  const memberships = new Map<string, { membership: string; event_id: string }>();
  const rooms = new Map<string, any>();
  const serverKeys = [{ key_id: signing.keyId, private_key_jwk: JSON.stringify(signing.privateKeyJwk), is_current: 1, key_version: 2 }];
  let stream = 0;
  const slot = (room: string, type: string, key: string) => `${room}\0${type}\0${key}`;

  const db = {
    events, state, memberships, rooms,
    prepare(sql: string) {
      const stmt = (args: any[]) => ({
        async first<T>(): Promise<T | null> {
          if (sql.includes('UPDATE stream_positions')) return { position: ++stream } as T;
          if (sql.includes('INSERT INTO room_memberships')) {
            // tryInsertJoinMembership: upsert to join + RETURNING event_id.
            memberships.set(`${args[0]}\0${args[1]}`, { membership: 'join', event_id: args[2] });
            return { event_id: args[2] } as T;
          }
          if (sql.includes('FROM server_keys')) return (serverKeys[0] ?? null) as T;
          if (sql.includes('SELECT membership, event_id FROM room_memberships')) {
            const m = memberships.get(`${args[0]}\0${args[1]}`);
            return (m ? { membership: m.membership, event_id: m.event_id } : null) as T;
          }
          if (sql.includes('FROM room_state rs') && sql.includes('rs.event_type = ?')) {
            const id = state.get(slot(args[0], args[1], args[2]));
            // Raw row: getStateEvent parses the columns itself.
            return (id ? events.get(id) : null) as T;
          }
          if (sql.includes('SELECT e.event_id FROM room_state rs')) {
            const id = state.get(slot(args[0], 'm.room.create', ''));
            return (id ? { event_id: id } : null) as T;
          }
          if (sql.includes('sender NOT LIKE')) {
            const rows = [...events.values()]
              .filter((r) => r.room_id === args[0] && !r.sender.endsWith(`:${args[1]}`))
              .sort((a, b) => b.origin_server_ts - a.origin_server_ts);
            return (rows[0] ? { event_id: rows[0].event_id, depth: rows[0].depth } : null) as T;
          }
          if (sql.includes('FROM rooms WHERE room_id')) {
            return (rooms.get(args[0]) ?? null) as T;
          }
          if (sql.includes('FROM events WHERE event_id = ? AND room_id = ?')) {
            const r = events.get(args[0]);
            return (r && r.room_id === args[1] ? { event_id: r.event_id, auth_events: r.auth_events } : null) as T;
          }
          if (sql.includes('FROM events WHERE event_id = ?')) {
            // Raw row: federation handlers JSON.parse the columns themselves.
            return (events.get(args[0]) ?? null) as T;
          }
          return null as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes('FROM remote_server_keys')) {
            // fetchRemoteServerKeys: serve the local signing key so inbound
            // signature verification never hits the network.
            return {
              results: [{
                server_name: 'example.com', key_id: signing.keyId, public_key: signing.verifyKeyB64,
                valid_from: 0, valid_until: Date.now() + 86_400_000, fetched_at: Date.now(), verified: 1,
              }] as T[],
            };
          }
          if (sql.includes('SELECT DISTINCT user_id FROM room_memberships')) {
            return {
              results: [...memberships.entries()]
                .filter(([k, v]) => k.startsWith(`${args[0]}\0`) && v.membership === 'join')
                .map(([k]) => ({ user_id: k.split('\0')[1] })) as T[],
            };
          }
          if (sql.includes('user_id LIKE ?')) {
            return {
              results: [...memberships.entries()]
                .filter(([k, v]) => k.startsWith(`${args[0]}\0`) && v.membership === 'join' && k.split('\0')[1].endsWith(args[1].replace('%', '')))
                .map(([k]) => ({ user_id: k.split('\0')[1] })) as T[],
            };
          }
          if (sql.includes('SELECT e.* FROM room_state rs') || (sql.includes('FROM room_state rs') && sql.includes('e.event_type, e.state_key'))) {
            return {
              results: [...state.entries()]
                .filter(([k]) => k.startsWith(`${args[0]}\0`))
                .map(([, id]) => events.get(id))
                .filter(Boolean) as T[],
            };
          }
          if (sql.includes('FROM events WHERE room_id = ?') && sql.includes('ORDER BY depth ASC')) {
            return {
              results: [...events.values()]
                .filter((r) => r.room_id === args[0])
                .sort((a, b) => a.depth - b.depth || a.stream_ordering - b.stream_ordering) as T[],
            };
          }
          if (sql.includes('FROM events WHERE room_id = ?')) {
            // Raw rows: getRoomEvents parses the columns itself.
            return {
              results: [...events.values()]
                .filter((r) => r.room_id === args[0])
                .sort((a, b) => b.stream_ordering - a.stream_ordering)
                .slice(0, args[args.length - 1] ?? 50) as T[],
            };
          }
          if (sql.includes('COUNT(*)') && sql.includes('FROM events')) {
            return { results: [{ count: [...events.values()].filter((r) => r.room_id === args[0]).length }] as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO events')) {
            if (events.has(args[0])) return { meta: { changes: 0 } };
            if (sql.includes('unsigned')) {
              // storeEventIdempotent: 14 columns (with unsigned).
              const [event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering] = args;
              events.set(event_id, { event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering });
            } else {
              // Inbound /send storage: 13 columns (no unsigned).
              const [event_id, room_id, sender, event_type, state_key, content, origin_server_ts, depth, auth_events, prev_events, hashes, signatures, stream_ordering] = args;
              events.set(event_id, { event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned: null, depth, auth_events, prev_events, hashes, signatures, stream_ordering });
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO events')) {
            const [event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering] = args;
            events.set(event_id, { event_id, room_id, sender, event_type, state_key, content, origin_server_ts, unsigned, depth, auth_events, prev_events, hashes, signatures, stream_ordering });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT OR REPLACE INTO room_state')) {
            state.set(slot(args[0], args[1], args[2]), args[3]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT OR REPLACE INTO room_memberships')) {
            memberships.set(`${args[0]}\0${args[1]}`, { membership: args[2], event_id: args[3] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      });
      return { ...stmt([]), bind: (...a: any[]) => stmt(a) };
    },
  };
  return db;
}

function makeEnv(): Env {
  const kv = {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
  return {
    DB: db as unknown as D1Database,
    SERVER_NAME: SERVER,
    CACHE: kv as unknown as KVNamespace,
    SESSIONS: kv as unknown as KVNamespace,
    SYNC: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    FEDERATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const { pdu, room_id } = await req.json() as { pdu: any; room_id: string };
          if (process.env.PEER_DEBUG) {
            console.log('DELIVER', room_id, pdu.type, 'auth:', JSON.stringify(pdu.auth_events));
          }
          await peer.receiveSend(room_id, pdu, SERVER);
          return Response.json({ ok: true });
        },
      }),
    },
    PUSH_NOTIFICATION_WORKFLOW: { create: async () => ({ id: 'wf' }) },
  } as unknown as Env;
}

async function seedStateEvent(room: string, sender: string, type: string, stateKey: string, content: any, auth: string[], depth: number): Promise<string> {
  const pdu: PDU = {
    event_id: '', room_id: room, sender, type, state_key: stateKey, content,
    origin_server_ts: 1_700_000_000_000 + depth, depth, auth_events: auth, prev_events: [],
  };
  const prepared = await prepareOutboundPdu(env, pdu, '10');
  pdu.event_id = prepared!.wireId;
  pdu.hashes = prepared!.hashes as PDU['hashes'];
  pdu.signatures = prepared!.signatures as PDU['signatures'];
  db.events.set(pdu.event_id, {
    event_id: pdu.event_id, room_id: room, sender, event_type: type, state_key: stateKey,
    content: JSON.stringify(content), origin_server_ts: pdu.origin_server_ts, unsigned: null,
    depth, auth_events: JSON.stringify(auth), prev_events: '[]',
    hashes: JSON.stringify(pdu.hashes), signatures: JSON.stringify(pdu.signatures), stream_ordering: depth,
  });
  db.state.set(`${room}\0${type}\0${stateKey}`, pdu.event_id);
  return pdu.event_id;
}

// The resident's stored view after it outliered our pre-fix membership:
// state without our join, plus the outlier record.
async function seedPoisonedResident(room: string, oldJoin: string): Promise<void> {
  const pdus = (await servedState(room)).filter(
    (p) => !(p.type === 'm.room.member' && p.state_key === USER)
  );
  await peer.receiveState(room, pdus, SERVER);
  peer.rooms.get(room)!.outliers.set(oldJoin, 'join without join_rules in auth_events (pre-fix stored view)');
}

async function servedState(room: string): Promise<any[]> {
  const res = await federationApp.request(
    `http://localhost/_matrix/federation/v1/state/${encodeURIComponent(room)}`, {}, env
  );
  const body = await res.json() as any;
  return [...(body.pdus ?? []), ...(body.auth_chain ?? [])];
}

beforeEach(async () => {
  restoreShim = installNodeEd25519Shim();
  peer = new SynapsePeer(PEER_SERVER);
  peer.trustOrigin(SERVER, { [signing.keyId]: { key: signing.verifyKeyB64 } });
  db = makeDb();
  env = makeEnv();
  db.rooms.set(ROOM, { room_id: ROOM, room_version: '10', is_public: 1, creator_id: PEER_USER, created_at: 1 });
  db.rooms.set(LOCAL_ROOM, { room_id: LOCAL_ROOM, room_version: '10', is_public: 1, creator_id: USER, created_at: 1 });
});

afterEach(() => {
  restoreShim?.();
});

describe('GNU/Linux-class delivery against a Synapse-rules peer', () => {
  it('remote-created room: old membership lacking join_rules is outliered and later sends are rejected', async () => {
    const create = await seedStateEvent(ROOM, PEER_USER, 'm.room.create', '', { creator: PEER_USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(ROOM, PEER_USER, 'm.room.member', PEER_USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(ROOM, PEER_USER, 'm.room.power_levels', '', { users: { [PEER_USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    const jr = await seedStateEvent(ROOM, PEER_USER, 'm.room.join_rules', '', { join_rule: 'public' }, [create, pl, creatorJoin], 4);
    // Pre-fix stored join: auth_events without join_rules.
    const oldJoin = await seedStateEvent(ROOM, USER, 'm.room.member', USER, { membership: 'join' }, [create, pl], 5);
    db.memberships.set(`${ROOM}\0${PEER_USER}`, { membership: 'join', event_id: create });
    db.memberships.set(`${ROOM}\0${USER}`, { membership: 'join', event_id: oldJoin });

    // The resident already outliered our pre-fix join (its stored view).
    await seedPoisonedResident(ROOM, oldJoin);
    expect(peer.rooms.get(ROOM)!.outliers.has(oldJoin)).toBe(true);

    // Our message is accepted by the transport (200) but rejected by auth.
    const sent = await performSendEvent(env, ROOM, USER, 'm.room.message', { body: 'hi', msgtype: 'm.text' }, 'txn1');
    expect('eventId' in sent).toBe(true);
    expect(peer.rejections.some((r) => r.reason.includes('sender not in room'))).toBe(true);
    expect(peer.rooms.get(ROOM)!.timeline).toHaveLength(0);
  });

  it('re-join with correct auth heals delivery: membership accepted, messages display', async () => {
    const create = await seedStateEvent(ROOM, PEER_USER, 'm.room.create', '', { creator: PEER_USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(ROOM, PEER_USER, 'm.room.member', PEER_USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(ROOM, PEER_USER, 'm.room.power_levels', '', { users: { [PEER_USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    const jr = await seedStateEvent(ROOM, PEER_USER, 'm.room.join_rules', '', { join_rule: 'public' }, [create, pl, creatorJoin], 4);
    const oldJoin = await seedStateEvent(ROOM, USER, 'm.room.member', USER, { membership: 'join' }, [create, pl], 5);
    db.memberships.set(`${ROOM}\0${PEER_USER}`, { membership: 'join', event_id: creatorJoin });
    db.memberships.set(`${ROOM}\0${USER}`, { membership: 'join', event_id: oldJoin });

    // Resident holds the state but outliered our pre-fix join (no join_rules
    // in its auth_events), so our messages are rejected: 200 but undisplayed.
    const wireOf = (id: string) => {
      const { event_id: _e, ...w } = rowToPdu(db.events.get(id));
      return w as PDU;
    };
    await peer.ingestStateUnchecked(ROOM, [wireOf(create), wireOf(creatorJoin), wireOf(pl), wireOf(jr)], SERVER);
    peer.rooms.get(ROOM)!.outliers.set(oldJoin, 'join without join_rules in auth_events (pre-fix stored view)');
    const poisonedMsg = await prepareOutboundPdu(env, {
      event_id: '', room_id: ROOM, sender: USER, type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: 1_700_000_000_006,
      depth: 6, auth_events: [create, pl, oldJoin], prev_events: [oldJoin],
    } as PDU, '10');
    const { event_id: _p, ...poisonedWire } = { ...poisonedMsg!.wire } as PDU;
    expect(await peer.receiveSend(ROOM, poisonedWire as PDU, SERVER)).toContain('sender not in room');
    expect(peer.rooms.get(ROOM)!.timeline).toHaveLength(0);

    // Re-join with the auth selection Synapse requires (join_rules + prior
    // membership), as the fixed creation path produces. Refs use the
    // resident's ID space (mock-internal plumbing).
    const room0 = peer.rooms.get(ROOM)!;
    const pid0 = (type: string, key = '') => room0.state.get(`${type}\0${key}`)!.event_id!;
    const rejoinPdu: PDU = {
      event_id: '', room_id: ROOM, sender: USER, type: 'm.room.member', state_key: USER,
      content: { membership: 'join' }, origin_server_ts: 1_700_000_000_007, depth: 7,
      auth_events: [pid0('m.room.create'), pid0('m.room.power_levels'), pid0('m.room.join_rules'), oldJoin],
      prev_events: [oldJoin],
    };
    const rejoinPrepared = await prepareOutboundPdu(env, rejoinPdu, '10');
    const rejoinId = rejoinPrepared!.wireId;
    db.events.set(rejoinId, {
      event_id: rejoinId, room_id: ROOM, sender: USER, event_type: 'm.room.member', state_key: USER,
      content: JSON.stringify(rejoinPdu.content), origin_server_ts: rejoinPdu.origin_server_ts,
      unsigned: null, depth: 7, auth_events: JSON.stringify(rejoinPdu.auth_events),
      prev_events: JSON.stringify(rejoinPdu.prev_events),
      hashes: JSON.stringify(rejoinPrepared!.hashes), signatures: JSON.stringify(rejoinPrepared!.signatures),
      stream_ordering: 7,
    });
    db.state.set(`${ROOM}\0m.room.member\0${USER}`, rejoinId);
    db.memberships.set(`${ROOM}\0${USER}`, { membership: 'join', event_id: rejoinId });
    const { event_id: _r, ...rejoinWire } = { ...rejoinPdu, hashes: rejoinPrepared!.hashes, signatures: rejoinPrepared!.signatures } as PDU;
    expect(await peer.receiveSend(ROOM, rejoinWire as PDU, SERVER)).toBeNull();
    expect(peer.rooms.get(ROOM)!.state.get(`m.room.member\0${USER}`)?.content.membership).toBe('join');

    // Now the same message is accepted and displayed.
    const msg = await prepareOutboundPdu(env, {
      event_id: '', room_id: ROOM, sender: USER, type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: 1_700_000_000_008,
      depth: 8, auth_events: [create, pl, rejoinId], prev_events: [rejoinId],
    } as PDU, '10');
    const { event_id: _m, ...msgWire } = { ...msg!.wire } as PDU;
    expect(await peer.receiveSend(ROOM, msgWire as PDU, SERVER)).toBeNull();
    expect(peer.rooms.get(ROOM)!.timeline).toHaveLength(1);
  });

  it('served /event for the old membership includes the auth types Synapse requires (re-fetch heals)', async () => {
    const create = await seedStateEvent(ROOM, PEER_USER, 'm.room.create', '', { creator: PEER_USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(ROOM, PEER_USER, 'm.room.member', PEER_USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(ROOM, PEER_USER, 'm.room.power_levels', '', { users: { [PEER_USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    const jr = await seedStateEvent(ROOM, PEER_USER, 'm.room.join_rules', '', { join_rule: 'public' }, [create, pl, creatorJoin], 4);
    const oldJoin = await seedStateEvent(ROOM, USER, 'm.room.member', USER, { membership: 'join' }, [create, pl], 5);
    db.memberships.set(`${ROOM}\0${USER}`, { membership: 'join', event_id: oldJoin });
    await seedPoisonedResident(ROOM, oldJoin);

    const res = await federationApp.request(
      `http://localhost/_matrix/federation/v1/event/${encodeURIComponent(oldJoin)}`, {}, env
    );
    const body = await res.json() as any;
    const served = body.pdus[0];
    expect(await peer.verifyPdu(served, SERVER, '10')).toBeNull();
    // A resident re-fetching this event must be able to auth-check it.
    expect(peer.checkAuth(served, peer.rooms.get(ROOM)!)).toBeNull();
  });

  it('locally-created room: state and messages pass the peer end to end', async () => {
    const create = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.create', '', { creator: USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.member', USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.power_levels', '', { users: { [USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    await seedStateEvent(LOCAL_ROOM, USER, 'm.room.join_rules', '', { join_rule: 'public' }, [create, pl, creatorJoin], 4);
    db.memberships.set(`${LOCAL_ROOM}\0${USER}`, { membership: 'join', event_id: creatorJoin });
    const join = await performStateEvent(env, LOCAL_ROOM, USER, 'm.room.member', USER, { membership: 'join' });
    expect('eventId' in join).toBe(true);
    db.memberships.set(`${LOCAL_ROOM}\0${PEER_USER}`, { membership: 'join', event_id: create });

    // Ingest the room state in the same ID space the send path references.
    const stateWires = [];
    for (const id of [create, creatorJoin, pl]) {
      const { event_id: _e, ...wire } = rowToPdu(db.events.get(id));
      stateWires.push(wire);
    }
    const jrRow = [...db.state.entries()].find(([k]) => k.startsWith(`${LOCAL_ROOM}\0m.room.join_rules`))![1];
    const { event_id: _j, ...jrWire } = rowToPdu(db.events.get(jrRow));
    stateWires.push(jrWire);
    const joinRow = db.memberships.get(`${LOCAL_ROOM}\0${USER}`)!.event_id;
    const { event_id: _k, ...joinWire } = rowToPdu(db.events.get(joinRow));
    stateWires.push(joinWire);
    await peer.ingestStateUnchecked(LOCAL_ROOM, stateWires as PDU[], SERVER);
    expect(peer.rejections).toEqual([]);

    const lroom = peer.rooms.get(LOCAL_ROOM)!;
    const lpid = (type: string, key = '') => lroom.state.get(`${type}\0${key}`)!.event_id!;
    const msg: PDU = {
      event_id: '', room_id: LOCAL_ROOM, sender: USER, type: 'm.room.message',
      content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: 1_700_000_000_010,
      depth: 7, auth_events: [lpid('m.room.create'), lpid('m.room.power_levels'), lpid('m.room.member', USER)],
      prev_events: [lpid('m.room.member', USER)],
    };
    const preparedMsg = await prepareOutboundPdu(env, msg, '10');
    const { event_id: _m, ...msgWire } = { ...msg, hashes: preparedMsg!.hashes, signatures: preparedMsg!.signatures } as PDU;
    expect(await peer.receiveSend(LOCAL_ROOM, msgWire as PDU, SERVER)).toBeNull();
    expect(lroom.timeline).toHaveLength(1);
  });
});
describe('inbound wire-ID derivation must use the room version (v10 phantom-ID bug)', () => {
  it('inbound v10 /send PDU is stored under the sender v10-rule reference hash, not a v11+ phantom', async () => {
    const create = await seedStateEvent(ROOM, PEER_USER, 'm.room.create', '', { creator: PEER_USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(ROOM, PEER_USER, 'm.room.member', PEER_USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(ROOM, PEER_USER, 'm.room.power_levels', '', { users: { [PEER_USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    db.memberships.set(`${ROOM}\0${PEER_USER}`, { membership: 'join', event_id: creatorJoin });

    // A power_levels event authored by the resident: its reference hash
    // DIFFERS between v10 and v11+ redaction (v10 drops `invite`), so a
    // version-blind receiver derives a phantom ID the sender never used.
    const plUpdate: Record<string, unknown> = {
      room_id: ROOM, sender: PEER_USER, type: 'm.room.power_levels', state_key: '',
      content: { users: { [PEER_USER]: 100, [USER]: 50 }, users_default: 0, invite: 25, state_default: 50 },
      origin_server_ts: 1_700_000_000_006, depth: 6,
      auth_events: [create, pl, creatorJoin], prev_events: [pl],
    };
    const prepared = await prepareOutboundPdu(env, plUpdate as PDU, '10');
    const senderId = prepared!.wireId;
    const { event_id: _e, ...wire } = prepared!.wire as Record<string, unknown>;

    const res = await federationApp.request(
      'http://localhost/_matrix/federation/v1/send/1795000000000',
      { method: 'PUT', body: JSON.stringify({ pdus: [wire], edus: [] }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { pdus: Record<string, unknown> };
    // The receiver derived the SENDER's ID (v10 rules) and accepted it.
    expect(body.pdus[senderId]).toEqual({});
    expect(db.events.has(senderId)).toBe(true);

    // Pin the divergence this regression protects: a version-blind (v11+
    // rules) derivation yields a different, phantom ID that must not be used.
    const versionBlind = await computeWireEventId(wire);
    expect(versionBlind).not.toBe(senderId);
    expect(db.events.has(versionBlind)).toBe(false);
  });
});

describe('GNU/Linux-class heal: local member transitions must federate to residents', () => {
  it('leave + re-join fan out to the remote member; the post-heal message displays', async () => {
    // LOCAL room: we are the resident; a remote user (peer.test) is joined.
    const create = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.create', '', { creator: USER, room_version: '10' }, [], 1);
    const creatorJoin = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.member', USER, { membership: 'join' }, [create], 2);
    const pl = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.power_levels', '', { users: { [USER]: 100 }, state_default: 50, events_default: 0 }, [create, creatorJoin], 3);
    const jr = await seedStateEvent(LOCAL_ROOM, USER, 'm.room.join_rules', '', { join_rule: 'public' }, [create, pl, creatorJoin], 4);
    const peerJoin = await seedStateEvent(LOCAL_ROOM, PEER_USER, 'm.room.member', PEER_USER, { membership: 'join' }, [create, pl, jr], 5);
    db.memberships.set(`${LOCAL_ROOM}\0${USER}`, { membership: 'join', event_id: creatorJoin });
    db.memberships.set(`${LOCAL_ROOM}\0${PEER_USER}`, { membership: 'join', event_id: peerJoin });

    // Resident view: the peer ingests the same state (wire forms).
    const stateWires = [];
    for (const id of [create, creatorJoin, pl, jr, peerJoin]) {
      const { event_id: _e, ...wire } = rowToPdu(db.events.get(id));
      stateWires.push(wire);
    }
    await peer.ingestStateUnchecked(LOCAL_ROOM, stateWires as PDU[], SERVER);
    expect(peer.rejections).toEqual([]);

    // The user leaves via the client API. Without state-event fanout the
    // remote member's server never learns this, and the eventual re-join is
    // an event its auth checks cannot resolve later messages against.
    const leaveRes = await roomsApp.request(
      `http://localhost/_matrix/client/v3/rooms/${encodeURIComponent(LOCAL_ROOM)}/leave`,
      { method: 'POST', body: JSON.stringify({}) }, env,
    );
    expect(leaveRes.status).toBe(200);
    expect(
      peer.rooms.get(LOCAL_ROOM)!.state.get(`m.room.member\0${USER}`)?.content.membership
    ).toBe('leave');

    // The user re-joins via the client API; the resident peer sees the join.
    const joinRes = await roomsApp.request(
      `http://localhost/_matrix/client/v3/join/${encodeURIComponent(LOCAL_ROOM)}`,
      { method: 'POST', body: JSON.stringify({}) }, env,
    );
    expect(joinRes.status).toBe(200);
    expect(
      peer.rooms.get(LOCAL_ROOM)!.state.get(`m.room.member\0${USER}`)?.content.membership
    ).toBe('join');

    // The post-heal message is accepted and displayed.
    const sent = await performSendEvent(env, LOCAL_ROOM, USER, 'm.room.message', { body: 'healed', msgtype: 'm.text' }, 'txnh');
    console.log('SENT:', JSON.stringify(sent), 'REJECTIONS:', JSON.stringify(peer.rejections));
    expect('eventId' in sent).toBe(true);
    expect(
      peer.rooms.get(LOCAL_ROOM)!.timeline.some((p) => p.content?.body === 'healed')
    ).toBe(true);
    expect(peer.rejections).toEqual([]);
  });
});
