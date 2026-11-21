// Matrix media endpoints (using R2 for storage)

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { Errors } from '../utils/errors';
import { requireAuth } from '../middleware/auth';
import { generateOpaqueId } from '../utils/ids';
import { validateUrlForPreview } from '../utils/url-validator';
import { federationGet } from '../services/federation-keys';

const app = new Hono<AppEnv>();

// Maximum upload size (50MB)
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

// Supported MIME types for upload validation
export const SUPPORTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'audio/mp3',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'application/pdf',
  'application/json',
  'text/plain',
  'application/octet-stream',
];

// Sanitize a filename for safe use in Content-Disposition headers.
// Strips characters that could enable header injection or path traversal.
/** Exported for unit tests. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
}

// Build a safe Content-Disposition header value using RFC 5987 encoding
/** Exported for unit tests. */
export function safeContentDisposition(filename: string): string {
  const sanitized = sanitizeFilename(filename);
  return `inline; filename="${sanitized}"`;
}

/** Strip MIME parameters (e.g. charset) and normalize whitespace. Exported for unit tests. */
export function parseBaseContentType(contentType: string): string {
  return contentType.split(';')[0].trim();
}

/** Exported for unit tests. */
export function isSupportedContentType(contentType: string): boolean {
  return SUPPORTED_TYPES.includes(parseBaseContentType(contentType));
}

/** Clamp thumbnail width/height query values to [1, 1920]. Exported for unit tests. */
export function clampThumbnailDimension(raw: string | undefined, fallback = 96): number {
  return Math.max(1, Math.min(parseInt(raw || String(fallback), 10) || fallback, 1920));
}

/** Map Matrix thumbnail `method` to Cloudflare Image Resizing `fit`. Exported for unit tests. */
export function resolveThumbnailFit(method?: string): 'cover' | 'contain' {
  return method === 'crop' ? 'cover' : 'contain';
}

// Add security headers to all media responses
/** Exported for unit tests. */
export function addMediaSecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  headers.set('X-Frame-Options', 'DENY');
}

/** All thumbnail responses must be inline and carry the media security headers. */
function thumbnailHeaders(contentType: string, generated?: boolean): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (generated !== undefined) {
    headers.set('X-Thumbnail-Generated', generated ? 'true' : 'false');
  }
  addMediaSecurityHeaders(headers);
  return headers;
}

/** Matrix `allow_remote=false` disables remote-origin fetches (cached media is still served). */
export function parseAllowRemote(raw: string | undefined): boolean {
  return raw !== 'false' && raw !== '0';
}

// Helper to decode HTML entities (only decode once to prevent double-decoding attacks)
/** Exported for unit tests. */
export function decodeHtmlEntities(text: string): string {
  // Use a proper HTML entity decoder that handles all entities correctly
  // and prevents double-decoding by checking if the text is already decoded
  const decoded = text
    .replace(/&amp;/g, '\x00AMP\x00')  // Temporarily replace to prevent double-decode
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/\x00AMP\x00/g, '&');  // Restore ampersands last
  return decoded;
}

/**
 * Extract Open Graph / meta preview fields from HTML.
 * `baseUrl` is used to absolutize relative og:image values.
 * Exported for unit tests.
 */
