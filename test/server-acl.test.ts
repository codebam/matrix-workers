/**
 * Server ACLs for rooms — matcher semantics per the spec module
 * "Server Access Control Lists (ACLs) for rooms" with MSC4436's
 * case-insensitive matching (spec v1.19):
 *   1. no event → allow
 *   2. IP literal + allow_ip_literals present-and-false → deny
 *   3. deny glob match → deny
 *   4. allow glob match → allow
 *   5. otherwise → deny (missing allow list denies everyone)
 * Ports are ignored; globs use * and ?.
 */
import { describe, expect, it } from 'vitest';
import {
  findServerAcl,
  isIpLiteralServerName,
  isServerAllowedByAcl,
  serverNameFromId,
  stripServerPort,
} from '../src/services/server-acl';

describe('stripServerPort', () => {
  it('strips ports from hostnames and IPv4 literals', () => {
    expect(stripServerPort('evil.com:8448')).toBe('evil.com');
    expect(stripServerPort('evil.com:1234')).toBe('evil.com');
    expect(stripServerPort('1.2.3.4:8448')).toBe('1.2.3.4');
  });

  it('keeps bracketed IPv6, dropping the port', () => {
    expect(stripServerPort('[::1]:8448')).toBe('[::1]');
    expect(stripServerPort('[2001:db8::1]')).toBe('[2001:db8::1]');
  });

  it('does not treat bare IPv6 as host:port', () => {
    expect(stripServerPort('2001:db8::1')).toBe('2001:db8::1');
  });

  it('leaves plain names untouched', () => {
    expect(stripServerPort('matrix.org')).toBe('matrix.org');
  });
});

describe('isIpLiteralServerName', () => {
  it('recognises IPv4, bracketed and bare IPv6', () => {
    expect(isIpLiteralServerName('1.2.3.4')).toBe(true);
    expect(isIpLiteralServerName('[::1]')).toBe(true);
    expect(isIpLiteralServerName('2001:db8::1')).toBe(true);
    expect(isIpLiteralServerName('matrix.org')).toBe(false);
  });
});

describe('isServerAllowedByAcl', () => {
  it('rule 1: no ACL event allows everyone', () => {
    expect(isServerAllowedByAcl(null, 'evil.com')).toBe(true);
    expect(isServerAllowedByAcl(undefined, 'evil.com')).toBe(true);
  });

  it('rule 2: IP literals denied when allow_ip_literals is false', () => {
    const acl = { allow: ['*'], allow_ip_literals: false };
    expect(isServerAllowedByAcl(acl, '1.2.3.4')).toBe(false);
    expect(isServerAllowedByAcl(acl, '[::1]')).toBe(false);
    expect(isServerAllowedByAcl(acl, '1.2.3.4:8448')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'matrix.org')).toBe(true);
  });

  it('rule 2: missing or non-boolean allow_ip_literals defaults to allowing IPs', () => {
    expect(isServerAllowedByAcl({ allow: ['*'] }, '1.2.3.4')).toBe(true);
    expect(isServerAllowedByAcl({ allow: ['*'], allow_ip_literals: 'false' }, '1.2.3.4')).toBe(true);
    expect(isServerAllowedByAcl({ allow: ['*'], allow_ip_literals: true }, '1.2.3.4')).toBe(true);
  });

  it('rule 3: deny wins over allow', () => {
    const acl = { allow: ['*'], deny: ['evil.com'] };
    expect(isServerAllowedByAcl(acl, 'evil.com')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'good.com')).toBe(true);
  });

  it('MSC4436: matching is case-insensitive on both sides', () => {
    const acl = { allow: ['*'], deny: ['EVIL.example.COM'] };
    expect(isServerAllowedByAcl(acl, 'evil.example.com')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'Evil.Example.Com:8448')).toBe(false);
    expect(isServerAllowedByAcl({ allow: ['*.Example.COM'] }, 'matrix.example.com')).toBe(true);
  });

  it('ports are ignored when matching', () => {
    const acl = { allow: ['*'], deny: ['evil.com'] };
    expect(isServerAllowedByAcl(acl, 'evil.com:8448')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'evil.com:1234')).toBe(false);
  });

  it('glob semantics: * spans, ? is one char', () => {
    const acl = { allow: ['*'], deny: ['*.evil.com'] };
    expect(isServerAllowedByAcl(acl, 'sub.evil.com')).toBe(false);
    // "evil.com" itself does not match "*.evil.com".
    expect(isServerAllowedByAcl(acl, 'evil.com')).toBe(true);

    const q = { allow: ['?.ok.com'] };
    expect(isServerAllowedByAcl(q, 'a.ok.com')).toBe(true);
    expect(isServerAllowedByAcl(q, 'ab.ok.com')).toBe(false);
  });

  it('rule 4+5: an allow list filters, unmatched servers are denied', () => {
    const acl = { allow: ['*.example.com'] };
    expect(isServerAllowedByAcl(acl, 'matrix.example.com')).toBe(true);
    expect(isServerAllowedByAcl(acl, 'matrix.org')).toBe(false);
  });

  it('a missing allow list denies everyone (spec default)', () => {
    const acl = { deny: ['evil.com'] };
    expect(isServerAllowedByAcl(acl, 'matrix.org')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'good.com')).toBe(false);
  });

  it('non-string and non-list entries are ignored', () => {
    const acl = { allow: ['*', 42, null], deny: 'not-a-list' };
    expect(isServerAllowedByAcl(acl, 'anything.com')).toBe(true);
  });

  it('dots are literal in globs', () => {
    const acl = { allow: ['*'], deny: ['evil.*'] };
    expect(isServerAllowedByAcl(acl, 'evilxcom')).toBe(true);
    expect(isServerAllowedByAcl(acl, 'not-evil.com')).toBe(true);
    expect(isServerAllowedByAcl(acl, 'evil.com')).toBe(false);
    expect(isServerAllowedByAcl(acl, 'evil.subdomain.example')).toBe(false);
  });
});

describe('findServerAcl', () => {
  it('finds the ACL event in room state', () => {
    const state = [
      { type: 'm.room.create', state_key: '', content: {} },
      { type: 'm.room.server_acl', state_key: '', content: { allow: ['*'] } },
    ] as never;
    expect(findServerAcl(state)).toEqual({ allow: ['*'] });
  });

  it('returns null without an ACL event, on empty or malformed state', () => {
    expect(findServerAcl([])).toBeNull();
    expect(findServerAcl([{ type: 'm.room.name', state_key: '', content: {} }] as never)).toBeNull();
    expect(findServerAcl(undefined as never)).toBeNull();
    expect(findServerAcl({ not: 'an array' } as never)).toBeNull();
  });

  it('ignores non-empty state keys', () => {
    expect(
      findServerAcl([{ type: 'm.room.server_acl', state_key: 'x', content: { allow: ['*'] } }] as never)
    ).toBeNull();
  });
});

describe('serverNameFromId', () => {
  it('extracts the server half', () => {
    expect(serverNameFromId('@user:example.com')).toBe('example.com');
    expect(serverNameFromId('@user:example.com:8448')).toBe('example.com:8448');
    expect(serverNameFromId('not-an-id')).toBe('');
  });
});
