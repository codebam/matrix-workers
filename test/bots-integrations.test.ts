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

const fetchRemoteMediaMock = vi.fn(async () => null);
vi.mock('../src/api/media', () => ({
  fetchRemoteMedia: (...args: unknown[]) =>
    fetchRemoteMediaMock(...(args as [unknown, string, string])),
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
  /** Simulate a D1 failure when recording a bridged message mapping. */
  failMessageMapWrite?: boolean;
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
  const mediaRows: any[] = [];
  const messageMap: any[] = [];
  const bridges = (opts.bridges ?? [{ id: 'tgb1', chat_id: '4711', room_id: ROOM, last_update_id: 0 }]).map(
    (b) => ({ ...b, room_id: b.room_id ?? ROOM, bot_user_id: TG_BOT, tg_token: '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', webhook_secret: 's3cret', enabled: 1, created_at: 1, last_update_id: b.last_update_id ?? 0 })
  );

  const db = {
    users, botRows, memberships, tokens, bridges, mediaRows, messageMap,
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
          if (sql.includes('FROM telegram_message_map WHERE chat_id = ?')) {
            const row = messageMap.find(
              (m) => String(m.chat_id) === String(args[0]) && m.telegram_message_id === args[1]
            );
            return (row ? { ...row } : null) as T;
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
          if (sql.includes('INSERT INTO media')) {
            mediaRows.push({ media_id: args[0], user_id: args[1], content_type: args[2], content_length: args[3], filename: args[4], created_at: args[5] });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO telegram_message_map')) {
            if (opts.failMessageMapWrite) throw new Error('D1 mapping write failed');
            const row = {
              chat_id: args[0], telegram_message_id: args[1], room_id: args[2],
              matrix_event_id: args[3], sender: args[4], body: args[5],
              formatted_body: args[6], created_at: args[7],
            };
            const existing = messageMap.findIndex(
              (m) => String(m.chat_id) === String(row.chat_id) && m.telegram_message_id === row.telegram_message_id
            );
            if (existing >= 0) messageMap[existing] = row;
            else messageMap.push(row);
            return { meta: { changes: 1 } };
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

function makeR2() {
  const store = new Map<string, { body: ArrayBuffer; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }>();
  return {
    store,
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return { arrayBuffer: async () => o.body, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata };
    },
    async put(key: string, body: ArrayBuffer, opts: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {}) {
      store.set(key, { body, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
    },
    async delete(key: string) { store.delete(key); },
    async head(key: string) {
      const o = store.get(key);
      return o ? { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null;
    },
  };
}

function makeEnv(opts: FakeOpts = {}): Env {
  const kv = { get: async () => null, put: async () => undefined, delete: async () => undefined };
  const media = makeR2();
  return {
    DB: makeDb(opts) as unknown as D1Database,
    SERVER_NAME: SERVER,
    SERVER_VERSION: '0.1.0-test',
    CACHE: kv as unknown as KVNamespace,
    SESSIONS: kv as unknown as KVNamespace,
    MEDIA: media as unknown as R2Bucket,
    // Test handle onto the mock bucket (not part of Env).
    __r2: media,
  } as unknown as Env;
}

const fetchMock = vi.fn(async () => Response.json({ ok: true }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  performSendEvent.mockClear();
  sendServerNotice.mockClear();
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => Response.json({ ok: true }));
  fetchRemoteMediaMock.mockClear();
  fetchRemoteMediaMock.mockImplementation(async () => null);
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

describe('telegram reply rendering', () => {
  const bridge = { id: 'tgb1', bot_user_id: TG_BOT, room_id: ROOM, chat_id: '4711', tg_token: '111111111:AAAA', webhook_secret: 's3cret', last_update_id: 0, enabled: 1, created_at: 1 };
  const sender = { id: 7, first_name: 'Ivan', username: 'ivan' };
  const chat = { id: 4711, type: 'private' };

  it('a reply to a bridged message carries m.in_reply_to and the spec fallback blocks', async () => {
    const env = makeEnv();
    performSendEvent.mockImplementationOnce(async () => ({ eventId: '$orig:example.com', originServerTs: 1 }));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 400,
      message: { message_id: 50, from: sender, chat, text: 'original message' },
    });
    await processTelegramUpdate(env, bridge as any, {
      update_id: 401,
      message: {
        message_id: 51, from: sender, chat, text: 'my reply',
        reply_to_message: { message_id: 50 },
      },
    });

    expect(performSendEvent).toHaveBeenCalledTimes(2);
    const [, roomId, sentBy, type, content] = performSendEvent.mock.calls[1];
    expect(roomId).toBe(ROOM);
    expect(sentBy).toBe(TG_BOT);
    expect(type).toBe('m.room.message');
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$orig:example.com' } });
    expect(content.body).toBe('> <@tgbot:example.com> [TG] Ivan (@ivan): original message\n[TG] Ivan (@ivan): my reply');
    expect(content.format).toBe('org.matrix.custom.html');
    expect(content.formatted_body).toBe(
      '<mx-reply><blockquote>' +
      '<a href="https://matrix.to/#/!room:example.com/$orig:example.com">In reply to</a> ' +
      '<a href="https://matrix.to/#/@tgbot:example.com">@tgbot:example.com</a><br>' +
      '[TG] Ivan (@ivan): original message</blockquote></mx-reply>[TG] Ivan (@ivan): my reply'
    );

    const rows = (env.DB as any).messageMap;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        chat_id: '4711', telegram_message_id: 50, room_id: ROOM,
        matrix_event_id: '$orig:example.com', sender: TG_BOT,
        body: '[TG] Ivan (@ivan): original message', formatted_body: null,
      }),
      expect.objectContaining({
        chat_id: '4711', telegram_message_id: 51, room_id: ROOM,
        matrix_event_id: '$botmsg:example.com', sender: TG_BOT,
        body: '[TG] Ivan (@ivan): my reply',
      }),
    ]));
    // The mapping stores the message's own text, not the reply's fallback.
    expect(rows[1].body).not.toContain('> <@');
  });

  it('quotes the original formatted_body when the bridged message had entities', async () => {
    const env = makeEnv();
    performSendEvent.mockImplementationOnce(async () => ({ eventId: '$rich:example.com', originServerTs: 1 }));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 410,
      message: {
        message_id: 70, from: sender, chat, text: 'bold text',
        entities: [{ offset: 0, length: 4, type: 'bold' }],
      },
    });
    await processTelegramUpdate(env, bridge as any, {
      update_id: 411,
      message: { message_id: 71, from: sender, chat, text: 'agree', reply_to_message: { message_id: 70 } },
    });

    const content = performSendEvent.mock.calls[1][4];
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$rich:example.com' } });
    expect(content.formatted_body).toContain('[TG] Ivan (@ivan): <b>bold</b> text</blockquote></mx-reply>');
    expect(content.formatted_body).toContain('</mx-reply>[TG] Ivan (@ivan): agree');
    const rows = (env.DB as any).messageMap;
    expect(rows[0].formatted_body).toBe('[TG] Ivan (@ivan): <b>bold</b> text');
  });

  it('a reply to an unmapped message stays plain and is still delivered', async () => {
    const env = makeEnv();
    const handled = await processTelegramUpdate(env, bridge as any, {
      update_id: 420,
      message: {
        message_id: 80, from: sender, chat, text: 'plain reply',
        reply_to_message: { message_id: 999 },
      },
    });
    expect(handled).toBe(true);
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    expect(performSendEvent.mock.calls[0][4]).toEqual({
      msgtype: 'm.text', body: '[TG] Ivan (@ivan): plain reply',
    });
    // The new message itself is still mapped for future replies.
    expect((env.DB as any).messageMap).toHaveLength(1);
  });

  it('a mapping write failure does not fail delivery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = makeEnv({ failMessageMapWrite: true });
      const handled = await processTelegramUpdate(env, bridge as any, {
        update_id: 430,
        message: {
          message_id: 90, from: sender, chat, text: 'still delivered',
          reply_to_message: { message_id: 123 },
        },
      });
      expect(handled).toBe(true);
      expect(performSendEvent).toHaveBeenCalledTimes(1);
      expect(performSendEvent.mock.calls[0][4].body).toBe('[TG] Ivan (@ivan): still delivered');
      expect((env.DB as any).messageMap).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('a reply to a bridged media message points at whatever event was mapped', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/getFile')) {
        return Response.json({ ok: true, result: { file_path: 'photos/x.jpg' } });
      }
      if (String(url).includes('/file/bot')) {
        return new Response(new Uint8Array([1, 2, 3]).buffer, { headers: { 'Content-Type': 'image/jpeg' } });
      }
      return Response.json({ ok: true });
    });
    performSendEvent.mockImplementationOnce(async () => ({ eventId: '$photo:example.com', originServerTs: 1 }));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 440,
      message: {
        message_id: 100, from: sender, chat,
        photo: [{ file_id: 'p', width: 640, height: 480, file_size: 300 }],
        caption: 'look',
      },
    });
    await processTelegramUpdate(env, bridge as any, {
      update_id: 441,
      message: { message_id: 101, from: sender, chat, text: 'nice', reply_to_message: { message_id: 100 } },
    });

    expect(performSendEvent).toHaveBeenCalledTimes(2);
    expect((env.DB as any).messageMap).toEqual(expect.arrayContaining([
      expect.objectContaining({
        telegram_message_id: 100, matrix_event_id: '$photo:example.com',
        body: '[TG] Ivan (@ivan): look',
      }),
    ]));
    const replyContent = performSendEvent.mock.calls[1][4];
    expect(replyContent['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$photo:example.com' } });
    expect(replyContent.body).toContain('> <@tgbot:example.com> [TG] Ivan (@ivan): look');
    expect(replyContent.formatted_body).toContain(
      'href="https://matrix.to/#/!room:example.com/$photo:example.com"'
    );
  });

  it('the outbound relay still skips the bot-sent reply', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 450,
      message: {
        message_id: 110, from: sender, chat, text: 'a reply',
        reply_to_message: { message_id: 111 },
      },
    });
    const replyContent = performSendEvent.mock.calls[0][4] as Record<string, unknown>;
    await handleRoomMessage(env, ROOM, TG_BOT, replyContent, 'local');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('telegram image bridging', () => {
  const bridge = { id: 'tgb1', bot_user_id: TG_BOT, room_id: ROOM, chat_id: '4711', tg_token: '111111111:AAAA', webhook_secret: 's3cret', last_update_id: 0, enabled: 1, created_at: 1 };
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer;

  /** Telegram getFile + file-download fetch pair. */
  function tgFileFetch(bytes: ArrayBuffer, mime = 'image/jpeg') {
    return async (url: string) => {
      if (String(url).includes('/getFile')) {
        return Response.json({ ok: true, result: { file_id: 'F1', file_path: 'photos/file_1.jpg' } });
      }
      if (String(url).includes('/file/bot')) {
        return new Response(bytes, { headers: { 'Content-Type': mime } });
      }
      return Response.json({ ok: true });
    };
  }

  // --- Telegram -> Matrix ---

  it('photos are downloaded, stored in the media repo, and posted as m.image', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(tgFileFetch(PNG_BYTES));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 200,
      message: {
        message_id: 9,
        from: { id: 7, first_name: 'Ivan', username: 'ivan' },
        chat: { id: 4711, type: 'private' },
        photo: [
          { file_id: 'small', width: 320, height: 240, file_size: 1000 },
          { file_id: 'big', width: 1280, height: 960, file_size: 4000 },
        ],
        caption: 'look at this',
      },
    });

    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const [, roomId, sender, type, content] = performSendEvent.mock.calls[0];
    expect(roomId).toBe(ROOM);
    expect(sender).toBe(TG_BOT);
    expect(type).toBe('m.room.message');
    expect(content.msgtype).toBe('m.image');
    expect(content.body).toBe('[TG] Ivan (@ivan): look at this');
    expect(String(content.url)).toMatch(/^mxc:\/\/example\.com\//);
    expect(content.info).toMatchObject({
      mimetype: 'image/jpeg',
      size: PNG_BYTES.byteLength,
      w: 1280,
      h: 960,
    });

    // The largest of the offered sizes was the one requested.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const getFileBody = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(getFileBody.file_id).toBe('big');

    // Bytes landed in R2 and the metadata row in D1, owned by the bot.
    const mediaId = String(content.url).split('/')[3];
    const stored = (env as any).__r2.store.get(mediaId);
    expect(stored).toBeTruthy();
    expect(new Uint8Array(stored.body)).toEqual(new Uint8Array(PNG_BYTES));
    expect(stored.httpMetadata?.contentType).toBe('image/jpeg');
    const rows = (env.DB as any).mediaRows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: TG_BOT,
      content_type: 'image/jpeg',
      content_length: PNG_BYTES.byteLength,
      filename: 'photo.jpg',
    });
  });

  it('image documents relay as m.image with the caption as body', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(tgFileFetch(PNG_BYTES, 'image/png'));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 201,
      message: {
        message_id: 10,
        from: { id: 7, first_name: 'Ivan', username: 'ivan' },
        chat: { id: 4711, type: 'private' },
        document: { file_id: 'doc1', mime_type: 'image/png', file_name: 'meme.png', file_size: 500 },
        caption: 'lol',
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const [, , , type, content] = performSendEvent.mock.calls[0];
    expect(type).toBe('m.room.message');
    expect(content.msgtype).toBe('m.image');
    expect(content.body).toBe('[TG] Ivan (@ivan): lol');
    expect(content.info.mimetype).toBe('image/png');
    const rows = (env.DB as any).mediaRows;
    expect(rows[0].filename).toBe('meme.png');
  });

  it('static webp stickers relay as m.sticker events', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(tgFileFetch(new Uint8Array([1, 2]).buffer, 'image/webp'));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 202,
      message: {
        message_id: 11,
        from: { id: 7, first_name: 'Ivan', username: 'ivan' },
        chat: { id: 4711, type: 'private' },
        sticker: { file_id: 'stk1', mime_type: 'image/webp', width: 512, height: 512, file_size: 900, emoji: 'cat' },
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const [, , , type, content] = performSendEvent.mock.calls[0];
    expect(type).toBe('m.sticker');
    expect(content.msgtype).toBeUndefined();
    expect(content.emoji).toBe('cat');
    expect(String(content.url)).toMatch(/^mxc:\/\/example\.com\//);
    expect(content.info).toMatchObject({ mimetype: 'image/webp', w: 512, h: 512 });
  });

  it('photos without a caption use the filename in the body', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(tgFileFetch(PNG_BYTES));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 203,
      message: {
        message_id: 12,
        from: { id: 7, first_name: 'Ivan' },
        chat: { id: 4711, type: 'private' },
        photo: [{ file_id: 'only', width: 640, height: 480, file_size: 2000 }],
      },
    });
    expect(performSendEvent.mock.calls[0][4].body).toBe('[TG] Ivan: photo.jpg');
  });

  it('files over the bot download cap stay placeholders and never fetch', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 204,
      message: {
        message_id: 13,
        from: { id: 7, first_name: 'Ivan' },
        chat: { id: 4711, type: 'private' },
        photo: [{ file_id: 'huge', width: 800, height: 600, file_size: 25 * 1024 * 1024 }],
        caption: 'too big',
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    expect(performSendEvent.mock.calls[0][4].body).toBe('[TG] Ivan: [telegram photo] too big');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((env.DB as any).mediaRows).toHaveLength(0);
  });

  it('download failures fall back to the placeholder instead of dropping the message', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(async () => Response.json({ ok: false, description: 'nope' }));
    await processTelegramUpdate(env, bridge as any, {
      update_id: 205,
      message: {
        message_id: 14,
        from: { id: 7, first_name: 'Ivan' },
        chat: { id: 4711, type: 'private' },
        photo: [{ file_id: 'f', width: 800, height: 600, file_size: 2000 }],
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    expect(performSendEvent.mock.calls[0][4].body).toBe('[TG] Ivan: [telegram photo]');
    expect((env.DB as any).mediaRows).toHaveLength(0);
  });

  // --- Matrix -> Telegram ---

  it('matrix m.image relays via sendPhoto with a caption and the bytes', async () => {
    const env = makeEnv();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    (env as any).__r2.store.set('m1', {
      body: bytes,
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { filename: 'cat.png' },
    });
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.image',
      body: 'cat.png',
      url: `mxc://${SERVER}/m1`,
      info: { mimetype: 'image/png', size: 3 },
    }, 'local');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/sendPhoto');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('4711');
    expect(form.get('caption')).toBe('Alice Display: cat.png');
    const photo = form.get('photo') as File;
    expect(photo).toBeTruthy();
    expect(photo.name).toBe('cat.png');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it('remote-server images are fetched through the federation media path', async () => {
    const env = makeEnv();
    fetchRemoteMediaMock.mockImplementation(async () => ({
      body: new Uint8Array([9, 9, 9]).buffer,
      contentType: 'image/jpeg',
      filename: 'remote.jpg',
    }));
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.image',
      body: 'remote.jpg',
      url: 'mxc://peer.test/abc',
      info: { mimetype: 'image/jpeg' },
    }, 'federated');

    expect(fetchRemoteMediaMock).toHaveBeenCalledWith(env, 'peer.test', 'abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/sendPhoto');
    const form = init.body as FormData;
    expect(form.get('caption')).toBe('Alice Display: remote.jpg');
    expect((form.get('photo') as File).name).toBe('remote.jpg');
  });

  it('SVGs and >10MB images go out as documents, not photos', async () => {
    const env = makeEnv();
    (env as any).__r2.store.set('svg1', {
      body: new Uint8Array([1]).buffer,
      httpMetadata: { contentType: 'image/svg+xml' },
    });
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.image',
      body: 'pic.svg',
      url: `mxc://${SERVER}/svg1`,
      info: { mimetype: 'image/svg+xml' },
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/sendDocument');
    expect((init.body as FormData).get('document')).toBeTruthy();

    const env2 = makeEnv();
    const big = new Uint8Array(11 * 1024 * 1024).buffer;
    (env2 as any).__r2.store.set('big1', { body: big, httpMetadata: { contentType: 'image/png' } });
    await handleRoomMessage(env2, ROOM, USER, {
      msgtype: 'm.image',
      body: 'big.png',
      url: `mxc://${SERVER}/big1`,
      info: { mimetype: 'image/png' },
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toContain('/sendDocument');
  });

  it('unresolvable media falls back to a text notice instead of silence', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.image',
      body: 'gone.png',
      url: `mxc://${SERVER}/missing`,
      info: { mimetype: 'image/png' },
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/sendMessage');
    expect(String(init.body)).toContain('[image] gone.png');
  });

  it('images sent by the bridge bot never loop back to Telegram', async () => {
    const env = makeEnv();
    (env as any).__r2.store.set('m1', { body: new Uint8Array([1]).buffer, httpMetadata: { contentType: 'image/png' } });
    await handleRoomMessage(env, ROOM, TG_BOT, {
      msgtype: 'm.image',
      body: 'loop.png',
      url: `mxc://${SERVER}/m1`,
      info: { mimetype: 'image/png' },
    }, 'local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-image media (m.video) keeps the plain text relay', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.video',
      body: 'clip.mp4',
      url: `mxc://${SERVER}/v1`,
      info: { mimetype: 'video/mp4' },
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/sendMessage');
    expect(String(init.body)).toContain('Alice Display: clip.mp4');
  });
});

