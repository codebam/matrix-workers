// QR Code Login Landing Page
// When users scan a QR code, they're directed here to complete login

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../types';
import { hashToken } from '../utils/crypto';
import { Errors } from '../utils/errors';
import login, {
  isLoginTokenExpired,
  matchesLoginTokenVerifier,
  type LoginTokenRecord,
} from './login';

const app = new Hono<AppEnv>();

// Generate the landing page HTML
function generateQrLandingPage(
  serverName: string,
  token: string,
  userId: string,
  expiresAt: number
): string {
  const expiresInMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login to ${serverName}</title>
  <style>
    :root {
      --primary: #0d9488;
      --primary-dark: #0f766e;
      --bg: #0f172a;
      --bg-card: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #334155;
      --success: #22c55e;
      --warning: #f59e0b;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: var(--bg-card);
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      text-align: center;
      border: 1px solid var(--border);
    }

    .logo {
      font-size: 64px;
      margin-bottom: 20px;
    }

    h1 {
      font-size: 24px;
      margin-bottom: 8px;
    }

    .server-name {
      color: var(--primary);
      font-size: 14px;
      margin-bottom: 24px;
    }

    .user-info {
      background: var(--bg);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .user-info label {
      font-size: 12px;
      color: var(--text-muted);
      display: block;
      margin-bottom: 4px;
    }

    .user-info .value {
      font-size: 16px;
      word-break: break-all;
    }

    .expiry {
      font-size: 13px;
      color: var(--warning);
      margin-bottom: 24px;
    }

    .btn {
      display: block;
      width: 100%;
      padding: 14px 20px;
      border-radius: 8px;
      border: none;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: 12px;
      transition: all 0.2s;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
    }

    .btn-primary:hover {
      background: var(--primary-dark);
    }

    .btn-secondary {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background: var(--border);
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 24px 0;
      color: var(--text-muted);
      font-size: 13px;
    }

    .divider::before,
    .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .divider span {
      padding: 0 16px;
    }

    .manual-section {
      text-align: left;
      background: var(--bg);
      border-radius: 8px;
      padding: 16px;
    }

    .manual-section h3 {
      font-size: 14px;
      margin-bottom: 12px;
      color: var(--text-muted);
    }

    .copy-field {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }

    .copy-field input {
      flex: 1;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      color: var(--text);
      font-size: 13px;
      font-family: monospace;
    }

    .copy-field button {
      background: var(--border);
      border: none;
      border-radius: 6px;
      padding: 10px 14px;
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
    }

    .copy-field button:hover {
      background: var(--primary);
    }

    .status {
      margin-top: 20px;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
    }

    .status.success {
      background: rgba(34, 197, 94, 0.2);
      color: var(--success);
    }

    .status.error {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .hidden {
      display: none;
    }

    .apps {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 16px;
    }

    .app-btn {
      padding: 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      text-decoration: none;
      color: var(--text);
      font-size: 13px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    .app-btn:hover {
      border-color: var(--primary);
    }

    .app-btn .icon {
      font-size: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🔐</div>
    <h1>Welcome!</h1>
    <div class="server-name">${serverName}</div>

    <div class="user-info">
      <label>Logging in as</label>
      <div class="value">${userId}</div>
    </div>

    <div class="expiry" id="expiry">
      Token expires in ${expiresInMinutes} minute${expiresInMinutes !== 1 ? 's' : ''}
    </div>

    <button class="btn btn-primary" onclick="openInElement()">
      Open in Element
    </button>

    <div class="apps">
      <a href="https://app.element.io/#/login" class="app-btn" target="_blank">
        <span class="icon">🌐</span>
        <span>Element Web</span>
      </a>
      <a href="https://play.google.com/store/apps/details?id=im.vector.app" class="app-btn" target="_blank">
        <span class="icon">🤖</span>
        <span>Android</span>
      </a>
      <a href="https://apps.apple.com/app/element-messenger/id1083446067" class="app-btn" target="_blank">
        <span class="icon">🍎</span>
        <span>iOS</span>
      </a>
      <a href="https://element.io/download" class="app-btn" target="_blank">
        <span class="icon">💻</span>
        <span>Desktop</span>
      </a>
    </div>

    <div class="divider"><span>or login manually</span></div>

    <div class="manual-section">
      <h3>Manual Login Details</h3>
      <div class="copy-field">
        <input type="text" value="https://${serverName}" readonly id="homeserverUrl">
        <button onclick="copyField('homeserverUrl')">Copy</button>
      </div>
      <div class="copy-field">
        <input type="text" value="${token}" readonly id="loginToken">
        <button onclick="copyField('loginToken')">Copy</button>
      </div>
      <p style="font-size: 12px; color: var(--text-muted); margin-top: 8px;">
        In Element: Settings → Advanced → "Log in with token"
      </p>
    </div>

    <div id="status" class="status hidden"></div>
  </div>

  <script>
    const token = "${token}";
    const homeserver = "https://${serverName}";
    const expiresAt = ${expiresAt};

    // Update expiry timer
    function updateExpiry() {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60000));
      const el = document.getElementById('expiry');
      if (remaining <= 0) {
        el.textContent = 'Token has expired';
        el.style.color = '#ef4444';
      } else {
        el.textContent = 'Token expires in ' + remaining + ' minute' + (remaining !== 1 ? 's' : '');
      }
    }
    setInterval(updateExpiry, 30000);

    function copyField(id) {
      const input = document.getElementById(id);
      input.select();
      document.execCommand('copy');
      showStatus('Copied to clipboard!', 'success');
    }

    function showStatus(message, type) {
      const el = document.getElementById('status');
      el.textContent = message;
      el.className = 'status ' + type;
      setTimeout(() => {
        el.className = 'status hidden';
      }, 3000);
    }

    function openInElement() {
      // Try to open Element with the login token
      // Element Web doesn't have direct token login URL, but we can try
      const elementWebUrl = 'https://app.element.io/#/login';

      // For mobile, try deep links
      const userAgent = navigator.userAgent.toLowerCase();

      if (/iphone|ipad|ipod/.test(userAgent)) {
        // iOS - try Element app deep link
        window.location.href = 'element://';
        setTimeout(() => {
          window.location.href = 'https://apps.apple.com/app/element-messenger/id1083446067';
        }, 2000);
      } else if (/android/.test(userAgent)) {
        // Android - try Element app deep link
        window.location.href = 'element://';
        setTimeout(() => {
          window.location.href = 'https://play.google.com/store/apps/details?id=im.vector.app';
        }, 2000);
      } else {
        // Desktop - open Element Web
        window.open(elementWebUrl, '_blank');
        showStatus('Opening Element Web. Use the token above to log in.', 'success');
      }
    }

    // Auto-attempt login on mobile
    if (/mobile|android|iphone|ipad/i.test(navigator.userAgent)) {
      // On mobile, show a prompt to open the app
      document.querySelector('.btn-primary').textContent = 'Open Element App';
    }
  </script>
</body>
</html>`;
}

/**
 * The legacy landing routes only accept the `mlt_` prefixed tokens used by
 * the admin QR URL. The namespaced routes additionally accept the raw
 * URL-safe base64 tokens minted by POST /_matrix/client/v1/login/get_token.
 */
function isQrToken(token: string, allowIssuedToken = false): boolean {
  if (!token || token.length > 512) return false;
  if (allowIssuedToken) return /^[A-Za-z0-9_.-]{8,}$/.test(token);
  return token.startsWith('mlt_');
}

// Landing page for QR code login
async function handleLanding(
  c: Context<AppEnv>,
  token: string,
  allowIssuedToken = false
): Promise<Response> {
  // The URL embeds a live login token: never cache this response (audit 010.6).
  c.header('Cache-Control', 'no-store');

  // Validate token format
  if (!isQrToken(token, allowIssuedToken)) {
    return c.html(`<!DOCTYPE html>
<html><head><title>Invalid Token</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#f1f5f9;}
.error{text-align:center;padding:40px;background:#1e293b;border-radius:12px;border:1px solid #334155;}
h1{color:#ef4444;}</style></head>
<body><div class="error"><h1>Invalid Token</h1><p>This login link is invalid or has been tampered with.</p></div></body></html>`, 400);
  }

  // Look up the token
  const tokenHash = await hashToken(token);
  const tokenData = await c.env.SESSIONS.get(`login_token:${tokenHash}`, 'json') as LoginTokenRecord | null;

  if (!tokenData) {
    return c.html(`<!DOCTYPE html>
<html><head><title>Token Expired</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#f1f5f9;}
.error{text-align:center;padding:40px;background:#1e293b;border-radius:12px;border:1px solid #334155;}
h1{color:#f59e0b;}</style></head>
<body><div class="error"><h1>Token Expired</h1><p>This login link has expired or has already been used.</p><p>Please request a new QR code from your administrator.</p></div></body></html>`, 400);
  }

  // Check if expired
  if (isLoginTokenExpired(tokenData)) {
    // Clean up
    await c.env.SESSIONS.delete(`login_token:${tokenHash}`);
    return c.html(`<!DOCTYPE html>
<html><head><title>Token Expired</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:#f1f5f9;}
.error{text-align:center;padding:40px;background:#1e293b;border-radius:12px;border:1px solid #334155;}
h1{color:#f59e0b;}</style></head>
<body><div class="error"><h1>Token Expired</h1><p>This login link has expired.</p><p>Please request a new QR code from your administrator.</p></div></body></html>`, 400);
  }

  // Show the landing page
  return c.html(generateQrLandingPage(
    c.env.SERVER_NAME,
    token,
    tokenData.user_id,
    tokenData.expires_at
  ));
}

app.get('/login/qr/:token', (c) => handleLanding(c, c.req.param('token') ?? ''));

// API endpoint to check token validity (for JS-based login). Deliberately
// non-consuming: m.login.token remains the single redemption path.
app.get('/login/qr/:token/check', async (c) => {
  c.header('Cache-Control', 'no-store');
  const token = c.req.param('token');

  if (!token || !token.startsWith('mlt_')) {
    return c.json({ valid: false, error: 'Invalid token format' }, 400);
  }

  const tokenHash = await hashToken(token);
  const tokenData = await c.env.SESSIONS.get(`login_token:${tokenHash}`, 'json') as LoginTokenRecord | null;

  if (!tokenData) {
    return c.json({ valid: false, error: 'Token not found or expired' }, 404);
  }

  if (isLoginTokenExpired(tokenData)) {
    return c.json({ valid: false, error: 'Token expired' }, 400);
  }

  return c.json({
    valid: true,
    user_id: tokenData.user_id,
    homeserver: c.env.SERVER_NAME,
    expires_at: tokenData.expires_at,
  });
});

// ---------------------------------------------------------------------------
// QR landing/check routes + secure out-of-band (MSC4388-style) verification
// ---------------------------------------------------------------------------
//
// The legacy /login/qr/... routes above are kept byte-for-byte compatible for
// existing clients. The namespaced routes below are this fork's landing/check
// compatibility surface: MSC4108 itself uses OAuth 2.0 device authorization
// (already implemented in oauth.ts), while MSC4388 defines the rendezvous
// transport and the two-device HPKE/CheckCode exchange. These routes reuse
// the same login-token KV records; no schema changes or new secrets involved.

const QR_PREFIXES = [
  '/_matrix/client/v1/login/qr',
  '/_matrix/client/unstable/org.matrix.msc4108/login/qr',
];

async function handleCanonicalCheck(
  c: Context<AppEnv>,
  token: string,
  verifier: unknown
): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  if (!isQrToken(token, true)) {
    return Errors.invalidParam('token', 'Invalid token format').toResponse();
  }

  const tokenHash = await hashToken(token);
  const record = await c.env.SESSIONS.get(`login_token:${tokenHash}`, 'json') as LoginTokenRecord | null;
  if (!record) {
    return Errors.notFound('Login token not found or expired').toResponse();
  }
  if (isLoginTokenExpired(record)) {
    return Errors.forbidden('Login token has expired').toResponse();
  }

  // A bound token must present the verifier exchanged over the QR channel.
  // Checking this here lets the scanning device fail fast; m.login.token and
  // /-/login independently enforce the same binding before consuming it.
  const verifierMatches = await matchesLoginTokenVerifier(record, verifier);
  if (verifierMatches === false) {
    return Errors.forbidden('Invalid QR verifier').toResponse();
  }

  return c.json({
    valid: true,
    user_id: record.user_id,
    homeserver: c.env.SERVER_NAME,
    expires_at: record.expires_at,
    expires_in_ms: Math.max(0, record.expires_at - Date.now()),
    secure_oob: verifierMatches === true,
  });
}

for (const prefix of QR_PREFIXES) {
  // Landing page (HTML). Cache-Control: no-store is set by handleLanding.
  app.get(`${prefix}/:token`, (c) => handleLanding(c, c.req.param('token') ?? '', true));

  // Non-consuming check. GET is for legacy polling; POST accepts the
  // secure-OOB verifier in the body (never in the URL, to avoid logs).
  app.get(`${prefix}/:token/check`, (c) =>
    handleCanonicalCheck(c, c.req.param('token') ?? '', undefined)
  );
  app.post(`${prefix}/:token/check`, async (c) => {
    let body: { verifier?: unknown } = {};
    const raw = await c.req.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return Errors.badJson().toResponse();
      }
    }
    return handleCanonicalCheck(c, c.req.param('token') ?? '', body.verifier);
  });

  // Final, single-use step: delegate to the existing m.login.token handler so
  // token consumption, device creation and access-token minting stay in one
  // place. Wrong/missing verifier is rejected there without burning the token.
  app.post(`${prefix}/:token/-/login`, async (c) => {
    const token = c.req.param('token') ?? '';
    if (!isQrToken(token, true)) {
      return Errors.invalidParam('token', 'Invalid token format').toResponse();
    }
    let body: { verifier?: unknown; device_id?: unknown; initial_device_display_name?: unknown } = {};
    const raw = await c.req.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return Errors.badJson().toResponse();
      }
    }
    return login.request(
      `https://${c.env.SERVER_NAME}/_matrix/client/v3/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.token',
          token,
          ...(typeof body.verifier === 'string' ? { verifier: body.verifier } : {}),
          ...(typeof body.device_id === 'string' ? { device_id: body.device_id } : {}),
          ...(typeof body.initial_device_display_name === 'string'
            ? { initial_device_display_name: body.initial_device_display_name }
            : {}),
        }),
      },
      c.env
    );
  });
}

export default app;
