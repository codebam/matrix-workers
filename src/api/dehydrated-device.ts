// Dehydrated device endpoints (MSC3814 v2) — unstable prefix.
//
// Element's DehydratedDeviceManager probes GET /dehydrated_device for server
// support: M_UNRECOGNIZED means unsupported (it then skips dehydration),
// M_NOT_FOUND means supported with no device present, and a 200 returns the
// stored device. Creating a device PUTs its device_data (opaque, encrypted
// client-side) together with its public device keys, one-time keys and
// fallback keys; the device then behaves like a real device for /keys/query
// and to-device routing. Rehydration pages queued to-device messages via
// /{device_id}/events — the js-sdk issues GET with ?from=, so both GET and
// POST (body.from) are accepted.
//
// The server keeps a single slot per user: a new PUT replaces the previous
// device (Element rotates dehydrated devices periodically) and DELETE
// removes it.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Env } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { generateOpaqueId } from '../utils/ids';
import { createDevice, deleteDevice } from '../services/database';
import { putDeviceKeysToDO, deleteDeviceKeysFromDO, recordKeyChange } from './keys';

const app = new Hono<AppEnv>();

const PREFIX = '/_matrix/client/unstable/org.matrix.msc3814.v1';

interface DehydratedDeviceRow {
  user_id: string;
  device_id: string;
  device_data: string;
  display_name: string | null;
  created_at: number;
}

async function getDehydratedDeviceRow(
  db: D1Database,
  userId: string
): Promise<DehydratedDeviceRow | null> {
  return await db.prepare(
    `SELECT user_id, device_id, device_data, display_name, created_at
     FROM dehydrated_devices WHERE user_id = ?`
  ).bind(userId).first<DehydratedDeviceRow>();
}

/**
 * Remove every trace of a dehydrated device: its keys (Durable Object is the
 * source of truth for /keys/query), its cached copies, its device row and its
 * one-time keys. The slot row itself is removed by the caller.
 */
async function purgeDehydratedDevice(env: Env, userId: string, deviceId: string): Promise<void> {
  const db = env.DB;

  await deleteDeviceKeysFromDO(env, userId, deviceId);
  await env.DEVICE_KEYS.delete(`device:${userId}:${deviceId}`);
  await env.ONE_TIME_KEYS.delete(`otk:${userId}:${deviceId}`);

  // NOTE: there is no `device_keys` D1 table (device keys live only in the
  // UserKeys Durable Object), so nothing else to delete here.
  await db.prepare(`DELETE FROM one_time_keys WHERE user_id = ? AND device_id = ?`).bind(userId, deviceId).run();
  await deleteDevice(db, userId, deviceId);
  await recordKeyChange(db, userId, deviceId, 'delete');
}

/** Store uploaded one-time keys the same way POST /keys/upload does. */
async function storeOneTimeKeys(
  env: Env,
  userId: string,
  deviceId: string,
  oneTimeKeys: Record<string, unknown>
): Promise<void> {
  const existingKeys = await env.ONE_TIME_KEYS.get(
    `otk:${userId}:${deviceId}`,
    'json'
  ) as Record<string, { keyId: string; keyData: unknown; claimed: boolean }[]> | null || {};

  for (const [keyId, keyData] of Object.entries(oneTimeKeys)) {
    const [algorithm] = keyId.split(':');

    if (!existingKeys[algorithm]) {
      existingKeys[algorithm] = [];
    }

    const entry = { keyId, keyData, claimed: false };
    const existingIndex = existingKeys[algorithm].findIndex(k => k.keyId === keyId);
    if (existingIndex >= 0) {
      existingKeys[algorithm][existingIndex] = entry;
    } else {
      existingKeys[algorithm].push(entry);
    }

    await env.DB.prepare(`
      INSERT INTO one_time_keys (user_id, device_id, algorithm, key_id, key_data)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, device_id, algorithm, key_id) DO UPDATE SET
        key_data = excluded.key_data
    `).bind(userId, deviceId, algorithm, keyId, JSON.stringify(keyData)).run();
  }

  await env.ONE_TIME_KEYS.put(
    `otk:${userId}:${deviceId}`,
    JSON.stringify(existingKeys)
  );
}

// GET /.../dehydrated_device - Return the stored dehydrated device (404 M_NOT_FOUND when absent)
app.get(`${PREFIX}/dehydrated_device`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const row = await getDehydratedDeviceRow(c.env.DB, userId);
  if (!row) {
    return Errors.notFound('No dehydrated device available').toResponse();
  }
  return c.json({
    device_id: row.device_id,
    device_data: JSON.parse(row.device_data),
  });
});

