/**
 * Native bot framework tests: the admin console command router, the
 * room-integrations hook (loop prevention, command consumption, telegram
 * relay), and the Telegram bridge (webhook update processing, duplicate
 * suppression, Matrix->Telegram relay). Room posting is mocked at the
 * performSendEvent boundary; Telegram's API is a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const performSendEvent = vi.fn(
  async () => ({ eventId: '$botmsg:example.com', originServerTs: 1 })
);
const sendServerNotice = vi.fn(async () => '$notice');

vi.mock('../src/api/rooms', () => ({
  performSendEvent: (...args: unknown[]) => performSendEvent(...(args as [Env, string, string, string, unknown])),
}));
vi.mock('../src/api/server-notices', () => ({
  sendServerNotice: (...args: unknown[]) => sendServerNotice(...(args as unknown[])),
}));

import { tryHandleAdminCommand } from '../src/services/bot-commands';
import { handleRoomMessage } from '../src/services/room-integrations';
import { relayMatrixToTelegram, processTelegramUpdate } from '../src/services/telegram-bridge';
import { createBotRow, getBotByUserId, getEnabledBotsInRoom, isBotUser } from '../src/services/bots';

const SERVER = 'example.com';
const ADMIN = '@admin:example.com';
const USER = '@alice:example.com';
const ADMIN_BOT = '@adminbot:example.com';
const TG_BOT = '@tgbot:example.com';
const ROOM = '!room:example.com';

interface FakeOpts {
  admins?: string[];
  bots?: Array<{ user_id: string; kind: string }>;
  bridges?: Array<{ id: string; chat_id: string; room_id?: string; last_update_id?: number }>;
}

function makeDb(opts: FakeOpts = {}) {
  const users = new Map<string, any>([
    [ADMIN, { user_id: ADMIN, admin: 1, is_deactivated: 0, is_guest: 0, created_at: 1 }],
    [USER, { user_id: USER, admin: 0, is_deactivated: 0, is_guest: 0, created_at: 2 }],
    ...(opts.admins ?? []).map((u) => [u, { user_id: u, admin: 1, is_deactivated: 0, is_guest: 0, created_at: 3 }]),
  ]);
  const botRows = new Map<string, any>(
    (opts.bots ?? [{ user_id: ADMIN_BOT, kind: 'admin' }, { user_id: TG_BOT, kind: 'telegram' }]).map((b, i) => [
      b.user_id,
      { id: `bot${i}`, user_id: b.user_id, kind: b.kind, command_prefix: '!admin', enabled: 1, created_at: 1 },
    ])
  );
  const memberships = new Map<string, string>([
    [`${ROOM}\0${ADMIN_BOT}`, 'join'],
    [`${ROOM}\0${TG_BOT}`, 'join'],
  ]);
  const tokens: any[] = [];
  const bridges = (opts.bridges ?? [{ id: 'tgb1', chat_id: '4711', room_id: ROOM, last_update_id: 0 }]).map(
    (b) => ({ ...b, room_id: b.room_id ?? ROOM, bot_user_id: TG_BOT, tg_token: '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', webhook_secret: 's3cret', enabled: 1, created_at: 1, last_update_id: b.last_update_id ?? 0 })
  );

  const db = {
    users, botRows, memberships, tokens, bridges,
    prepare(sql: string) {
      const stmt = (args: unknown[]) => ({
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM users WHERE user_id = ?')) {
            const u = users.get(args[0] as string);
            return (u ? { ...u } : null) as T;
          }
          if (sql.includes('FROM bots WHERE user_id = ?')) {
            const b = botRows.get(args[0] as string);
            return (b && b.enabled ? { ...b } : null) as T;
          }
          if (sql.includes('SELECT 1 AS x FROM bots')) {
            const b = botRows.get(args[0] as string);
            return (b && b.enabled ? { x: 1 } : null) as T;
          }
          if (sql.includes('FROM bots WHERE id = ?')) {
            const b = [...botRows.values()].find((x: any) => x.id === args[0]);
            return (b ? { ...b } : null) as T;
          }
          if (sql.includes('FROM room_state rs JOIN events e')) {
            // displayname lookup in relayMatrixToTelegram
            return { content: JSON.stringify({ displayname: 'Alice Display' }) } as T;
          }
          if (sql.includes('FROM telegram_bridges WHERE id = ?')) {
            const b = bridges.find((x: any) => x.id === args[0]);
            return (b ? { ...b } : null) as T;
          }
          if (sql.includes('SELECT membership FROM room_memberships')) {
            return { membership: memberships.get(`${args[0]}\0${args[1]}`) ?? null } as T;
          }
          return null as T;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes('JOIN room_memberships m ON m.user_id = b.user_id')) {
            const out: any[] = [];
            for (const [key, m] of memberships) {
              if (!key.startsWith(`${args[0]}\0`) || m !== 'join') continue;
              const b = botRows.get(key.split('\0')[1]);
              if (b && b.enabled) out.push({ ...b });
            }
            return { results: out as T[] };
          }
          if (sql.includes('FROM telegram_bridges WHERE room_id = ?')) {
            return { results: bridges.filter((b) => b.room_id === args[0] && b.enabled === 1) as T[] };
          }
          if (sql.includes('FROM telegram_bridges ORDER BY created_at')) {
            return { results: [...bridges] as T[] };
          }
          if (sql.includes('FROM registration_tokens ORDER BY created_at DESC')) {
            return { results: [...tokens].sort((a: any, b: any) => b.created_at - a.created_at) as T[] };
          }
          if (sql.includes('FROM users') && sql.includes('WHERE is_guest = 0 ORDER BY created_at DESC')) {
            return { results: [...users.values()].sort((a: any, b: any) => b.created_at - a.created_at).slice(0, args[0] as number) as T[] };
          }
          if (sql.includes('FROM servers') && sql.includes('ORDER BY last_successful_fetch DESC')) {
            return { results: [{ server_name: 'peer.test', last_successful_fetch: 123 }] as T[] };
          }
          return { results: [] as T[] };
        },
        async firstCount(): Promise<{ n: number } | null> {
          if (sql.includes('COUNT(*)')) {
            if (sql.includes('FROM users')) return { n: users.size };
            if (sql.includes('FROM bots')) return { n: botRows.size };
            if (sql.includes('FROM rooms')) return { n: 5 };
            if (sql.includes('FROM events')) return { n: 100 };
            if (sql.includes('FROM media')) return { n: 2, bytes: 1024 };
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO registration_tokens')) {
            tokens.push({ id: args[0], note: args[2], created_by: args[3], created_at: Date.now(), expires_at: args[5], uses_remaining: args[6], revoked: 0 });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE registration_tokens SET revoked = 1')) {
            const t = tokens.find((x: any) => x.id === args[0]);
            if (t) { t.revoked = 1; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (sql.includes('UPDATE telegram_bridges SET last_update_id')) {
            const b = bridges.find((x: any) => x.id === args[1]);
            if (b) b.last_update_id = args[0] as number;
            return { meta: { changes: b ? 1 : 0 } };
          }
          if (sql.includes('INSERT INTO bots')) {
            botRows.set(args[1] as string, { id: args[0], user_id: args[1], kind: args[2], command_prefix: args[3], enabled: 1, created_at: args[4] });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      });
      // COUNT queries use first<>, not firstCount; route them in first().
      const rawFirst = stmt([]).first.bind(stmt([]));
      return {
        ...stmt([]),
        first: async <T>(...a: unknown[]) => {
          if (sql.includes('COUNT(*)')) {
            return (await stmt([]).firstCount()) as T;
          }
          return rawFirst(...a);
        },
        bind: (...a: unknown[]) => {
          const bound = stmt(a);
          const boundFirst = bound.first.bind(bound);
          return {
            ...bound,
            first: async <T>(): Promise<T | null> => {
              if (sql.includes('COUNT(*)')) {
                return (await stmt(a).firstCount()) as T;
              }
              return boundFirst() as Promise<T | null>;
            },
          };
        },
      };
    },
  };
  return db;
}

function makeEnv(opts: FakeOpts = {}): Env {
  const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined };
  return {
    DB: makeDb(opts) as unknown as D1Database,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: kv as unknown as KVNamespace,
    SESSIONS: kv as unknown as KVNamespace,
  } as unknown as Env;
}

const fetchMock = vi.fn(async () => Response.json({ ok: true }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  performSendEvent.mockClear();
  sendServerNotice.mockClear();
  fetchMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin console command router', () => {
  const bot = { id: 'bot0', user_id: ADMIN_BOT, kind: 'admin', command_prefix: '!admin', enabled: 1, created_at: 1 };

  it('ignores non-command bodies', async () => {
    const env = makeEnv();
    expect(await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, 'hello there')).toBeNull();
  });

  it('refuses non-admin senders', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, USER, '!admin status');
    expect(reply).toContain('not authorized');
    expect(performSendEvent).not.toHaveBeenCalled();
  });

  it('help lists commands; unknown commands say so', async () => {
    const env = makeEnv();
    const help = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin help');
    expect(help).toContain('token mint');
    const unknown = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin bogus');
    expect(unknown).toContain('unknown command');
  });

  it('status reports server counts', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin status');
    expect(reply).toContain(SERVER);
    expect(reply).toContain('rooms: 5');
  });

  it('token mint stores a registration token and shows it once', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin token mint 3 48');
    expect(reply).toContain('registration token (shown once)');
    expect(reply).toContain('uses: 3');
    const list = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin token list');
    expect(list).toContain('uses left: 3');
  });

  it('token revoke reports unknown ids', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin token revoke nope');
    expect(reply).toContain('not found');
  });

  it('notice routes through the server-notice service', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, `!admin notice ${USER} hello user`);
    expect(sendServerNotice).toHaveBeenCalledTimes(1);
    expect(reply).toContain('server notice sent');
  });

  it('federation status lists peers', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, '!admin federation status');
    expect(reply).toContain('peer.test');
  });

  it('deactivate requires CONFIRM', async () => {
    const env = makeEnv();
    const reply = await tryHandleAdminCommand(env, bot as any, ROOM, ADMIN, `!admin user deactivate ${USER}`);
    expect(reply).toContain('CONFIRM');
  });
});

describe('room integrations hook', () => {
  it('never acts on bot senders (loop prevention)', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, ADMIN_BOT, { body: '!admin token mint' }, 'local');
    expect(performSendEvent).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commands from admins produce a bot notice reply and are not relayed', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, ADMIN, { body: '!admin status' }, 'local');
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const [, , sender, , content] = performSendEvent.mock.calls[0];
    expect(sender).toBe(ADMIN_BOT);
    expect(content.msgtype).toBe('m.notice');
    // The command text must not leak to Telegram.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plain messages relay to Telegram with the sender display name', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, USER, { body: 'hi telegram' }, 'local');
    expect(performSendEvent).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(url).toContain('/bot111111111:AAAA');
    expect(url).toContain('/sendMessage');
    expect(body).toContain('"chat_id":"4711"');
    expect(body).toContain('Alice Display: hi telegram');
  });

  it('federated messages relay but never run commands', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, '@remote:peer.test', { body: '!admin token mint' }, 'federated');
    expect(performSendEvent).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('messages in unbridged rooms do nothing', async () => {
    const env = makeEnv({ bridges: [] });
    await handleRoomMessage(env, ROOM, USER, { body: 'hi' }, 'local');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('telegram webhook update processing', () => {
  const bridge = { id: 'tgb1', bot_user_id: TG_BOT, room_id: ROOM, chat_id: '4711', tg_token: '111111111:AAAA', webhook_secret: 's3cret', last_update_id: 0, enabled: 1, created_at: 1 };

  it('relays text messages into the room as the bridge bot', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 100,
      message: {
        message_id: 1,
        from: { id: 7, first_name: 'Ivan', username: 'ivan' },
        chat: { id: 4711, type: 'private' },
        text: 'privet',
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const [, roomId, sender, type, content] = performSendEvent.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(sender).toBe(TG_BOT);
    expect(type).toBe('m.room.message');
    expect(content.body).toBe('[TG] Ivan (@ivan): privet');
  });

  it('skips duplicates and other chats', async () => {
    const env = makeEnv();
    // First delivery accepted; the fresh env's bridge starts at update 0.
    await processTelegramUpdate(env, bridge as any, {
      update_id: 100,
      message: { message_id: 2, chat: { id: 4711, type: 'private' }, text: 'original' },
    });
    performSendEvent.mockClear();
    // The webhook route re-reads the bridge row per request, so it sees the
    // persisted last_update_id; mirror that here.
    const { getBridgeById } = await import('../src/services/telegram-bridge');
    const persisted = await getBridgeById(env.DB as unknown as D1Database, 'tgb1');
    // Replayed update: at or before last_update_id -> ignored.
    await processTelegramUpdate(env, persisted! as any, {
      update_id: 100,
      message: { message_id: 2, chat: { id: 4711, type: 'private' }, text: 'replay' },
    });
    // Newer update, but for a different chat -> ignored.
    await processTelegramUpdate(env, persisted! as any, {
      update_id: 101,
      message: { message_id: 3, chat: { id: 999, type: 'private' }, text: 'wrong chat' },
    });
    expect(performSendEvent).not.toHaveBeenCalled();
  });

  it('media updates become placeholders with captions', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 102,
      message: { message_id: 4, chat: { id: 4711, type: 'private' }, photo: {}, caption: 'look' },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    expect(performSendEvent.mock.calls[0][4].body).toContain('[telegram photo] look');
  });
});

describe('bots registry', () => {
  it('createBotRow + isBotUser + getEnabledBotsInRoom', async () => {
    const env = makeEnv({ bots: [] });
    await createBotRow(env.DB as unknown as D1Database, 'botx', '@botx:example.com', 'admin', '!admin');
    expect(await isBotUser(env.DB as unknown as D1Database, '@botx:example.com')).toBe(true);
    expect(await getBotByUserId(env.DB as unknown as D1Database, '@botx:example.com')).toBeTruthy();
  });
});
