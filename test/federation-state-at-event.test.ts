// Federation /state and /state_ids with event_id must serve state BEFORE that
// event and the transitive auth chain, not current state under an event-scoped
// query. The DAG here has a later state event so the two states differ.
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/federation-auth', () => ({
  requireFederationAuth: () => {
    return async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('federationOrigin', 'remote.example.com');
      await next();
    };
  },
}));

import federationApp from '../src/api/federation';

const SERVER = 'example.com';
const ROOM = '!room:example.com';
const USER = '@alice:example.com';

type EventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  hashes: string | null;
  signatures: string | null;
};

function event(
  id: string,
  type: string,
  depth: number,
  opts: {
    stateKey?: string;
    content?: Record<string, unknown>;
    auth?: string[];
    prev?: string[];
  } = {}
): EventRow {
  return {
    event_id: id,
    room_id: ROOM,
    sender: USER,
    event_type: type,
    state_key: opts.stateKey ?? null,
    content: JSON.stringify(opts.content ?? {}),
    origin_server_ts: 1_700_000_000_000 + depth,
    depth,
    auth_events: JSON.stringify(opts.auth ?? []),
    prev_events: JSON.stringify(opts.prev ?? []),
    hashes: null,
    signatures: null,
  };
}

function buildDag() {
  const create = event('$create', 'm.room.create', 1, {
    stateKey: '',
    content: { creator: '@founder:remote.example.com', room_version: '10' },
  });
  const joinRules = event('$jr', 'm.room.join_rules', 2, {
    stateKey: '',
    content: { join_rule: 'public' },
    auth: [create.event_id],
  });
  // Second hop: power_levels -> join_rules -> create.
  const power = event('$pl', 'm.room.power_levels', 3, {
    stateKey: '',
    content: { users: { [USER]: 100 } },
    auth: [joinRules.event_id],
  });
  const member = event('$join', 'm.room.member', 4, {
    stateKey: USER,
    content: { membership: 'join' },
    auth: [create.event_id, joinRules.event_id, power.event_id],
    prev: [create.event_id],
  });
  const msg1 = event('$msg1', 'm.room.message', 5, {
    content: { body: 'before' },
    auth: [member.event_id],
    prev: [member.event_id],
  });
  const nameOld = event('$name-old', 'm.room.name', 6, {
    stateKey: '',
    content: { name: 'Old' },
    auth: [power.event_id, member.event_id],
    prev: [msg1.event_id],
  });
  const msg2 = event('$msg2', 'm.room.message', 7, {
    content: { body: 'between' },
    auth: [nameOld.event_id, member.event_id],
    prev: [nameOld.event_id],
  });
  const nameNew = event('$name-new', 'm.room.name', 8, {
    stateKey: '',
    content: { name: 'New' },
    auth: [nameOld.event_id, member.event_id],
    prev: [msg2.event_id],
  });
  const topic = event('$topic', 'm.room.topic', 9, {
    stateKey: '',
    content: { topic: 'current topic' },
    auth: [nameNew.event_id, member.event_id],
    prev: [nameNew.event_id],
  });
  const events = [create, joinRules, power, member, msg1, nameOld, msg2, nameNew, topic];
  const byId = new Map(events.map((e) => [e.event_id, e]));
  const state = new Map<string, string>([
    ['m.room.create\0', create.event_id],
    ['m.room.join_rules\0', joinRules.event_id],
    ['m.room.power_levels\0', power.event_id],
    [`m.room.member\0${USER}`, member.event_id],
    ['m.room.name\0', nameNew.event_id],
    ['m.room.topic\0', topic.event_id],
  ]);
  return { events, byId, state, currentIds: create.event_id };
}

function makeHarness(dag: ReturnType<typeof buildDag>) {
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT room_id, room_version FROM rooms')) {
                return { room_id: ROOM, room_version: '10' } as T;
              }
              if (sql.includes('FROM events WHERE event_id = ?')) {
                return (dag.byId.get(args[0] as string) ?? null) as T;
              }
              if (sql.includes('FROM room_state rs') && sql.includes('rs.event_type = ?')) {
                const id = dag.state.get(`${args[1]}\0${args[2] ?? ''}`);
                const row = id ? dag.byId.get(id) : undefined;
                return row
                  ? ({
                      ...row,
                      room_id: ROOM,
                      event_type: row.event_type,
                      content: row.content,
                    } as T)
                  : (null as T);
              }
              return null as T;
            },
            async all<T>() {
              if (sql.includes('FROM room_state rs') && sql.includes('JOIN events e')) {
                const rows = [...dag.state.values()]
                  .map((id) => dag.byId.get(id))
                  .filter(Boolean)
                  .map((row) => ({ ...row, event_type: row!.event_type }));
                return { results: rows as T[] };
              }
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
        async first<T>() {
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;

  const env = { DB: db, SERVER_NAME: SERVER, SERVER_VERSION: 'test' } as unknown as Env;
  async function get(path: string) {
    const response = await federationApp.request(`http://localhost${path}`, {}, env);
    return { status: response.status, body: (await response.json()) as any };
  }
  return { env, get };
}

describe('federation state at event', () => {
  it('/state with event_id serves state before the event, not current state', async () => {
    const { get } = makeHarness(buildDag());
    const atMsg2 = await get(
      `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}?event_id=%24msg2`
    );
    expect(atMsg2.status).toBe(200);
    const names = (atMsg2.body.pdus as Array<{ type: string; content: { name?: string } }>)
      .filter((p) => p.type === 'm.room.name');
    expect(names).toHaveLength(1);
    expect(names[0].content.name).toBe('Old');
    expect(atMsg2.body.auth_chain).toBeDefined();

    const current = await get(`/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}`);
    const currentName = (current.body.pdus as Array<{ type: string; content: { name?: string } }>)
      .find((p) => p.type === 'm.room.name');
    expect(currentName?.content.name).toBe('New');
  });

  it('/state_ids with event_id returns state ids before the event and a recursive auth chain', async () => {
    const { get } = makeHarness(buildDag());
    const res = await get(
      `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}?event_id=%24msg2`
    );
    expect(res.status).toBe(200);
    expect(res.body.pdu_ids).toContain('$name-old');
    expect(res.body.pdu_ids).not.toContain('$name-new');
    expect(res.body.pdu_ids).not.toContain('$topic');
    // $jr is only reachable through $power's auth_events (second hop).
    expect(res.body.auth_chain_ids).toContain('$jr');
    expect(res.body.auth_chain_ids).toContain('$create');
  });

  it('unknown event_id gets 404 on both endpoints', async () => {
    const { get } = makeHarness(buildDag());
    expect(
      (await get(`/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}?event_id=%24missing`)).status
    ).toBe(404);
    expect(
      (await get(`/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}?event_id=%24missing`)).status
    ).toBe(404);
  });
});