export function extractOpenGraphPreview(
  html: string,
  baseUrl?: { protocol: string; host: string }
): Record<string, string> {
  const preview: Record<string, string> = {};

  const ogTitle =
    html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["'][^>]*>/i);
  if (ogTitle) {
    preview['og:title'] = decodeHtmlEntities(ogTitle[1]);
  } else {
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (title) {
      preview['og:title'] = decodeHtmlEntities(title[1]);
    }
  }

  const ogDesc =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:description["'][^>]*>/i);
  if (ogDesc) {
    preview['og:description'] = decodeHtmlEntities(ogDesc[1]);
  } else {
    const metaDesc =
      html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
      html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
    if (metaDesc) {
      preview['og:description'] = decodeHtmlEntities(metaDesc[1]);
    }
  }

  const ogImage =
    html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:image["'][^>]*>/i);
  if (ogImage) {
    let imageUrl = ogImage[1];
    if (baseUrl) {
      if (imageUrl.startsWith('/')) {
        imageUrl = `${baseUrl.protocol}//${baseUrl.host}${imageUrl}`;
      } else if (!imageUrl.startsWith('http')) {
        imageUrl = `${baseUrl.protocol}//${baseUrl.host}/${imageUrl}`;
      }
    }
    preview['og:image'] = imageUrl;
  }

  const ogSiteName =
    html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:site_name["'][^>]*>/i);
  if (ogSiteName) {
    preview['og:site_name'] = decodeHtmlEntities(ogSiteName[1]);
  }

  const ogType =
    html.match(/<meta[^>]*property=["']og:type["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:type["'][^>]*>/i);
  if (ogType) {
    preview['og:type'] = ogType[1];
  }

  return preview;
}

// POST /_matrix/media/v3/upload - Upload media
app.post('/_matrix/media/v3/upload', requireAuth(), async (c) => {
  const userId = c.get('userId');

  // Get content type and filename
  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const filename = c.req.query('filename');

  // Validate MIME type against whitelist
  if (!isSupportedContentType(contentType)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: `Unsupported content type: ${parseBaseContentType(contentType)}` },
      403
    );
  }

  // Early rejection based on Content-Length header (may be absent or falsified)
  const contentLength = parseInt(c.req.header('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_SIZE) {
    return Errors.tooLarge('File exceeds maximum upload size').toResponse();
  }

  // Generate media ID
  const mediaId = await generateOpaqueId(24);
  const mxcUri = `mxc://${c.env.SERVER_NAME}/${mediaId}`;

  // Get the raw body and verify actual size
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_SIZE) {
    return Errors.tooLarge('File exceeds maximum upload size').toResponse();
  }

  // Sanitize filename for storage
  const safeFilename = filename ? sanitizeFilename(filename) : '';

  // Store in R2
  await c.env.MEDIA.put(mediaId, body, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      userId,
      filename: safeFilename,
      uploadedAt: Date.now().toString(),
    },
  });

  // Store metadata in D1
  await c.env.DB.prepare(
    `INSERT INTO media (media_id, user_id, content_type, content_length, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(mediaId, userId, contentType, body.byteLength, safeFilename || null, Date.now()).run();

  return c.json({
    content_uri: mxcUri,
  });
});

// ============================================
// Remote media (MSC3916 federation download)
// ============================================

type MediaEnv = AppEnv['Bindings'];

interface RemoteMedia {
  body: ArrayBuffer;
  contentType: string;
  filename?: string;
}

// Parse a multipart/mixed MSC3916 media response. Synapse sends:
//   \r\n--boundary
//   Content-Type: application/json
//   (blank)
//   {}
//   --boundary
//   Content-Type: image/jpeg
//   Content-Disposition: inline
//   (blank)
//   <media bytes>
//   --boundary--
// Indices are computed on a latin1-decoded string, where one char == one
// byte, so char offsets slice the original bytes safely.
export function parseFederationMediaMultipart(
  contentTypeHeader: string,
  buf: ArrayBuffer
): RemoteMedia | null {
  const boundaryMatch = /boundary="?([^";]+)"?/.exec(contentTypeHeader);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[1]}`;
  const bytes = new Uint8Array(buf);
  const text = new TextDecoder('latin1').decode(bytes);

  const chunks = text.split(boundary);
  // Offset of each chunk within the original text.
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i > 0) {
      if (chunk.startsWith('--')) break; // closing boundary
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        const headerText = chunk.slice(0, headerEnd);
        let bodyEnd = chunk.length;
        if (chunk.endsWith('\r\n')) bodyEnd -= 2;

        if (!headerText.toLowerCase().includes('application/json')) {
          const contentType = (/content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1] || '')
            .split(';')[0]
            .trim() || 'application/octet-stream';
          const filenameRaw = /filename\*?=(?:utf-8'')?"?([^";\r\n]+)"?/i.exec(headerText)?.[1];
          let filename: string | undefined;
          if (filenameRaw) {
            try {
              filename = decodeURIComponent(filenameRaw);
            } catch {
              filename = filenameRaw;
            }
          }
          const bodyStart = offset + headerEnd + 4;
          const bodyStop = offset + bodyEnd;
          if (bodyStop >= bodyStart) {
            return {
              body: bytes.slice(bodyStart, bodyStop).buffer,
              contentType,
              filename,
            };
          }
        }
      }
    }
    offset += chunk.length + boundary.length;
  }
  return null;
}

