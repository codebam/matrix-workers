// Application-service event fanout.
//
// Every stored event (local or federated) is offered to each registered
// appservice whose namespaces match. Delivery is best-effort and isolated
// per appservice: a broken or slow bridge must never fail the originating
// client/federation request. sendAppServiceTransaction bounds each delivery
// with a fetch timeout and records the transaction for retry bookkeeping.

import type { Env, PDU } from '../types';
import { getReceiptsForRoom } from '../api/receipts';
import { getTypingUsers } from '../api/typing';
import {
  getAppServices,
  getInterestedAppServices,
  sendAppServiceTransaction,
  type AppServiceRegistration,
} from './appservice';

// Ephemeral state lives in the Room DO; to-device messages live in D1. Both
// lookups are best-effort — a bridge must never break the originating request.
async function collectRoomEphemeral(
  env: Env,
  roomId: string
): Promise<Record<string, unknown>[]> {
  const ephemeral: Record<string, unknown>[] = [];

  try {
    const userIds = await getTypingUsers(env, roomId);
    if (Array.isArray(userIds) && userIds.length > 0) {
      ephemeral.push({ type: 'm.typing', room_id: roomId, content: { user_ids: userIds } });
    }
  } catch (err) {
    console.warn('[appservice] fanout: typing unavailable:', err);
  }

  try {
    const receipts = await getReceiptsForRoom(env, roomId);
    const visible: typeof receipts.content = {};
    for (const [eventId, receiptTypes] of Object.entries(receipts.content ?? {})) {
      for (const [receiptType, users] of Object.entries(receiptTypes)) {
        // m.read.private is only visible to its owner, never to a bridge.
        if (receiptType === 'm.read.private') continue;
        visible[eventId] = visible[eventId] ?? {};
        visible[eventId][receiptType] = users;
      }
    }
    if (Object.keys(visible).length > 0) {
      ephemeral.push({ type: 'm.receipt', room_id: roomId, content: visible });
    }
  } catch (err) {
    console.warn('[appservice] fanout: receipts unavailable:', err);
  }

  return ephemeral;
}

// Deliver pending to-device messages addressed to users in this AS's user
// namespaces. Messages are only read, never acknowledged — the sync delivery
// path remains responsible for marking them delivered.
async function collectToDeviceForAppService(
  db: Env['DB'],
  as: AppServiceRegistration
): Promise<Record<string, unknown>[]> {
  if (as.namespaces.users.length === 0) return [];
  try {
    const pending = await db.prepare(`
      SELECT recipient_user_id, sender_user_id, event_type, content
      FROM to_device_messages
      WHERE delivered = 0
      ORDER BY stream_position ASC
      LIMIT 100
    `).all<{
      recipient_user_id: string;
      sender_user_id: string;
      event_type: string;
      content: string;
    }>();

    const toDevice: Record<string, unknown>[] = [];
    for (const msg of pending.results) {
      if (!as.namespaces.users.some(ns => new RegExp(ns.regex).test(msg.recipient_user_id))) {
        continue;
      }
      toDevice.push({
        type: msg.event_type,
        sender: msg.sender_user_id,
        content: JSON.parse(msg.content),
      });
    }
    return toDevice;
  } catch (err) {
    console.warn(`[appservice] fanout: to_device unavailable for ${as.id}:`, err);
    return [];
  }
}

export async function fanoutEventToAppServices(env: Env, event: PDU): Promise<void> {
  let services;
  try {
    services = await getAppServices(env.DB);
  } catch (err) {
    // Registration table absent (minimal deployment) — nothing to deliver.
    console.warn('[appservice] fanout: cannot list registrations:', err);
    return;
  }
  if (services.length === 0) return;

  const interested = getInterestedAppServices(services, event);
  if (interested.length === 0) return;

  const ephemeral = await collectRoomEphemeral(env, event.room_id);
  for (const as of interested) {
    try {
      const toDevice = await collectToDeviceForAppService(env.DB, as);
      await sendAppServiceTransaction(env.DB, as, [event as unknown as Record<string, unknown>], {
        ephemeral,
        to_device: toDevice,
      });
    } catch (err) {
      console.error(`[appservice] fanout to ${as.id} failed:`, err);
    }
  }
}