// PUT /.../dehydrated_device - Create or replace the dehydrated device
app.put(`${PREFIX}/dehydrated_device`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;

  let body: {
    device_id?: string;
    device_data?: Record<string, unknown>;
    device_keys?: {
      user_id?: string;
      device_id?: string;
      unsigned?: { device_display_name?: string };
    } & Record<string, unknown>;
    one_time_keys?: Record<string, unknown>;
    fallback_keys?: Record<string, unknown>;
    initial_device_display_name?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  if (!body.device_data || typeof body.device_data !== 'object') {
    return Errors.missingParam('device_data').toResponse();
  }
  if (!body.device_keys || typeof body.device_keys !== 'object') {
    return Errors.missingParam('device_keys').toResponse();
  }

  const deviceId = typeof body.device_id === 'string' && body.device_id.length > 0
    ? body.device_id
    : await generateOpaqueId(16);

  if (body.device_keys.user_id !== userId || body.device_keys.device_id !== deviceId) {
    return Errors.invalidParam(
      'device_keys',
      'device_keys.user_id and device_keys.device_id must match the authenticated user and the requested device_id'
    ).toResponse();
  }

  // Single slot: a new upload replaces the previous dehydrated device.
  const existing = await getDehydratedDeviceRow(db, userId);
  if (existing && existing.device_id !== deviceId) {
    await purgeDehydratedDevice(c.env, userId, existing.device_id);
  }

  const displayName =
    body.initial_device_display_name ||
    body.device_keys.unsigned?.device_display_name ||
    'Dehydrated device';

  await db.prepare(`
    INSERT INTO dehydrated_devices (user_id, device_id, device_data, display_name, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      device_id = excluded.device_id,
      device_data = excluded.device_data,
      display_name = excluded.display_name,
      created_at = excluded.created_at
  `).bind(userId, deviceId, JSON.stringify(body.device_data), displayName, Date.now()).run();

  // Make it a first-class device: visible in the device list, keys served by
  // /keys/query (device keys live in the UserKeys Durable Object) and
  // routable for to-device messages (needed for rehydration).
  await db.prepare(`DELETE FROM devices WHERE user_id = ? AND device_id = ?`).bind(userId, deviceId).run();
  await createDevice(db, userId, deviceId, displayName);
  await putDeviceKeysToDO(c.env, userId, deviceId, body.device_keys);
  await c.env.DEVICE_KEYS.put(`device:${userId}:${deviceId}`, JSON.stringify(body.device_keys));
  await recordKeyChange(db, userId, deviceId, 'update');

  if (body.one_time_keys && typeof body.one_time_keys === 'object') {
    await storeOneTimeKeys(c.env, userId, deviceId, body.one_time_keys);
  }

  return c.json({ device_id: deviceId });
});

// DELETE /.../dehydrated_device - Remove the dehydrated device
app.delete(`${PREFIX}/dehydrated_device`, requireAuth(), async (c) => {
  const userId = c.get('userId');
  const row = await getDehydratedDeviceRow(c.env.DB, userId);
  if (!row) {
    return Errors.notFound('No dehydrated device available').toResponse();
  }

  await purgeDehydratedDevice(c.env, userId, row.device_id);
  await c.env.DB.prepare(`DELETE FROM dehydrated_devices WHERE user_id = ?`).bind(userId).run();

  return c.json({ device_id: row.device_id });
});

// GET/POST /.../dehydrated_device/{device_id}/events - Page queued to-device events
async function handleDehydratedEvents(c: Context<AppEnv>, bodyFrom: string | undefined) {
  const userId = c.get('userId');
  const deviceId = c.req.param('device_id');
  const db = c.env.DB;

  const row = await getDehydratedDeviceRow(db, userId);
  if (!row || row.device_id !== deviceId) {
    return Errors.notFound('No dehydrated device available').toResponse();
  }

  const from = bodyFrom ?? c.req.query('from');
  let sincePos = 0;
  if (from) {
    const parsed = parseInt(from, 10);
    if (!isNaN(parsed) && parsed > 0) {
      sincePos = parsed;
    }
  }

  const PAGE_SIZE = 100;
  const rows = await db.prepare(`
    SELECT sender_user_id, event_type, content, stream_position
    FROM to_device_messages
    WHERE recipient_user_id = ?
      AND recipient_device_id = ?
      AND stream_position > ?
    ORDER BY stream_position ASC
    LIMIT ?
  `).bind(userId, deviceId, sincePos, PAGE_SIZE).all<{
    sender_user_id: string;
    event_type: string;
    content: string;
    stream_position: number;
  }>();

  const events = rows.results.map(r => {
    let content: unknown = {};
    try {
      content = JSON.parse(r.content);
    } catch {
      // Keep an empty content object rather than failing the whole page.
    }
    return { sender: r.sender_user_id, type: r.event_type, content };
  });

  const responseBody: { events: unknown[]; next_batch?: string } = { events };
  if (rows.results.length === PAGE_SIZE) {
    responseBody.next_batch = String(rows.results[rows.results.length - 1].stream_position);
  }

  return c.json(responseBody);
}

app.get(`${PREFIX}/dehydrated_device/:device_id/events`, requireAuth(), async (c) => {
  return handleDehydratedEvents(c, undefined);
});

app.post(`${PREFIX}/dehydrated_device/:device_id/events`, requireAuth(), async (c) => {
  let from: string | undefined;
  try {
    const body = await c.req.json() as { from?: string };
    if (body && typeof body.from === 'string') {
      from = body.from;
    }
  } catch {
    // Empty or non-JSON bodies are treated as "from the start".
  }
  return handleDehydratedEvents(c, from);
});

export default app;