// Fetch media that lives on another homeserver via the signed federation
// media download endpoint, extracting the media part from the multipart
// response and caching the bytes in R2 for subsequent requests.
export async function fetchRemoteMedia(
  env: MediaEnv,
  serverName: string,
  mediaId: string,
  allowRemote = true
): Promise<RemoteMedia | null> {
  const cacheKey = `remote_media_${serverName}_${mediaId}`;

  try {
    const cached = await env.MEDIA.get(cacheKey);
    if (cached) {
      return {
        body: await cached.arrayBuffer(),
        contentType: cached.httpMetadata?.contentType || 'application/octet-stream',
        filename: cached.customMetadata?.filename,
      };
    }
  } catch {
    // cache reads are best-effort
  }

  // allow_remote=false: local/cached media only, never contact the origin.
  if (!allowRemote) return null;

  try {
    const response = await federationGet(
      serverName,
      `/_matrix/federation/v1/media/download/${encodeURIComponent(mediaId)}`,
      env.SERVER_NAME,
      env.DB,
      env.CACHE
    );

    if (!response.ok) {
      console.warn(`[media] Remote media ${serverName}/${mediaId} fetch failed: HTTP ${response.status}`);
      return null;
    }

    const contentTypeHeader = response.headers.get('Content-Type') || '';
    const buf = await response.arrayBuffer();

    let media: RemoteMedia;
    if (contentTypeHeader.toLowerCase().startsWith('multipart/mixed')) {
      const parsed = parseFederationMediaMultipart(contentTypeHeader, buf);
      if (!parsed) {
        console.warn(`[media] Remote media ${serverName}/${mediaId} malformed multipart response`);
        return null;
      }
      media = parsed;
    } else {
      media = {
        body: buf,
        contentType: contentTypeHeader.split(';')[0].trim() || 'application/octet-stream',
      };
    }

    try {
      await env.MEDIA.put(cacheKey, media.body, {
        httpMetadata: { contentType: media.contentType },
        customMetadata: media.filename ? { filename: media.filename } : {},
      });
    } catch {
      // cache writes are best-effort
    }

    return media;
  } catch (err) {
    console.warn(`[media] Remote media ${serverName}/${mediaId} fetch errored:`, err);
    return null;
  }
}

function serveRemoteMedia(media: RemoteMedia, filenameOverride?: string): Response {
  const headers = new Headers();
  headers.set('Content-Type', media.contentType);
  const filename = filenameOverride || media.filename;
  if (filename) {
    headers.set('Content-Disposition', safeContentDisposition(filename));
  }
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);
  return new Response(media.body, { headers });
}

