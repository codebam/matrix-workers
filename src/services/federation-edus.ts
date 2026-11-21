// Outbound ephemeral data units (EDUs) for client actions in a room.
//
// Mirrors the best-effort federation fan-out in src/api/presence.ts: typing and
// receipts are ephemeral, so they go to the Federation DO's /send-edu queue
// (same queue presence uses) rather than through PDU preparation. A queueing
// failure must never fail the client request that triggered the EDU.

import type { Env } from '../types';
import { getStateEvent } from './database';
import { isServerAllowedByAcl, type ServerAclContent } from './server-acl';

// Servers other than ours with at least one joined member in the room.
// Mirrors rooms.ts getJoinedRemoteServers, including the room's server ACL:
// denied servers get no visibility into our live typing/read state either.
export async function getFederationDestinationsForRoom(
  db: D1Database,
  roomId: string,
  localServerName: string
): Promise<string[]> {
  const { results } = await db.prepare(
    `SELECT DISTINCT user_id FROM room_memberships WHERE room_id = ? AND membership = 'join'`
  ).bind(roomId).all<{ user_id: string }>();

  const servers = new Set<string>();
  for (const row of results || []) {
    const server = row.user_id?.split(':')[1];
    if (server && server !== localServerName) servers.add(server);
  }
  if (servers.size === 0) return [];

  try {
    const aclEvent = await getStateEvent(db, roomId, 'm.room.server_acl', '');
    if (aclEvent) {
      const acl = aclEvent.content as ServerAclContent;
      return [...servers].filter((s) => isServerAllowedByAcl(acl, s));
    }
  } catch (aclErr) {
    // Same posture as rooms.ts: a broken ACL lookup must not block delivery.
    console.warn('[federation-edu] ACL destination filter failed; sending to all joined servers:', aclErr);
  }
  return [...servers];
}

// Best-effort: resolves without throwing even if destinations, DO stubs or
// individual queueing calls fail. Callers can await it after their local state
// update without risking the client request.
export async function queueFederationEdu(
  env: Env,
  roomId: string,
  eduType: string,
  content: Record<string, unknown>
): Promise<void> {
  try {
    const destinations = await getFederationDestinationsForRoom(env.DB, roomId, env.SERVER_NAME);
    if (destinations.length === 0) return;

    const results = await Promise.allSettled(
      destinations.map((destination) => {
        const fedDO = env.FEDERATION.get(env.FEDERATION.idFromName(destination));
        return fedDO.fetch(new Request('http://internal/send-edu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination, edu_type: eduType, content }),
        }));
      })
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.warn(`[federation-edu] Failed to queue ${eduType} EDU for ${destinations[index]}:`, result.reason);
      }
    });
  } catch (err) {
    console.warn(`[federation-edu] Failed to queue ${eduType} EDUs for ${roomId}:`, err);
  }
}
