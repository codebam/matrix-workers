import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { MatrixApiError } from '../src/utils/errors';

const USER = '@alice:example.com';
const OTHER = '@bob:example.com';
const TYPE = 'net.f0rest.msc4584.soft_ignore_config';
const PATH = `/_matrix/client/v3/user/${encodeURIComponent(USER)}/account_data/${TYPE}`;

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEV');
      await next();
    };
  },
}));

import softIgnoreApp, {
  parseSoftIgnoreConfig,
  resolveSoftIgnore,
  SOFT_IGNORE_CONFIG_EVENT_TYPE,
} from '../src/api/msc4584';

function fakeDb() {
  const rows = new Map<string, string>();
  const changes: Array<{ userId: string; roomId: string; eventType: string; streamPosition: number }> = [];
  let position = 5;
  return {
    rows,
    changes,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT content FROM account_data')) {
                const content = rows.get(`${args[0]}\0\0${args[1]}`);
                return (content === undefined ? null : { content }) as T;
              }
              if (sql.includes('SELECT position FROM stream_positions')) {
                return { position } as T;
              }
              return null as T;
            },
            async run() {
              if (sql.includes('UPDATE stream_positions')) {
                position += 1;
              } else if (sql.includes('INSERT INTO account_data_changes')) {
                // room_id is the literal '' in the statement, so three args.
                changes.push({
                  userId: args[0] as string,
                  roomId: '',
                  eventType: args[1] as string,
                  streamPosition: args[2] as number,
                });
              } else if (sql.includes('INSERT INTO account_data')) {
                // (user_id, '', event_type, content) is bound as three args
                // because room_id is the literal '' in the statement.
                rows.set(`${args[0]}\0\0${args[1]}`, args[2] as string);
              }
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database & {
    rows: Map<string, string>;
    changes: Array<{ userId: string; roomId: string; eventType: string; streamPosition: number }>;
  };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('MSC4584 soft-ignoring config helpers', () => {
  it('uses the unstable account data event type', () => {
    expect(SOFT_IGNORE_CONFIG_EVENT_TYPE).toBe('net.f0rest.msc4584.soft_ignore_config');
  });

  it('applies the specified defaults and normalises deny to ignore', () => {
    expect(parseSoftIgnoreConfig({})).toEqual({
      enabled: true,
      users: {},
      rooms: {},
      servers: {},
    });
    expect(parseSoftIgnoreConfig({
      enabled: false,
      users: { '@mallory:evil.com': 'deny', '@alice:example.com': 'allow' },
      rooms: { '!family:example.com': 'ignore' },
      servers: { 'evil.com': 'ignore' },
    })).toEqual({
      enabled: false,
      users: { '@mallory:evil.com': 'ignore', '@alice:example.com': 'allow' },
      rooms: { '!family:example.com': 'ignore' },
      servers: { 'evil.com': 'ignore' },
    });
  });

  it('rejects invalid config at the boundary', () => {
    const invalid: unknown[] = [
      null,
      [],
      { enabled: 'yes' },
      { users: { 'alice:example.com': 'ignore' } },
      { users: { '@alice:example.com': 'block' } },
      { rooms: { 'not-a-room': 'ignore' } },
      { servers: { 'matrix.org': 'allow' } },
      { servers: [] },
    ];
    for (const content of invalid) {
      try {
        parseSoftIgnoreConfig(content);
        throw new Error(`expected rejection for ${JSON.stringify(content)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(MatrixApiError);
        expect((error as MatrixApiError).status).toBe(400);
        expect((error as MatrixApiError).errcode).toBe('M_INVALID_PARAM');
      }
    }
  });

  it('resolves ignored users and rooms, honouring ignored servers and the toggle', () => {
    const config = parseSoftIgnoreConfig({
      users: {
        '@mallory:evil.com': 'ignore',
        '@spam:spam.example': 'ignore',
        '@friend:example.com': 'allow',
      },
      rooms: { '!family:example.com': 'ignore', '!work:example.com': 'allow' },
      servers: { 'evil.com': 'ignore' },
    });
    expect(resolveSoftIgnore(config)).toEqual({
      users: new Set(['@spam:spam.example']),
      rooms: new Set(['!family:example.com']),
    });
    expect(resolveSoftIgnore(parseSoftIgnoreConfig({ ...config, enabled: false }))).toEqual({
      users: new Set(),
      rooms: new Set(),
    });
  });
});

describe('MSC4584 soft-ignoring account data routes', () => {
  let db: ReturnType<typeof fakeDb>;
  let syncFetch: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeEach(() => {
    db = fakeDb();
    syncFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const sync = {
      idFromName: () => 'sync-id',
      get: () => ({ fetch: syncFetch }),
    } as unknown as DurableObjectNamespace;
    env = { DB: db, SERVER_NAME: 'example.com', SYNC: sync } as unknown as Env;
  });

  it('stores and returns the config without rewriting the client payload', async () => {
    const content = { users: { '@mallory:evil.com': 'ignore' } };
    const put = await softIgnoreApp.request(`http://localhost${PATH}`, jsonInit('PUT', content), env);
    expect(put.status).toBe(200);

    expect(JSON.parse(db.rows.get(`${USER}\0\0${TYPE}`)!)).toEqual(content);
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0]).toMatchObject({ userId: USER, roomId: '', eventType: TYPE, streamPosition: 6 });
    expect(syncFetch).toHaveBeenCalledTimes(1);

    const get = await softIgnoreApp.request(`http://localhost${PATH}`, jsonInit('GET'), env);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(content);
  });

  it('reports missing config and rejects other users', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const missing = await softIgnoreApp.request(`http://localhost${PATH}`, jsonInit('GET'), env);
    expect(missing.status).toBe(404);

    const otherPath = `/_matrix/client/v3/user/${encodeURIComponent(OTHER)}/account_data/${TYPE}`;
    const forbidden = await softIgnoreApp.request(`http://localhost${otherPath}`, jsonInit('PUT', {}), env);
    expect(forbidden.status).toBe(403);
    vi.mocked(console.log).mockRestore();
  });

  it('rejects malformed JSON and invalid config before writing', async () => {
    const badJson = await softIgnoreApp.request(`http://localhost${PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }, env);
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { errcode: string }).errcode).toBe('M_BAD_JSON');

    const badConfig = await softIgnoreApp.request(`http://localhost${PATH}`, jsonInit('PUT', {
      users: { 'not-a-user': 'ignore' },
    }), env);
    expect(badConfig.status).toBe(400);
    expect(((await badConfig.json()) as { errcode: string }).errcode).toBe('M_INVALID_PARAM');
    expect(db.rows.size).toBe(0);
    expect(syncFetch).not.toHaveBeenCalled();
  });
});
