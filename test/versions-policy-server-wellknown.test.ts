// The MSC4284 well-known route in src/api/versions.ts is the only version
// endpoint with no direct assertions. Pin both branches with the policy-key
// lookup mocked, so the route's response shape does not depend on crypto or D1.
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const getPolicyServerKey = vi.hoisted(() => vi.fn());
vi.mock('../src/services/policy-server', () => ({ getPolicyServerKey }));

import versions from '../src/api/versions';

function env(): Env {
  return { SERVER_NAME: 'matrix.example.com' } as Env;
}

async function getPolicyWellKnown(bindings: Env = env()) {
  const res = await versions.request(
    'http://localhost/.well-known/matrix/policy_server',
    {},
    bindings
  );
  return { status: res.status, body: await res.json() };
}

describe('versions module /.well-known/matrix/policy_server', () => {
  it('publishes the Ed25519 policy key as public_keys.ed25519 when configured', async () => {
    getPolicyServerKey.mockResolvedValueOnce({
      publicKey: 'policy-public-key',
      privateKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: 'private' },
    });
    const bindings = env();
    const { status, body } = await getPolicyWellKnown(bindings);
    expect(status).toBe(200);
    expect(body).toEqual({ public_keys: { ed25519: 'policy-public-key' } });
    expect(getPolicyServerKey).toHaveBeenCalledWith(bindings.DB);
  });

  it('returns M_NOT_FOUND when no policy key is available', async () => {
    getPolicyServerKey.mockResolvedValueOnce(null);
    const { status, body } = await getPolicyWellKnown();
    expect(status).toBe(404);
    expect(body).toEqual({
      errcode: 'M_NOT_FOUND',
      error: 'No policy server information available.',
    });
  });
});