// Thumbnail for media on another server: resize via the platform image
// resizer against our own (now remote-capable) download URL, falling back to
// the original bytes when resizing is unavailable.
async function serveRemoteThumbnail(
  env: MediaEnv,
  serverName: string,
  mediaId: string,
  width: number,
  height: number,
  method: string,
  allowRemote = true
): Promise<Response> {
  const thumbnailKey = `thumb_remote_${serverName}_${mediaId}_${width}x${height}_${method}`;

  try {
    const existing = await env.MEDIA.get(thumbnailKey);
    if (existing) {
      return new Response(existing.body, { headers: thumbnailHeaders('image/jpeg') });
    }
  } catch {
    // best-effort cache read
  }

  // The internal resize fetch would itself trigger a remote fetch; with
  // allow_remote=false, go straight to the cached-or-404 fallback instead.
  if (allowRemote) try {
    const downloadUrl = `https://${env.SERVER_NAME}/_matrix/media/v3/download/${serverName}/${mediaId}`;
    const resized = await fetch(downloadUrl, {
      cf: {
        image: {
          width,
          height,
          fit: resolveThumbnailFit(method),
          format: 'jpeg',
          quality: 85,
        },
      },
    });

    if (resized.ok && (resized.headers.get('Content-Type') || '').startsWith('image/')) {
      const thumbBody = await resized.arrayBuffer();
      try {
        await env.MEDIA.put(thumbnailKey, thumbBody, {
          httpMetadata: { contentType: 'image/jpeg' },
        });
      } catch {
        // best-effort cache write
      }
      return new Response(thumbBody, { headers: thumbnailHeaders('image/jpeg', true) });
    }
  } catch (resizeErr) {
    console.warn('[media] Remote thumbnail resize failed:', resizeErr);
  }

  const remote = await fetchRemoteMedia(env, serverName, mediaId, allowRemote);
  if (!remote) {
    return Errors.notFound('Remote media not found').toResponse();
  }
  const response = serveRemoteMedia(remote);
  response.headers.set('Content-Disposition', 'inline');
  response.headers.set('X-Thumbnail-Generated', 'false');
  return response;
}

// GET /_matrix/media/v3/download/:serverName/:mediaId - Download media
app.get('/_matrix/media/v3/download/:serverName/:mediaId', async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    const remote = await fetchRemoteMedia(c.env, serverName, mediaId, allowRemote);
    if (!remote) {
      return Errors.notFound('Remote media not found').toResponse();
    }
    return serveRemoteMedia(remote);
  }

  // Get from R2
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // Get metadata
  const metadata = await c.env.DB.prepare(
    `SELECT content_type, filename FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string; filename: string | null }>();

  const headers = new Headers();
  headers.set('Content-Type', metadata?.content_type || 'application/octet-stream');
  if (metadata?.filename) {
    headers.set('Content-Disposition', safeContentDisposition(metadata.filename));
  }
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);

  return new Response(object.body, { headers });
});

// GET /_matrix/media/v3/download/:serverName/:mediaId/:filename - Download with filename
app.get('/_matrix/media/v3/download/:serverName/:mediaId/:filename', async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const requestedFilename = c.req.param('filename');
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    const remote = await fetchRemoteMedia(c.env, serverName, mediaId, allowRemote);
    if (!remote) {
      return Errors.notFound('Remote media not found').toResponse();
    }
    return serveRemoteMedia(remote, requestedFilename);
  }

  // Get from R2
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // Get metadata
  const metadata = await c.env.DB.prepare(
    `SELECT content_type FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string }>();

  const headers = new Headers();
  headers.set('Content-Type', metadata?.content_type || 'application/octet-stream');
  headers.set('Content-Disposition', safeContentDisposition(requestedFilename));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);

  return new Response(object.body, { headers });
});

