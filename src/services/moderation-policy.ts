// Moderation policy lists — spec module "Moderation policy lists"
// (stable long before v1.19; the module defines the data, enforcement is
// deliberately an implementation detail).
//
// A subscription points the server at a policy room (joined by a dedicated
// local system user). m.ban rules in that room's state are enforced at
// the server's own gates, per the spec's suggested simple
// implementation:
//   - user rule  -> the user's invites to our users are refused
//   - server rule -> the server's PDUs and invites are refused (ACL
//                    posture), and our users cannot invite them
//   - room rule   -> our users cannot join or be invited into the room
//
// Rules are cached per room (5 minutes) — lists change rarely and arrive
// over federation with no local write hook to invalidate on.

import type { PDU } from '../types';

export interface PolicyRule {
  entity: string;
  reason: string;
  kind: 'user' | 'room' | 'server';
}

export interface PolicyRules {
  users: PolicyRule[];
  rooms: PolicyRule[];
  servers: PolicyRule[];
  subscriptions: number;
}

const POLICY_RULE_TYPES = new Set([
  'm.policy.rule.user',
  'm.policy.rule.room',
  'm.policy.rule.server',
]);

const RULE_CACHE_TTL_MS = 5 * 60 * 1000;

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

function matchesRule(rule: PolicyRule, value: string): boolean {
  try {
    return globToRegExp(rule.entity).test(value);
  } catch {
    return false;
  }
}

export function parsePolicyRule(
  kind: PolicyRule['kind'],
  content: unknown
): PolicyRule | null {
  if (!content || typeof content !== 'object') return null;
  const { entity, reason, recommendation } = content as Record<string, unknown>;
  if (typeof entity !== 'string' || !entity) return null;
  if (recommendation !== 'm.ban') return null; // only m.ban is specified
  return {
    entity,
    reason: typeof reason === 'string' ? reason : '',
    kind,
  };
}

const EMPTY_RULES: PolicyRules = { users: [], rooms: [], servers: [], subscriptions: 0 };

// Active rules across all enabled subscriptions. Cached in the CACHE KV
// namespace; a stale window of up to RULE_CACHE_TTL_MS is acceptable for
// moderation lists (they arrive via federation with no local hook).
export async function getActivePolicyRules(
  db: D1Database,
  cache?: KVNamespace
): Promise<PolicyRules> {
  let subs: Array<{ room_id: string }> = [];
  try {
    const rows = await db
      .prepare(`SELECT room_id FROM policy_list_subscriptions WHERE enabled = 1`)
      .all<{ room_id: string }>();
    subs = rows.results ?? [];
  } catch {
    // Table not migrated yet (pre-028 deployments): no subscriptions.
    return EMPTY_RULES;
  }
  if (subs.length === 0) return EMPTY_RULES;

  if (cache) {
    try {
      const cached = await cache.get('policy-rules:v1', 'json');
      if (cached) return cached as PolicyRules;
    } catch {
      // fall through to fresh read
    }
  }

  const rules: PolicyRules = { users: [], rooms: [], servers: [], subscriptions: subs.length };
  for (const sub of subs) {
    let stateRows: Array<{ event_type: string; content: string }>;
    try {
      const rows = await db
        .prepare(
          `SELECT e.event_type AS event_type, e.content AS content
           FROM room_state rs
           JOIN events e ON rs.event_id = e.event_id
           WHERE rs.room_id = ? AND rs.event_type IN
             ('m.policy.rule.user', 'm.policy.rule.room', 'm.policy.rule.server')`
        )
        .bind(sub.room_id)
        .all<{ event_type: string; content: string }>();
      stateRows = rows.results ?? [];
    } catch {
      continue;
    }
    for (const row of stateRows) {
      if (!POLICY_RULE_TYPES.has(row.event_type)) continue;
      const kind = row.event_type.endsWith('.user')
        ? 'user'
        : row.event_type.endsWith('.room')
          ? 'room'
          : 'server';
      let content: unknown;
      try {
        content = JSON.parse(row.content);
      } catch {
        continue;
      }
      const rule = parsePolicyRule(kind, content);
      if (rule) rules[`${kind}s` as 'users' | 'rooms' | 'servers'].push(rule);
    }
  }

  if (cache) {
    try {
      await cache.put('policy-rules:v1', JSON.stringify(rules), {
        expirationTtl: Math.ceil(RULE_CACHE_TTL_MS / 1000),
      });
    } catch {
      // cache write is best-effort
    }
  }

  return rules;
}

export function isUserBannedByPolicy(
  rules: PolicyRules,
  userId: string
): PolicyRule | null {
  return rules.users.find((r) => matchesRule(r, userId)) ?? null;
}

// Server rules are matched case-insensitively against the bare server
// name (ports stripped), matching the ACL layer's posture.
export function isServerBannedByPolicy(
  rules: PolicyRules,
  rawServerName: string
): PolicyRule | null {
  const server = rawServerName.split(':')[0].toLowerCase();
  return rules.servers.find((r) => matchesRule({ ...r, entity: r.entity.toLowerCase() }, server)) ?? null;
}

// Room rules match room IDs or aliases; the caller resolves aliases.
export function isRoomBannedByPolicy(
  rules: PolicyRules,
  roomIdOrAlias: string
): PolicyRule | null {
  return rules.rooms.find((r) => matchesRule(r, roomIdOrAlias)) ?? null;
}

// Invalidate the cached rules (used by the admin API when a
// subscription changes, so enforcement is immediate).
export async function invalidatePolicyRulesCache(cache?: KVNamespace): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete('policy-rules:v1');
  } catch {
    // best-effort
  }
}

// Convenience for callers with a roomState array (tests, future hooks).
export function rulesFromState(roomState: PDU[]): PolicyRules {
  const rules: PolicyRules = { users: [], rooms: [], servers: [], subscriptions: 1 };
  for (const event of roomState) {
    if (!POLICY_RULE_TYPES.has(event.type)) continue;
    const kind = event.type.endsWith('.user')
      ? 'user'
      : event.type.endsWith('.room')
        ? 'room'
        : 'server';
    const rule = parsePolicyRule(kind, event.content);
    if (rule) rules[`${kind}s` as 'users' | 'rooms' | 'servers'].push(rule);
  }
  return rules;
}
