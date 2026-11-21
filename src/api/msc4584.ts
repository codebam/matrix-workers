// MSC4584: Soft-ignoring
// https://github.com/matrix-org/matrix-spec-proposals/pull/4584
//
// The MSC defines a global account data event, not a new HTTP endpoint.
// Before stabilisation clients use the unstable event type below with the
// ordinary account data API. This module owns that unstable type: it validates
// the config at the write boundary, stores it in the same D1 table the
// existing account data API uses, and exposes pure helpers for resolving the
// soft-ignored entity sets.
//
// Register this app BEFORE the generic accountData app in src/index.ts so the
// validated write path wins for this one event type.

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors, MatrixApiError } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { notifyUserSync } from '../services/database';

/** Unstable account data event type defined by MSC4584. */
export const SOFT_IGNORE_CONFIG_EVENT_TYPE = 'net.f0rest.msc4584.soft_ignore_config';

export type SoftIgnoreDecision = 'allow' | 'ignore';

export interface SoftIgnoreConfig {
  enabled: boolean;
  users: Record<string, SoftIgnoreDecision>;
  rooms: Record<string, SoftIgnoreDecision>;
  servers: Record<string, 'ignore'>;
}

export interface ResolvedSoftIgnore {
  users: Set<string>;
  rooms: Set<string>;
}

const USER_ID_RE = /^@[^\s:]+:.+$/;
const ROOM_ID_RE = /^![^\s:]+:.+$/;
// Server names may be a DNS name or an IP literal (including bracketed IPv6),
// optionally followed by a port.
const SERVER_NAME_RE = /^(?:\[[0-9a-fA-F:.]+\]|[^\s/:]+)(?::[0-9]{1,5})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecisions(
  value: unknown,
  field: string,
  keyPattern: RegExp,
  serversOnly: boolean
): Record<string, SoftIgnoreDecision> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw Errors.invalidParam(field, `${field} must be an object`);
  }

  const decisions: Record<string, SoftIgnoreDecision> = {};
  for (const [key, rawDecision] of Object.entries(value)) {
    if (!keyPattern.test(key)) {
      throw Errors.invalidParam(field, `Invalid entity key in ${field}: ${key}`);
    }
    // The MSC's value list defines "ignore" and "allow"; its resolution steps
    // refer to "deny". Accept both spellings of the negative decision so a
    // config written against either revision resolves predictably.
    if (rawDecision === 'ignore' || (!serversOnly && rawDecision === 'deny')) {
      decisions[key] = 'ignore';
    } else if (!serversOnly && rawDecision === 'allow') {
      decisions[key] = 'allow';
    } else {
      throw Errors.invalidParam(field, `Invalid decision for ${key}: expected allow or ignore`);
    }
  }
  return decisions;
}

/**
 * Validate and normalise soft-ignore account data. Missing maps default to
 * {} and missing `enabled` defaults to true, as specified by MSC4584.
 * Throws MatrixApiError on invalid input.
 */
export function parseSoftIgnoreConfig(content: unknown): SoftIgnoreConfig {
  if (!isRecord(content)) {
    throw Errors.invalidParam('content', 'Soft-ignore config must be a JSON object');
  }

  const enabled = content.enabled === undefined ? true : content.enabled;
  if (typeof enabled !== 'boolean') {
    throw Errors.invalidParam('enabled', 'enabled must be a boolean');
  }

  const users = parseDecisions(content.users, 'users', USER_ID_RE, false);
  const rooms = parseDecisions(content.rooms, 'rooms', ROOM_ID_RE, false);
  const servers = parseDecisions(content.servers, 'servers', SERVER_NAME_RE, true);

  return {
    enabled,
    users,
    rooms,
    servers: servers as Record<string, 'ignore'>,
  };
}

function serverNameOf(userId: string): string {
  return userId.slice(userId.indexOf(':') + 1);
}

/**
 * Resolve the soft-ignored user and room sets. MSC4584's resolution steps say
 * "include all users listed as allow / exclude any listed as deny", which
 * contradicts its own value definitions ("ignore" soft-ignores, "allow" does
 * not). This follows the value definitions: ignore/deny entries are ignored,
 * allow entries override them, and ignored servers exclude their users.
 */
export function resolveSoftIgnore(config: SoftIgnoreConfig): ResolvedSoftIgnore {
  const ignoredServers = new Set(
    Object.entries(config.servers)
      .filter(([, decision]) => decision === 'ignore')
      .map(([server]) => server)
  );

  const ignored = (entries: [string, SoftIgnoreDecision][]): Set<string> => {
    const result = new Set<string>();
    for (const [entity, decision] of entries) {
      if (decision === 'ignore') result.add(entity);
    }
    return result;
  };

  if (!config.enabled) return { users: new Set(), rooms: new Set() };

  return {
    users: new Set(
      [...ignored(Object.entries(config.users))].filter(
        (userId) => !ignoredServers.has(serverNameOf(userId))
      )
    ),
    rooms: ignored(Object.entries(config.rooms)),
  };
}

// ---------------------------------------------------------------------------
// Validated account data routes (must be mounted before generic accountData)
// ---------------------------------------------------------------------------

const app = new Hono<AppEnv>();

const GLOBAL_PATH =
  '/_matrix/client/v3/user/:userId/account_data/net.f0rest.msc4584.soft_ignore_config';

async function recordChange(
  db: D1Database,
  userId: string,
  eventType: string
): Promise<void> {
  await db.prepare(`
    UPDATE stream_positions SET position = position + 1 WHERE stream_name = ?
  `).bind('account_data').run();

  const position = await db.prepare(`
    SELECT position FROM stream_positions WHERE stream_name = ?
  `).bind('account_data').first<{ position: number }>();

  await db.prepare(`
    INSERT INTO account_data_changes (user_id, room_id, event_type, stream_position)
    VALUES (?, '', ?, ?)
  `).bind(userId, eventType, position?.position ?? 1).run();
}

app.get(GLOBAL_PATH, requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  if (requestingUserId !== targetUserId) {
    return Errors.forbidden('Cannot access other users account data').toResponse();
  }

  const row = await c.env.DB.prepare(`
    SELECT content FROM account_data
    WHERE user_id = ? AND event_type = ? AND room_id = ''
  `).bind(targetUserId, SOFT_IGNORE_CONFIG_EVENT_TYPE).first<{ content: string }>();

  if (!row) return Errors.notFound('Account data not found').toResponse();

  try {
    return c.json(JSON.parse(row.content));
  } catch {
    return c.json({});
  }
});

app.put(GLOBAL_PATH, requireAuth(), async (c) => {
  const requestingUserId = c.get('userId');
  const targetUserId = decodeURIComponent(c.req.param('userId'));
  if (requestingUserId !== targetUserId) {
    return Errors.forbidden('Cannot modify other users account data').toResponse();
  }

  let content: unknown;
  try {
    content = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  try {
    parseSoftIgnoreConfig(content);
  } catch (error) {
    if (error instanceof MatrixApiError) return error.toResponse();
    throw error;
  }

  await c.env.DB.prepare(`
    INSERT INTO account_data (user_id, room_id, event_type, content)
    VALUES (?, '', ?, ?)
    ON CONFLICT (user_id, room_id, event_type) DO UPDATE SET
      content = excluded.content
  `).bind(targetUserId, SOFT_IGNORE_CONFIG_EVENT_TYPE, JSON.stringify(content)).run();

  await recordChange(c.env.DB, targetUserId, SOFT_IGNORE_CONFIG_EVENT_TYPE);
  await notifyUserSync(c.env, targetUserId, 'account_data');

  return c.json({});
});

export default app;