// GET /_matrix/media/v3/thumbnail/:serverName/:mediaId - Get thumbnail
app.get('/_matrix/media/v3/thumbnail/:serverName/:mediaId', async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const width = clampThumbnailDimension(c.req.query('width'));
  const height = clampThumbnailDimension(c.req.query('height'));
  const method = c.req.query('method') || 'scale';
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    return serveRemoteThumbnail(c.env, serverName, mediaId, width, height, method, allowRemote);
  }

  // Get media metadata
  const metadata = await c.env.DB.prepare(
    `SELECT content_type FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string }>();

  if (!metadata) {
    return Errors.notFound('Media not found').toResponse();
  }

  // Only generate thumbnails for images
  const isImage = metadata.content_type.startsWith('image/');

  // Check if pre-generated thumbnail exists
  const thumbnailKey = `thumb_${mediaId}_${width}x${height}_${method}`;
  const existingThumb = await c.env.MEDIA.get(thumbnailKey);

  if (existingThumb) {
    return new Response(existingThumb.body, { headers: thumbnailHeaders('image/jpeg') });
  }

  // Get original
  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // If not an image, return original
  if (!isImage) {
    return new Response(object.body, { headers: thumbnailHeaders(metadata.content_type) });
  }

  // Use Cloudflare Image Resizing via cf.image on fetch
  try {
    const downloadUrl = `https://${c.env.SERVER_NAME}/_matrix/media/v3/download/${serverName}/${mediaId}`;
    const resized = await fetch(downloadUrl, {
      cf: {
        image: {
          width,
          height,
          fit: resolveThumbnailFit(method),
          format: 'jpeg',
          quality: 85,
        },
      },
    });

    if (resized.ok) {
      // Cache the thumbnail in R2 for future requests
      const thumbBody = await resized.arrayBuffer();
      await c.env.MEDIA.put(thumbnailKey, thumbBody, {
        httpMetadata: { contentType: 'image/jpeg' },
      });

      return new Response(thumbBody, { headers: thumbnailHeaders('image/jpeg', true) });
    }
  } catch (resizeErr) {
    // Image Resizing may not be available on Free plan - fall back to original
    console.warn('[media] Image resize failed (may require Pro plan):', resizeErr);
  }

  // Fallback: return original
  return new Response(object.body, { headers: thumbnailHeaders(metadata.content_type, false) });
});

// GET /_matrix/media/v3/preview_url - Get URL preview
app.get('/_matrix/media/v3/preview_url', requireAuth(), async (c) => {
  const url = c.req.query('url');
  // Note: ts is optional timestamp for cache busting, not currently used
  void c.req.query('ts');

  if (!url) {
    return Errors.missingParam('url').toResponse();
  }

  // Validate URL for SSRF protection
  const validation = validateUrlForPreview(url);
  if (!validation.valid) {
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        error: validation.error || 'Invalid URL',
      },
      400
    );
  }

  try {
    // Use the sanitized URL
    const parsedUrl = new URL(validation.sanitizedUrl!);

    // Check cache first
    const cacheKey = `preview:${url}`;
    const cached = await c.env.CACHE.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    // Fetch the URL with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Tuwunel Matrix Server URL Preview Bot',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return c.json({});
    }

    const contentType = response.headers.get('Content-Type') || '';

    // Handle images directly
    if (contentType.startsWith('image/')) {
      const result = {
        'og:image': url,
        'og:image:type': contentType,
      };

      // Cache for 1 hour
      await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
      return c.json(result);
    }

    // Only parse HTML content
    if (!contentType.includes('text/html')) {
      return c.json({});
    }

    let html: string;

    // Try Browser Rendering for JS-rendered pages (if available)
    if (c.env.BROWSER) {
      try {
        const browserResponse = await c.env.BROWSER.fetch(new Request(url, {
          headers: { 'Accept': 'text/html' },
        }));
        if (browserResponse.ok) {
          html = await browserResponse.text();
        } else {
          html = await response.text();
        }
      } catch (browserErr) {
        console.warn('[media] Browser Rendering failed, falling back to basic fetch:', browserErr);
        html = await response.text();
      }
    } else {
      html = await response.text();
    }

    // Extract Open Graph and meta tags
    const preview = extractOpenGraphPreview(html, {
      protocol: parsedUrl.protocol,
      host: parsedUrl.host,
    });

    // Cache for 1 hour
    if (Object.keys(preview).length > 0) {
      await c.env.CACHE.put(cacheKey, JSON.stringify(preview), { expirationTtl: 3600 });
    }

    return c.json(preview);
  } catch (error) {
    console.error('URL preview error:', error);
    return c.json({});
  }
});