describe('telegram formatting relay', () => {
  const bridge = { id: 'tgb1', bot_user_id: TG_BOT, room_id: ROOM, chat_id: '4711', tg_token: '111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', webhook_secret: 's3cret', last_update_id: 0, enabled: 1, created_at: 1 };

  it('matrix formatted_body relays as Telegram HTML', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.text',
      body: 'Bold link',
      format: 'org.matrix.custom.html',
      formatted_body: '<strong>Bold <a href="https://google.com">link</a></strong>',
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/sendMessage');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.chat_id).toBe('4711');
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toBe('Alice Display: <b>Bold <a href="https://google.com">link</a></b>');
  });

  it('rejected formatting retries once as plain text', async () => {
    const env = makeEnv();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const p = JSON.parse(init.body as string);
      if (p.parse_mode === 'HTML') return Response.json({ ok: false, description: "can't parse entities" });
      return Response.json({ ok: true });
    });
    await handleRoomMessage(env, ROOM, USER, {
      msgtype: 'm.text',
      body: 'Bold link',
      format: 'org.matrix.custom.html',
      formatted_body: '<strong>Bold</strong>',
    }, 'local');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(first.parse_mode).toBe('HTML');
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toBe('Alice Display: Bold link');
  });

  it('plain matrix messages still send without parse_mode', async () => {
    const env = makeEnv();
    await handleRoomMessage(env, ROOM, USER, { body: 'plain **not bold**' }, 'local');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload.parse_mode).toBeUndefined();
    expect(payload.text).toBe('Alice Display: plain **not bold**');
  });

  it('telegram entities arrive as a Matrix formatted_body', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 300,
      message: {
        message_id: 21,
        from: { id: 7, first_name: 'Ivan', username: 'ivan' },
        chat: { id: 4711, type: 'private' },
        text: 'Bold link ok',
        entities: [
          { offset: 0, length: 9, type: 'bold' },
          { offset: 5, length: 4, type: 'text_link', url: 'https://google.com' },
        ],
      },
    });
    expect(performSendEvent).toHaveBeenCalledTimes(1);
    const content = performSendEvent.mock.calls[0][4];
    expect(content.body).toBe('[TG] Ivan (@ivan): Bold link ok');
    expect(content.format).toBe('org.matrix.custom.html');
    expect(content.formatted_body).toBe(
      '[TG] Ivan (@ivan): <b>Bold <a href="https://google.com">link</a></b> ok'
    );
  });

  it('telegram text without entities has no format field', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 301,
      message: {
        message_id: 22,
        from: { id: 7, first_name: 'Ivan' },
        chat: { id: 4711, type: 'private' },
        text: '__not parsed__',
      },
    });
    const content = performSendEvent.mock.calls[0][4];
    expect(content.body).toBe('[TG] Ivan: __not parsed__');
    expect(content.format).toBeUndefined();
    expect(content.formatted_body).toBeUndefined();
  });

  it('telegram entity offsets survive emoji (UTF-16 units)', async () => {
    const env = makeEnv();
    await processTelegramUpdate(env, bridge as any, {
      update_id: 302,
      message: {
        message_id: 23,
        from: { id: 7, first_name: 'Ivan' },
        chat: { id: 4711, type: 'private' },
        text: '🚀 go',
        entities: [{ offset: 3, length: 2, type: 'bold' }],
      },
    });
    const content = performSendEvent.mock.calls[0][4];
    expect(content.formatted_body).toBe('[TG] Ivan: 🚀 <b>go</b>');
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
