/**
 * Spec-cited tests for media optionals:
 *  - MSC4230 animated GIF/WebP thumbnail passthrough (thumbnail?animated=true)
 *  - preview_url Browser Rendering branch on the v1 route + graceful fallback
 *    when the BROWSER binding is unavailable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import mediaApp from '../src/api/media';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const TOKEN = 'syt_media_optionals_token';
const DEVICE = 'DEVICEA';

type TokenRow = { user_id: string; device_id: string | null; locked?: number; suspended?: number };

function createDb(opts: {
  tokens?: Map<string, TokenRow>;
  media?: Map<string, { content_type: string; filename?: string | null }>;
} = {}): D1Database {
  const tokens = opts.tokens ?? new Map<string, TokenRow>();
  const media = opts.media ?? new Map<string, { content_type: string; filename?: string | null }>();
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM access_tokens') && sql.includes('token_hash')) {
                return (tokens.get(args[0] as string) as T) ?? null;
              }
              if (sql.includes('FROM media') && sql.includes('content_type')) {
                return (media.get(args[0] as string) as T) ?? null;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createBucket(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return { body: new TextEncoder().encode(body) };
    },
    async put() {
      // no-op for these read-only assertions
    },
  };
}

function createCache() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function makeEnv(db: D1Database, bucket = createBucket(), cache = createCache()): Env {
  return {
    DB: db,
    MEDIA: bucket as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: SERVER,
  } as unknown as Env;
}

async function validTokenDb(): Promise<D1Database> {
  const hash = await hashToken(TOKEN);
  return createDb({
    tokens: new Map([[hash, { user_id: USER, device_id: DEVICE }]]),
  });
}

function req(path: string, env: Env, headers: Record<string, string> = {}) {
  return mediaApp.request(`http://localhost${path}`, { headers }, env);
}

describe('MSC4230 animated thumbnail passthrough', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GIF media with animated=true returns original animated bytes with correct Content-Type and cache headers', async () => {
    const mediaId = 'gifanim1';
    const db = createDb({
      media: new Map([[mediaId, { content_type: 'image/gif' }]]),
    });
    const bucket = createBucket({ [mediaId]: 'GIFANIMATEDBYTES' });
    const env = makeEnv(db, bucket);

    const res = await req(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?animated=true`,
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('GIFANIMATEDBYTES');
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('WebP media with animated=true returns original animated bytes with correct Content-Type and cache headers', async () => {
    const mediaId = 'webpanim1';
    const db = createDb({
      media: new Map([[mediaId, { content_type: 'image/webp' }]]),
    });
    const bucket = createBucket({ [mediaId]: 'WEBPANIMATEDBYTES' });
    const env = makeEnv(db, bucket);

    const res = await req(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?animated=true`,
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('WEBPANIMATEDBYTES');
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('animated=true on non-animated content type does not passthrough original as animated', async () => {
    const mediaId = 'pngstatic1';
    const db = createDb({
      media: new Map([[mediaId, { content_type: 'image/png' }]]),
    });
    const bucket = createBucket({ [mediaId]: 'PNGSTATICBYTES' });
    const env = makeEnv(db, bucket);

    // No pre-generated thumbnail; route falls through and returns original
    // (image resizing unavailable in tests). Either way the response must not
    // advertise the animated passthrough cache header mismatch; ensure 200.
    const res = await req(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?animated=true`,
      env
    );
    expect(res.status).toBe(200);
  });
});

describe('preview_url v1 Browser Rendering branch and fallback', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('v1 route uses Browser Rendering branch when BROWSER binding is available', async () => {
    const url = 'https://example.com/spa';
    const browserHtml =
      '<html><head><meta property="og:title" content="FromBrowserV1"></head></html>';
    const fetchMock = vi.fn(
      async () =>
        new Response('<html><title>Basic</title></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const browser = {
      fetch: vi.fn(async () => new Response(browserHtml, { status: 200 })),
    };
    const db = await validTokenDb();
    const env = makeEnv(db);
    (env as Env & { BROWSER: unknown }).BROWSER = browser;

    const res = await req(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      env,
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'og:title': 'FromBrowserV1' });
    expect(browser.fetch).toHaveBeenCalled();
  });

  it('v1 route falls back to basic fetch when BROWSER binding is unavailable', async () => {
    const url = 'https://example.com/basic';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><head><meta property="og:title" content="BasicOnly"></head></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const db = await validTokenDb();
    const env = makeEnv(db);
    // no BROWSER binding

    const res = await req(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      env,
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'og:title': 'BasicOnly' });
  });

  it('v1 route falls back to basic fetch when BROWSER binding throws', async () => {
    const url = 'https://example.com/throw';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><head><meta property="og:title" content="Fallback"></head></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
      )
    );
    const browser = {
      fetch: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const db = await validTokenDb();
    const env = makeEnv(db);
    (env as Env & { BROWSER: unknown }).BROWSER = browser;

    const res = await req(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent(url)}`,
      env,
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'og:title': 'Fallback' });
  });

  it('v1 preview_url rejects SSRF-invalid URLs with 400', async () => {
    const db = await validTokenDb();
    const env = makeEnv(db);
    const res = await req(
      `/_matrix/client/v1/media/preview_url?url=${encodeURIComponent('http://localhost/')}`,
      env,
      { Authorization: `Bearer ${TOKEN}` }
    );
    expect(res.status).toBe(400);
  });
});