// GET /_matrix/media/v3/config - Get media config
app.get('/_matrix/media/v3/config', async (c) => {
  return c.json({
    'm.upload.size': MAX_UPLOAD_SIZE,
  });
});

// ============================================
// Authenticated Media Endpoints (MSC3916)
// These are the newer endpoints that clients prefer
// ============================================

// POST /_matrix/client/v1/media/upload - Authenticated upload
app.post('/_matrix/client/v1/media/upload', requireAuth(), async (c) => {
  const userId = c.get('userId');

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const filename = c.req.query('filename');

  // Validate MIME type against whitelist
  if (!isSupportedContentType(contentType)) {
    return c.json(
      { errcode: 'M_FORBIDDEN', error: `Unsupported content type: ${parseBaseContentType(contentType)}` },
      403
    );
  }

  const contentLength = parseInt(c.req.header('Content-Length') || '0');
  if (contentLength > MAX_UPLOAD_SIZE) {
    return Errors.tooLarge('File exceeds maximum upload size').toResponse();
  }

  const mediaId = await generateOpaqueId(24);
  const mxcUri = `mxc://${c.env.SERVER_NAME}/${mediaId}`;

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_SIZE) {
    return Errors.tooLarge('File exceeds maximum upload size').toResponse();
  }

  const safeFilename = filename ? sanitizeFilename(filename) : '';

  await c.env.MEDIA.put(mediaId, body, {
    httpMetadata: { contentType },
    customMetadata: {
      userId,
      filename: safeFilename,
      uploadedAt: Date.now().toString(),
    },
  });

  await c.env.DB.prepare(
    `INSERT INTO media (media_id, user_id, content_type, content_length, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(mediaId, userId, contentType, body.byteLength, safeFilename || null, Date.now()).run();

  return c.json({ content_uri: mxcUri });
});

// POST /_matrix/client/v1/media/create - Create media placeholder (for async uploads)
app.post('/_matrix/client/v1/media/create', requireAuth(), async (c) => {
  const userId = c.get('userId');

  const mediaId = await generateOpaqueId(24);
  const mxcUri = `mxc://${c.env.SERVER_NAME}/${mediaId}`;

  // Create a placeholder entry
  await c.env.DB.prepare(
    `INSERT INTO media (media_id, user_id, content_type, content_length, created_at)
     VALUES (?, ?, 'application/octet-stream', 0, ?)`
  ).bind(mediaId, userId, Date.now()).run();

  return c.json({
    content_uri: mxcUri,
    unused_expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  });
});

// PUT /_matrix/client/v1/media/upload/:serverName/:mediaId - Upload to placeholder
app.put('/_matrix/client/v1/media/upload/:serverName/:mediaId', requireAuth(), async (c) => {
  const userId = c.get('userId');
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');

  if (serverName !== c.env.SERVER_NAME) {
    return Errors.forbidden('Cannot upload to remote server').toResponse();
  }

  // Check placeholder exists and belongs to user
  const existing = await c.env.DB.prepare(
    `SELECT user_id, content_length FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ user_id: string; content_length: number }>();

  if (!existing) {
    return Errors.notFound('Media not found').toResponse();
  }

  if (existing.user_id !== userId) {
    return Errors.forbidden('Not authorized to upload to this media').toResponse();
  }

  if (existing.content_length > 0) {
    return c.json({
      errcode: 'M_CANNOT_OVERWRITE_MEDIA',
      error: 'Media already uploaded',
    }, 409);
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const filename = c.req.query('filename');

  const body = await c.req.arrayBuffer();

  await c.env.MEDIA.put(mediaId, body, {
    httpMetadata: { contentType },
    customMetadata: {
      userId,
      filename: filename || '',
      uploadedAt: Date.now().toString(),
    },
  });

  await c.env.DB.prepare(
    `UPDATE media SET content_type = ?, content_length = ?, filename = ? WHERE media_id = ?`
  ).bind(contentType, body.byteLength, filename || null, mediaId).run();

  return c.json({});
});

// GET /_matrix/client/v1/media/download/:serverName/:mediaId - Authenticated download
app.get('/_matrix/client/v1/media/download/:serverName/:mediaId', requireAuth(), async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    const remote = await fetchRemoteMedia(c.env, serverName, mediaId, allowRemote);
    if (!remote) {
      return Errors.notFound('Remote media not found').toResponse();
    }
    return serveRemoteMedia(remote);
  }

  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  const metadata = await c.env.DB.prepare(
    `SELECT content_type, filename FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string; filename: string | null }>();

  const headers = new Headers();
  headers.set('Content-Type', metadata?.content_type || 'application/octet-stream');
  if (metadata?.filename) {
    headers.set('Content-Disposition', safeContentDisposition(metadata.filename));
  }
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);

  return new Response(object.body, { headers });
});

