// Server ACLs for rooms — spec module "Server Access Control Lists (ACLs)
// for rooms"; case-insensitive glob matching per MSC4436 (spec v1.19).
//
// ACLs act at the network layer, not the event-auth layer: denied servers
// must not be able to interact with the room at all (their PDUs rejected,
// their joins and invites refused). Every participating server is expected
// to uphold the ACL, so the checks below run on our receive paths as well
// as our client send paths.

import type { PDU } from '../types';
import { getStateEvent } from './database';

export interface ServerAclContent {
  allow?: unknown;
  deny?: unknown;
  allow_ip_literals?: unknown;
}

// Glob → RegExp, matching the repo's MSC4155 glob semantics: '*' spans
// segments, '?' is a single char, everything else is literal.
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

function matchesAnyGlob(globs: string[], value: string): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

function asGlobList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((g): g is string => typeof g === 'string');
}

// Strip the port before ACL matching: "evil.com:8448" matches rules for
// "evil.com". Bracketed IPv6 keeps its brackets; bare IPv6 (multiple
// colons) is never treated as host:port.
export function stripServerPort(serverName: string): string {
  const bracketed = serverName.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) return `[${bracketed[1]}]`;
  const hostPort = serverName.match(/^(.+):(\d+)$/);
  if (hostPort && !hostPort[1].includes(':')) {
    return hostPort[1];
  }
  return serverName;
}

// IPv4 dotted quad, bracketed IPv6, or bare IPv6 (2+ colons).
export function isIpLiteralServerName(serverName: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(serverName)) return true;
  if (serverName.startsWith('[') && serverName.endsWith(']')) return true;
  return serverName.split(':').length >= 3;
}

// The spec's evaluation order:
//   1. no ACL event → allow
//   2. IP-literal server name with allow_ip_literals present-and-false → deny
//   3. deny list match → deny
//   4. allow list match → allow
//   5. otherwise → deny (allow defaults to an EMPTY list, so a missing
//      allow list denies everyone)
// Comparison is case-insensitive (MSC4436, spec v1.19) and ignores ports.
export function isServerAllowedByAcl(
  acl: ServerAclContent | null | undefined,
  rawServerName: string
): boolean {
  if (!acl || typeof acl !== 'object') return true;
  const server = stripServerPort(String(rawServerName)).toLowerCase();

  const allowIpLiterals = (acl as { allow_ip_literals?: unknown }).allow_ip_literals !== false;
  if (isIpLiteralServerName(server) && !allowIpLiterals) return false;

  if (matchesAnyGlob(asGlobList(acl.deny).map((g) => g.toLowerCase()), server)) return false;

  return matchesAnyGlob(asGlobList(acl.allow).map((g) => g.toLowerCase()), server);
}

// Extract the ACL content from an already-loaded room state (no extra query).
export function findServerAcl(roomState: PDU[]): ServerAclContent | null {
  if (!Array.isArray(roomState)) return null;
  const aclEvent = roomState.find(
    (e) => e.type === 'm.room.server_acl' && (e.state_key ?? '') === ''
  );
  return (aclEvent?.content as ServerAclContent | undefined) ?? null;
}

// Server-name half of a Matrix ID ("@user:server[:port]").
export function serverNameFromId(mxid: string): string {
  const idx = mxid.indexOf(':');
  return idx === -1 ? '' : mxid.slice(idx + 1);
}

// ACL check against the room's CURRENT stored state. No ACL event or no
// state row at all → allowed (rule 1).
export async function isServerAllowedInRoom(
  db: D1Database,
  roomId: string,
  serverName: string
): Promise<boolean> {
  const aclEvent = await getStateEvent(db, roomId, 'm.room.server_acl', '');
  if (!aclEvent) return true;
  return isServerAllowedByAcl(aclEvent.content as ServerAclContent, serverName);
}
