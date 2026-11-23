/**
 * Spec v1.19 — media config authentication parity (roadmap item 14).
 *
 * The media config endpoint requires authentication. The v3 route used to be
 * public while the client/v1 twin was protected; both now use requireAuth().
 * The dot-form `m.upload.size` field name is spec-correct and stays unchanged.
 *
 * This suite deliberately does NOT mock ../src/middleware/auth: it exercises the
 * real middleware so the 401 M_MISSING_TOKEN contract is verified end to end,
 * resolving a valid token through a stubbed access_tokens lookup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { hashToken } from '../src/utils/crypto';
import mediaApp from '../src/api/media';

const SERVER = 'example.com';
const USER = '@alice:example.com';
const TOKEN = 'syt_media_config_token';
const DEVICE = 'DEVICEA';
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

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

function makeEnv(db: D1Database, bucket = createBucket()): Env {
  return {
    DB: db,
    MEDIA: bucket as unknown as R2Bucket,
    CACHE: { get: async () => null, put: async () => {} } as unknown as KVNamespace,
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

describe('media config requires authentication (spec v1.19, item 14)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /_matrix/media/v3/config without a token → 401 M_MISSING_TOKEN', async () => {
    const res = await req('/_matrix/media/v3/config', makeEnv(createDb()));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errcode: 'M_MISSING_TOKEN' });
  });

  it('GET /_matrix/media/v3/config with a token → 200 + m.upload.size', async () => {
    const res = await req('/_matrix/media/v3/config', makeEnv(await validTokenDb()), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('GET /_matrix/client/v1/media/config with a token → 200', async () => {
    const res = await req('/_matrix/client/v1/media/config', makeEnv(await validTokenDb()), {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('both config paths reject a missing token identically', async () => {
    const env = makeEnv(createDb());
    const v3 = await req('/_matrix/media/v3/config', env);
    const v1 = await req('/_matrix/client/v1/media/config', env);
    expect(v3.status).toBe(401);
    expect(v1.status).toBe(401);
    expect((await v3.json() as { errcode: string }).errcode).toBe('M_MISSING_TOKEN');
    expect((await v1.json() as { errcode: string }).errcode).toBe('M_MISSING_TOKEN');
  });

  it('accepts the access_token query parameter on v3 config', async () => {
    const res = await req(
      `/_matrix/media/v3/config?access_token=${TOKEN}`,
      makeEnv(await validTokenDb())
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ 'm.upload.size': MAX_UPLOAD_SIZE });
  });

  it('animated=true on thumbnail is accepted-and-ignored; clamped width/height unchanged', async () => {
    const mediaId = 'mediaid1';
    const db = createDb({
      media: new Map([[mediaId, { content_type: 'image/png' }]]),
    });
    // Pre-seed the thumbnails the route looks up by clamped dimensions + method.
    // clampThumbnailDimension: missing/garbage → 96, oversized → 1920.
    const defaultKey = `thumb_${mediaId}_96x96_scale`;
    const clampedKey = `thumb_${mediaId}_96x1920_scale`;
    const bucket = createBucket({ [defaultKey]: 'default-thumb', [clampedKey]: 'clamped-thumb' });
    const env = makeEnv(db, bucket);

    // Thumbnails stay public; animated=true alone must not change the response.
    const plain = await req(`/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}`, env);
    const animated = await req(`/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?animated=true`, env);
    const plainBody = await plain.text();
    const animatedBody = await animated.text();
    expect(plain.status).toBe(200);
    expect(animated.status).toBe(200);
    expect(animatedBody).toBe(plainBody);
    expect(animatedBody).toBe('default-thumb');

    // With animated=true present, width/height clamping is still applied.
    const clamped = await req(
      `/_matrix/media/v3/thumbnail/${SERVER}/${mediaId}?width=garbage&height=99999&animated=true`,
      env
    );
    expect(clamped.status).toBe(200);
    expect(await clamped.text()).toBe('clamped-thumb');
  });
});