// GET /_matrix/client/v1/media/download/:serverName/:mediaId/:filename - With filename
app.get('/_matrix/client/v1/media/download/:serverName/:mediaId/:filename', requireAuth(), async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const requestedFilename = c.req.param('filename');
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    const remote = await fetchRemoteMedia(c.env, serverName, mediaId, allowRemote);
    if (!remote) {
      return Errors.notFound('Remote media not found').toResponse();
    }
    return serveRemoteMedia(remote, requestedFilename);
  }

  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  const metadata = await c.env.DB.prepare(
    `SELECT content_type FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string }>();

  const headers = new Headers();
  headers.set('Content-Type', metadata?.content_type || 'application/octet-stream');
  headers.set('Content-Disposition', safeContentDisposition(requestedFilename));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);

  return new Response(object.body, { headers });
});

// GET /_matrix/client/v1/media/thumbnail/:serverName/:mediaId - Authenticated thumbnail
app.get('/_matrix/client/v1/media/thumbnail/:serverName/:mediaId', requireAuth(), async (c) => {
  const serverName = c.req.param('serverName');
  const mediaId = c.req.param('mediaId');
  const width = clampThumbnailDimension(c.req.query('width'));
  const height = clampThumbnailDimension(c.req.query('height'));
  const method = c.req.query('method') || 'scale';
  const allowRemote = parseAllowRemote(c.req.query('allow_remote'));

  if (serverName !== c.env.SERVER_NAME) {
    return serveRemoteThumbnail(c.env, serverName, mediaId, width, height, method, allowRemote);
  }

  // Get media metadata
  const metadata = await c.env.DB.prepare(
    `SELECT content_type FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string }>();

  if (!metadata) {
    return Errors.notFound('Media not found').toResponse();
  }

  const isImage = metadata.content_type.startsWith('image/');

  // Check for pre-generated thumbnail
  const thumbnailKey = `thumb_${mediaId}_${width}x${height}_${method}`;
  const existingThumb = await c.env.MEDIA.get(thumbnailKey);

  if (existingThumb) {
    return new Response(existingThumb.body, { headers: thumbnailHeaders('image/jpeg') });
  }

  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  // Try Image Resizing for image content
  if (isImage) {
    try {
      const downloadUrl = `https://${c.env.SERVER_NAME}/_matrix/media/v3/download/${serverName}/${mediaId}`;
      const resized = await fetch(downloadUrl, {
        cf: {
          image: {
            width,
            height,
            fit: resolveThumbnailFit(method),
            format: 'jpeg',
            quality: 85,
          },
        },
      });

      if (resized.ok) {
        const thumbBody = await resized.arrayBuffer();
        await c.env.MEDIA.put(thumbnailKey, thumbBody, {
          httpMetadata: { contentType: 'image/jpeg' },
        });

        return new Response(thumbBody, { headers: thumbnailHeaders('image/jpeg', true) });
      }
    } catch (resizeErr) {
      console.warn('[media] Image resize failed:', resizeErr);
    }
  }

  return new Response(object.body, {
    headers: thumbnailHeaders(metadata.content_type, isImage ? false : undefined),
  });
});

