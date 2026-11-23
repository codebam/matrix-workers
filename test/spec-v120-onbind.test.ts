/**
 * Spec v1.20 — federation `POST /_matrix/federation/v1/3pid/onbind`.
 * Roadmap: ROADMAP-2026-11-23.md M5.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import federation from '../src/api/federation';
import { verifySignedThirdPartyInvite } from '../src/services/third-party-invite';

type Route = { method: string; path: string };

// Hono reports each registered route twice, so deduplicate before asserting.
const routeTable = (mod: { routes: Route[] }): string[] =>
  [...new Set(mod.routes.map((r) => `${r.method} ${r.path}`))];

const federEnv = (db: unknown = {}) =>
  ({ DB: db, SERVER_NAME: 'example.com', CACHE: {} } as unknown as Env);

const onbind = (env: Env, body: unknown) =>
  federation.request(
    'http://localhost/_matrix/federation/v1/3pid/onbind',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );

/** DB stub whose third_party_invite state lookup misses. */
function missingInviteDb() {
  return {
    prepare() {
      return {
        bind() {
          return { async first() { return null; } };
        },
      };
    },
  };
}

describe('M5 — federation 3pid/onbind', () => {
  it('registers POST (spec v1.20 verb)', () => {
    expect(routeTable(federation)).toContain('POST /_matrix/federation/v1/3pid/onbind');
  });

  it('rejects malformed payloads', async () => {
    const res = await onbind(federEnv(), { medium: 'email' });
    expect(res.status).toBe(400);
    expect((await res.json() as any).errcode).toBe('M_INVALID_PARAM');
  });

  it('rejects a non-local mxid', async () => {
    const res = await onbind(federEnv(), {
      medium: 'email',
      address: 'a@example.org',
      mxid: '@alice:remote.example.org',
      invites: [],
    });
    expect(res.status).toBe(400);
  });

  it('accepts an empty invite list', async () => {
    const res = await onbind(federEnv(), {
      medium: 'email',
      address: 'a@example.org',
      mxid: '@alice:example.com',
      invites: [],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('skips an invite whose token has no matching state event', async () => {
    const res = await onbind(federEnv(missingInviteDb()), {
      medium: 'email',
      address: 'a@example.org',
      mxid: '@alice:example.com',
      invites: [
        {
          medium: 'email',
          address: 'a@example.org',
          mxid: '@alice:example.com',
          room_id: '!room:example.com',
          sender: '@bob:example.com',
          signed: { mxid: '@alice:example.com', token: 'tok', signatures: {} },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('verification fails closed when the invite has no state event', async () => {
    const verified = await verifySignedThirdPartyInvite(missingInviteDb() as unknown as D1Database, {
      roomId: '!room:example.com',
      sender: '@bob:example.com',
      signed: { mxid: '@alice:example.com', token: 'tok', signatures: {} },
    });
    expect(verified).toEqual({ ok: false, reason: 'No third-party invite found with matching token' });
  });
});
