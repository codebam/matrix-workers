/**
 * Conformance coverage for media responses:
 * - every thumbnail response is `inline` and carries the media security headers
 * - `allow_remote=false` never calls the remote origin (cached media still works)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      await next();
    };
  },
}));

vi.mock('../src/services/federation-keys', () => ({ federationGet: vi.fn() }));

import mediaApp from '../src/api/media';
import { federationGet } from '../src/services/federation-keys';

const SERVER = 'example.com';
const REMOTE = 'remote.example.org';
const ID = 'local-media-id';

type StoreObject = {
  body: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

function createDb(contentType: string | null = 'image/png') {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>() {
              if (sql.includes('FROM media WHERE media_id = ?') && contentType) {
                return { content_type: contentType } as T;
              }
              return null;
            },
            async run() {
              return { success: true, meta: { changes: 0, last_row_id: 0 } };
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createMedia(initial: Record<string, StoreObject> = {}) {
  const store = new Map<string, StoreObject>(Object.entries(initial));
  return {
    store,
    async get(key: string) {
      const value = store.get(key);
      if (!value) return null;
      return { ...value, arrayBuffer: async () => new TextEncoder().encode(value.body).buffer };
    },
    async put(key: string, body: ArrayBuffer | Uint8Array | string, options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }) {
      const raw = typeof body === 'string'
        ? body
        : body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : new TextDecoder().decode(body);
      store.set(key, { body: raw, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    },
  } as unknown as R2Bucket & { store: Map<string, StoreObject> };
}

function envFor(media: R2Bucket, contentType: string | null = 'image/png'): Env {
  return {
    SERVER_NAME: SERVER,
    DB: createDb(contentType),
    MEDIA: media,
    CACHE: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace,
  } as unknown as Env;
}

let fetchMock: ReturnType<typeof vi.fn>;
let federationGetMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('RESIZED', {
    status: 200,
    headers: { 'Content-Type': 'image/jpeg' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  federationGetMock = vi.mocked(federationGet);
  federationGetMock.mockResolvedValue(new Response('REMOTE', {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function expectThumbnailHeaders(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Disposition')).toBe('inline');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
}

async function get(path: string, media: R2Bucket, contentType: string | null = 'image/png') {
  return mediaApp.request(`http://localhost${path}`, {}, envFor(media, contentType));
}

describe('thumbnail responses are inline and secured', () => {
  it('local cached thumbnail', async () => {
    const media = createMedia({ [`thumb_${ID}_32x32_scale`]: { body: 'THUMB' } });
    expectThumbnailHeaders(await get(`/_matrix/media/v3/thumbnail/${SERVER}/${ID}?width=32&height=32`, media));
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${SERVER}/${ID}?width=32&height=32`, media));
  });

  it('local non-image fallback', async () => {
    const media = createMedia({ [ID]: { body: 'PDF' } });
    expectThumbnailHeaders(await get(`/_matrix/media/v3/thumbnail/${SERVER}/${ID}`, media, 'application/pdf'));
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${SERVER}/${ID}`, media, 'application/pdf'));
  });

  it('local resized thumbnail', async () => {
    const media = createMedia({ [ID]: { body: 'PNG' } });
    expectThumbnailHeaders(await get(`/_matrix/media/v3/thumbnail/${SERVER}/${ID}`, media));
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${SERVER}/${ID}`, media));
  });

  it('local original fallback when resizing fails', async () => {
    fetchMock.mockResolvedValue(new Response('no resize', { status: 500 }));
    const media = createMedia({ [ID]: { body: 'PNG' } });
    const res = await get(`/_matrix/media/v3/thumbnail/${SERVER}/${ID}`, media);
    expectThumbnailHeaders(res);
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${SERVER}/${ID}`, media));
  });

  it('remote cached thumbnail', async () => {
    const media = createMedia({
      [`thumb_remote_${REMOTE}_${ID}_32x32_scale`]: { body: 'REMOTETHUMB' },
    });
    expectThumbnailHeaders(await get(`/_matrix/media/v3/thumbnail/${REMOTE}/${ID}?width=32&height=32`, media));
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${REMOTE}/${ID}?width=32&height=32`, media));
  });

  it('remote resized thumbnail', async () => {
    const media = createMedia();
    expectThumbnailHeaders(await get(`/_matrix/media/v3/thumbnail/${REMOTE}/${ID}`, media));
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${REMOTE}/${ID}`, media));
  });

  it('remote original fallback', async () => {
    fetchMock.mockResolvedValue(new Response('no resize', { status: 500 }));
    const media = createMedia();
    const res = await get(`/_matrix/media/v3/thumbnail/${REMOTE}/${ID}`, media);
    expectThumbnailHeaders(res);
    expect(res.headers.get('X-Thumbnail-Generated')).toBe('false');
    expectThumbnailHeaders(await get(`/_matrix/client/v1/media/thumbnail/${REMOTE}/${ID}`, media));
  });
});

describe('allow_remote', () => {
  it('absent still fetches remote media', async () => {
    const res = await get(`/_matrix/media/v3/download/${REMOTE}/${ID}`, createMedia());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('REMOTE');
    expect(federationGetMock).toHaveBeenCalled();
  });

  it('false skips the remote download and returns the local-not-found error', async () => {
    const media = createMedia();
    for (const path of [
      `/_matrix/media/v3/download/${REMOTE}/${ID}?allow_remote=false`,
      `/_matrix/media/v3/download/${REMOTE}/${ID}/${'file.png'}?allow_remote=false`,
      `/_matrix/client/v1/media/download/${REMOTE}/${ID}?allow_remote=false`,
    ]) {
      const res = await get(path, media);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        errcode: 'M_NOT_FOUND',
        error: 'Remote media not found',
      });
    }
    expect(federationGetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('false skips remote thumbnail fetches', async () => {
    const res = await get(
      `/_matrix/media/v3/thumbnail/${REMOTE}/${ID}?width=32&height=32&allow_remote=false`,
      createMedia()
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ errcode: 'M_NOT_FOUND', error: 'Remote media not found' });
    expect(federationGetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('false still serves cached remote media', async () => {
    const media = createMedia({
      [`remote_media_${REMOTE}_${ID}`]: { body: 'CACHED', httpMetadata: { contentType: 'image/png' } },
    });
    const res = await get(`/_matrix/media/v3/download/${REMOTE}/${ID}?allow_remote=false`, media);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('CACHED');
    expect(federationGetMock).not.toHaveBeenCalled();
  });
});