// GET /_matrix/client/v1/media/preview_url - Authenticated URL preview
app.get('/_matrix/client/v1/media/preview_url', requireAuth(), async (c) => {
  // Delegate to the existing preview_url handler by calling the same logic
  const url = c.req.query('url');

  if (!url) {
    return Errors.missingParam('url').toResponse();
  }

  // Validate URL for SSRF protection
  const validation = validateUrlForPreview(url);
  if (!validation.valid) {
    return c.json(
      {
        errcode: 'M_UNKNOWN',
        error: validation.error || 'Invalid URL',
      },
      400
    );
  }

  try {
    // Use the sanitized URL
    const parsedUrl = new URL(validation.sanitizedUrl!);

    const cacheKey = `preview:${url}`;
    const cached = await c.env.CACHE.get(cacheKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Tuwunel Matrix Server URL Preview Bot',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return c.json({});
    }

    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.startsWith('image/')) {
      const result = {
        'og:image': url,
        'og:image:type': contentType,
      };
      await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
      return c.json(result);
    }

    if (!contentType.includes('text/html')) {
      return c.json({});
    }

    const html = await response.text();
    const preview = extractOpenGraphPreview(html, {
      protocol: parsedUrl.protocol,
      host: parsedUrl.host,
    });

    if (Object.keys(preview).length > 0) {
      await c.env.CACHE.put(cacheKey, JSON.stringify(preview), { expirationTtl: 3600 });
    }

    return c.json(preview);
  } catch (error) {
    console.error('URL preview error:', error);
    return c.json({});
  }
});

// GET /_matrix/client/v1/media/config - Authenticated media config
app.get('/_matrix/client/v1/media/config', requireAuth(), async (c) => {
  return c.json({
    'm.upload.size': MAX_UPLOAD_SIZE,
  });
});

// ============================================
// Federation media (MSC3916)
// ============================================

// GET /_matrix/federation/v1/media/download/:mediaId
// Serves local media to other homeservers that fetch it for their own users
// (e.g. profile avatars). Responds with multipart/mixed: a JSON metadata part
// followed by the media part, matching Synapse's format. Like the other
// federation endpoints in this codebase, inbound requests are not
// signature-verified; media ids are unguessable and the v3 download paths are
// equally open.
app.get('/_matrix/federation/v1/media/download/:mediaId', async (c) => {
  const mediaId = c.req.param('mediaId');

  const object = await c.env.MEDIA.get(mediaId);
  if (!object) {
    return Errors.notFound('Media not found').toResponse();
  }

  const metadata = await c.env.DB.prepare(
    `SELECT content_type, filename FROM media WHERE media_id = ?`
  ).bind(mediaId).first<{ content_type: string; filename: string | null }>();

  const contentType =
    metadata?.content_type || object.httpMetadata?.contentType || 'application/octet-stream';
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  const filename = metadata?.filename ? `; filename=${sanitizeFilename(metadata.filename)}` : '';

  const boundary = crypto.randomUUID().replace(/-/g, '');
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\nContent-Disposition: ${disposition}${filename}\r\n\r\n`
  );
  const mediaBytes = new Uint8Array(await object.arrayBuffer());
  const tail = encoder.encode(`\r\n--${boundary}--`);

  const body = new Uint8Array(head.length + mediaBytes.length + tail.length);
  body.set(head, 0);
  body.set(mediaBytes, head.length);
  body.set(tail, head.length + mediaBytes.length);

  const headers = new Headers();
  headers.set('Content-Type', `multipart/mixed; boundary=${boundary}`);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  addMediaSecurityHeaders(headers);

  return new Response(body, { headers });
});

export default app;
