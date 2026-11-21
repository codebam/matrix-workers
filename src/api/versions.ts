// Matrix Client-Server API version endpoints

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { getPolicyServerKey } from '../services/policy-server';

const app = new Hono<AppEnv>();

// GET /.well-known/matrix/client
app.get('/.well-known/matrix/client', (c) => {
  const serverName = c.env.SERVER_NAME;
  const baseUrl = `https://${serverName}`;

  const response: Record<string, unknown> = {
    'm.homeserver': {
      base_url: baseUrl,
    },
    // Native sliding sync support - no proxy needed
    'org.matrix.msc3575.proxy': {
      url: baseUrl,
    },
    // Legacy QR login (MSC3906): Element probes this well-known key for a
    // rendezvous server; ours speaks the MSC3886 HTTP transport.
    'io.element.rendezvous': {
      server: baseUrl,
    },
  };

  // Add MatrixRTC (LiveKit) focus if configured
  if (c.env.LIVEKIT_URL && c.env.LIVEKIT_API_KEY) {
    response['org.matrix.msc4143.rtc_foci'] = [
      {
        type: 'livekit',
        livekit_service_url: `${baseUrl}/livekit/get_token`,
      },
    ];
  }

  return c.json(response);
});

// GET /.well-known/matrix/server
app.get('/.well-known/matrix/server', (c) => {
  const serverName = c.env.SERVER_NAME;
  // Optional federation delegation override. When the SERVER_NAME hostname is
  // served by this worker through a path other servers cannot fetch directly
  // (e.g. a proxied route on a shared Cloudflare zone: same-zone worker fetches
  // fail with 522/530 instead of reaching the worker), delegate to a host that
  // behaves like an ordinary external origin — such as this worker's own
  // workers.dev domain. Unset or empty: the spec's direct form, `${SERVER_NAME}:443`.
  const mServer = c.env.FEDERATION_WELL_KNOWN_M_SERVER || `${serverName}:443`;
  return c.json({
    'm.server': mServer,
  });
});

// GET /.well-known/matrix/policy_server - MSC4284 (spec v1.18)
// Publishes the policy key so clients can populate a room's m.room.policy
// state event for THIS server.
app.get('/.well-known/matrix/policy_server', async (c) => {
  const key = await getPolicyServerKey(c.env.DB);
  if (!key) {
    return c.json({ errcode: 'M_NOT_FOUND', error: 'No policy server information available.' }, 404);
  }
  return c.json({
    public_keys: {
      ed25519: key.publicKey,
    },
  });
});

// GET /.well-known/openid-configuration - OIDC Discovery endpoint
// This is required for Element Web OIDC-native authentication
// See: https://spec.matrix.org/v1.17/client-server-api/#oauth-20-api
app.get('/.well-known/openid-configuration', (c) => {
  const serverName = c.env.SERVER_NAME;
  const baseUrl = `https://${serverName}`;

  // Return standard OIDC discovery document
  // Element Web requires all these fields to be present
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    introspection_endpoint: `${baseUrl}/oauth/introspect`,
    scopes_supported: [
      'openid',
      'profile',
      'email',
      'urn:matrix:org.matrix.msc2967.client:api:*',
      'urn:matrix:org.matrix.msc2967.client:device:*',
      'urn:matrix:client:api:*',
      'urn:matrix:client:device:*',
    ],
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    // QR code login (MSC4108) device authorization endpoint.
    device_authorization_endpoint: `${baseUrl}/oauth/device`,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'name', 'email', 'preferred_username'],
    // Note: no org.matrix.matrix-authentication-service extension here. We do
    // not implement MAS GraphQL; clients (FluffyChat) cast graphql_endpoint to
    // String and crash on null/missing. Account management is advertised via
    // /_matrix/client/v1/auth_metadata instead.
  });
});

// GET /.well-known/jwks.json - JSON Web Key Set for token verification
app.get('/.well-known/jwks.json', async (c) => {
  // Serve the OIDC signing key (ES256, key_version 3) so clients can verify
  // our id_tokens. Previously returned an empty set — oidc-native clients
  // (FluffyChat) fetch the JWKS right after discovery and a registration
  // response without a matching key set cannot complete login. A missing
  // DB binding (route-test fakes) degrades to the old empty key set.
  try {
    const key = await c.env.DB.prepare(
      `SELECT key_id, public_key FROM server_keys WHERE is_current = 1 AND key_version = 3`
    ).first<{ key_id: string; public_key: string }>();

    if (key) {
      const publicJwk = JSON.parse(key.public_key) as JsonWebKey;
      return c.json({
        keys: [
          {
            kty: 'EC',
            crv: 'P-256',
            x: publicJwk.x,
            y: publicJwk.y,
            use: 'sig',
            alg: 'ES256',
            kid: key.key_id,
          },
        ],
      });
    }
  } catch {
    // fall through to the empty set
  }
  return c.json({ keys: [] });
});

