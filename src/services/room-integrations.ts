// Room message integrations: the single hook point where stored room
// messages reach native bots and bridges. Called from the local send
// pipeline and from the inbound federation /send path.
//
//   'local'     -> bot command processing + telegram relay
//   'federated' -> telegram relay only (commands are for local admins)
//
// Loop prevention is structural: bot replies re-enter the send pipeline with
// a BOT sender, and every integration here skips bot senders — so a
// Telegram-relayed message never bounces back to Telegram, and a bot's own
// replies never trigger commands. Never throws; never fails the send.

import type { Env } from '../types';
import { getEnabledBotsInRoom, isBotUser } from './bots';
import { tryHandleAdminCommand } from './bot-commands';
import { relayMatrixToTelegram } from './telegram-bridge';

export async function handleRoomMessage(
  env: Env,
  roomId: string,
  sender: string,
  content: Record<string, unknown> | undefined | null,
  source: 'local' | 'federated'
): Promise<void> {
  try {
    const body = typeof content?.body === 'string' ? content.body : null;
    if (!body) return;

    // Bot senders never trigger integrations (loop prevention).
    if (await isBotUser(env.DB, sender)) return;

    // Admin console commands. A consumed command is NOT relayed onward (a
    // "!admin token mint" in a bridged room must not leak to Telegram).
    if (source === 'local') {
      const bots = await getEnabledBotsInRoom(env.DB, roomId);
      let consumed = false;
      for (const bot of bots) {
        if (bot.kind !== 'admin') continue;
        const reply = await tryHandleAdminCommand(env, bot, roomId, sender, body);
        if (reply !== null) {
          consumed = true;
          const { performSendEvent } = await import('../api/rooms');
          const result = await performSendEvent(
            env,
            roomId,
            bot.user_id,
            'm.room.message',
            { msgtype: 'm.notice', body: reply },
            `botreply-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
          );
          if ('error' in result) {
            console.error('[room-integrations] bot reply failed:', result.error.errcode);
          }
        }
      }
      if (consumed) return;
    }

    // Telegram relay (both directions of the bridge share this hook).
    await relayMatrixToTelegram(env, roomId, sender, body);
  } catch (err) {
    console.error('[room-integrations] hook failed:', err);
  }
}