// GET /.well-known/matrix/support - Server support contact information
// Spec: https://spec.matrix.org/v1.17/client-server-api/#getwell-knownmatrixsupport
app.get('/.well-known/matrix/support', (c) => {
  const contacts: Array<{
    role: string;
    email_address?: string;
    matrix_id?: string;
  }> = [];

  // Add admin contact if configured
  if (c.env.ADMIN_CONTACT_EMAIL || c.env.ADMIN_CONTACT_MXID) {
    contacts.push({
      role: 'm.role.admin',
      email_address: c.env.ADMIN_CONTACT_EMAIL,
      matrix_id: c.env.ADMIN_CONTACT_MXID,
    });
  }

  const response: {
    contacts: typeof contacts;
    support_page?: string;
  } = {
    contacts,
  };

  if (c.env.SUPPORT_PAGE_URL) {
    response.support_page = c.env.SUPPORT_PAGE_URL;
  }

  return c.json(response);
});

// GET /_matrix/client/versions
app.get('/_matrix/client/versions', (c) => {
  return c.json({
    versions: [
      'r0.0.1',
      'r0.1.0',
      'r0.2.0',
      'r0.3.0',
      'r0.4.0',
      'r0.5.0',
      'r0.6.0',
      'r0.6.1',
      'v1.1',
      'v1.2',
      'v1.3',
      'v1.4',
      'v1.5',
      'v1.6',
      'v1.7',
      'v1.8',
      'v1.9',
      'v1.10',
      'v1.11',
      'v1.12',
      'v1.13',
      'v1.14',
      'v1.15',
      'v1.16',
      'v1.17',
      'v1.18',
      'v1.19',
    ],
    unstable_features: {
      // Authenticated media (MSC3916) is stable since v1.17; clients probe
      // this flag to choose the /_matrix/client/v1/media/* endpoints.
      'org.matrix.msc3916.stable': true,
      'org.matrix.label_based_filtering': true,
      'org.matrix.e2e_cross_signing': true,
      // QR code login (RFC 8628 device authorization grant)
      'org.matrix.msc4108': true,
      // MSC4222: state_after in sync responses
      'org.matrix.msc4222': true,
      // MSC4155: invite filtering (m.invite_permission_config)
      'org.matrix.msc4155': true,
      // MSC4140: delayed events
      'org.matrix.msc4140': true,
      // MSC3906: sign in with QR (rendezvous flows)
      'org.matrix.msc3906': true,
      // MSC3886: simple rendezvous transport
      'org.matrix.msc3886': true,
      'org.matrix.msc2432': true,
      'org.matrix.msc3440.stable': true,
      'uk.half-shot.msc2666.query_mutual_rooms': true,
      'io.element.e2ee_forced.public': false,
      'io.element.e2ee_forced.private': false,
      'io.element.e2ee_forced.trusted_private': false,
      'org.matrix.msc3026.busy_presence': false,
      'org.matrix.msc2285.stable': true,
      'org.matrix.msc3827.stable': true,
      'org.matrix.msc3881': true,
      'org.matrix.msc3882': false,
      // MatrixRTC - VoIP calls with LiveKit (MSC3401, MSC4143)
      'org.matrix.msc3401': true,
      'org.matrix.msc4143': true,
      // Sliding Sync (MSC3575) - native implementation
      'org.matrix.msc3575': true,
      // Simplified Sliding Sync (MSC4186)
      'org.matrix.simplified_msc3575': true,
      // Additional sliding sync related features
      'org.matrix.msc3575.e2ee': true,
      'org.matrix.msc3575.to_device': true,
      'org.matrix.msc3575.account_data': true,
      'org.matrix.msc3575.receipts': true,
      'org.matrix.msc3575.typing': true,
      'org.matrix.msc3575.presence': true,
    },
  });
});

// GET /_matrix/federation/v1/version
app.get('/_matrix/federation/v1/version', (c) => {
  return c.json({
    server: {
      name: 'matrix-worker',
      version: c.env.SERVER_VERSION,
    },
  });
});

export default app;
