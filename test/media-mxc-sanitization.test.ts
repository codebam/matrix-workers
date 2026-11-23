/**
 * Roadmap item 5c: mxc:// path-segment sanitization and the MSC3916 PUT
 * upload size cap. Fixtures use example.com only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/middleware/auth', () => ({
  requireAuth: () => {
    return async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('userId', '@alice:example.com');
      c.set('deviceId', 'DEVICEA');
      await next();
    };
  },
}));

import mediaApp from '../src/api/media';

const USER = '@alice:example.com';
const SERVER = 'example.com';
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

type MediaRow = {
  media_id: string;
  user_id: string;
  content_type: string;
  content_length: number;
  filename: string | null;
  created_at: number;
};

type R2ObjectLike = {
  body: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

type Harness = {
  env: Env;
  rows: MediaRow[];
  mediaStore: Map<string, R2ObjectLike>;
  puts: Array<{ key: string; body: ArrayBuffer | Uint8Array | string }>;
};

function seedRow(mediaId: string, overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    media_id: mediaId,
    user_id: USER,
    content_type: 'image/png',
    content_length: 0,
    filename: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

function createHarness(rows: MediaRow[] = [], seed: Record<string, ArrayBuffer> = {}): Harness {
  const mediaStore = new Map<string, R2ObjectLike>(
    Object.entries(seed).map(([key, body]) => [key, { body }])
  );
  const puts: Harness['puts'] = [];

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('SELECT user_id, content_length FROM media WHERE media_id = ?')) {
                const row = rows.find((r) => r.media_id === args[0]);
                return row
                  ? ({ user_id: row.user_id, content_length: row.content_length } as T)
                  : null;
              }
              if (sql.includes('SELECT content_type, filename FROM media WHERE media_id = ?')) {
                const row = rows.find((r) => r.media_id === args[0]);
                return row
                  ? ({ content_type: row.content_type, filename: row.filename } as T)
                  : null;
              }
              if (sql.includes('SELECT content_type FROM media WHERE media_id = ?')) {
                const row = rows.find((r) => r.media_id === args[0]);
                return row ? ({ content_type: row.content_type } as T) : null;
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO media')) {
                const [mediaId, userId, contentType, length, filename, createdAt] = args as [
                  string, string, string, number, string | null, number,
                ];
                rows.push({
                  media_id: mediaId,
                  user_id: userId,
                  content_type: contentType,
                  content_length: length,
                  filename,
                  created_at: createdAt,
                });
              }
              if (sql.includes('UPDATE media SET content_type')) {
                const [contentType, length, filename, mediaId] = args as [
                  string, number, string | null, string,
                ];
                const row = rows.find((r) => r.media_id === mediaId);
                if (row) {
                  row.content_type = contentType;
                  row.content_length = length;
                  row.filename = filename;
                }
              }
              return { success: true, meta: { changes: 1, last_row_id: 0 } };
            },
            async all<T>() {
              return { results: [] as T[] };
            },
          };
        },
      };
    },
  };

  const media = {
    async get(key: string) {
      return mediaStore.get(key) ?? null;
    },
    async put(
      key: string,
      body: ArrayBuffer | Uint8Array | string,
      options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
    ) {
      puts.push({ key, body });
      const normalized =
        typeof body === 'string'
          ? body
          : body instanceof ArrayBuffer
            ? body
            : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      mediaStore.set(key, {
        body: normalized as ArrayBuffer,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
    },
  };

  const cache = {
    async get() { return null; },
    async put() {},
    async delete() {},
  };

  const env = {
    DB: db as unknown as D1Database,
    MEDIA: media as unknown as R2Bucket,
    CACHE: cache as unknown as KVNamespace,
    SERVER_NAME: SERVER,
  } as unknown as Env;

  return { env, rows, mediaStore, puts };
}

async function request(path: string, init: RequestInit = {}, h: Harness = createHarness()) {
  const res = await mediaApp.request(`http://localhost${path}`, init, h.env);
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get('Content-Type') || '').includes('application/json')) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers, text };
}

function expectInvalidParam(res: { status: number; body: unknown }) {
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ errcode: 'M_INVALID_PARAM' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mxc path segments: mediaId sanitization', () => {
  const badIds = [
    '..%2Fetc',                 // encoded slash, traversal shape
    '%2E%2E%2F%2E%2E%2Fetc',    // fully-encoded traversal
    'bad%20id',                 // space
    'abc%3Fdef',                // query-like junk
    'has.dot',                  // dot not allowed in media IDs
    'bad%2F..%2Fsecret',
  ];

  for (const id of badIds) {
    it(`GET v3 download rejects mediaId ${id}`, async () => {
      expectInvalidParam(await request(`/_matrix/media/v3/download/${SERVER}/${id}`));
    });
  }

  it('GET v3 download with filename rejects a traversal-shaped mediaId', async () => {
    expectInvalidParam(await request(`/_matrix/media/v3/download/${SERVER}/..%2Fetc/a.png`));
  });

  it('GET v3 thumbnail rejects an invalid mediaId', async () => {
    expectInvalidParam(await request(`/_matrix/media/v3/thumbnail/${SERVER}/..%2Fetc`));
  });

  it('GET client v1 download rejects an invalid mediaId', async () => {
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/bad%20id`, {
      headers: { Authorization: 'Bearer t' },
    });
    expectInvalidParam(res);
  });

  it('GET client v1 download with filename rejects an invalid mediaId', async () => {
    const res = await request(`/_matrix/client/v1/media/download/${SERVER}/..%2Fetc/a.png`, {
      headers: { Authorization: 'Bearer t' },
    });
    expectInvalidParam(res);
  });

  it('GET client v1 thumbnail rejects an invalid mediaId', async () => {
    const res = await request(`/_matrix/client/v1/media/thumbnail/${SERVER}/bad%20id`, {
      headers: { Authorization: 'Bearer t' },
    });
    expectInvalidParam(res);
  });
});

describe('mxc path segments: serverName sanitization', () => {
  const badServers = [
    'example.com%2F..%2Fetc',   // encoded path separator
    'bad%20server',             // space
    'host%3A99999junk',         // non-numeric port
    'example.com%00evil',
  ];

  for (const server of badServers) {
    it(`GET v3 download rejects serverName ${server}`, async () => {
      expectInvalidParam(await request(`/_matrix/media/v3/download/${server}/abc123`));
    });
  }

  it('GET v3 thumbnail rejects an invalid serverName', async () => {
    expectInvalidParam(await request(`/_matrix/media/v3/thumbnail/bad%20server/abc123`));
  });

  it('GET client v1 download rejects an invalid serverName', async () => {
    const res = await request(`/_matrix/client/v1/media/download/bad%20server/abc123`, {
      headers: { Authorization: 'Bearer t' },
    });
    expectInvalidParam(res);
  });

  it('PUT upload rejects an invalid serverName before any storage', async () => {
    const h = createHarness([seedRow('abc123')]);
    const res = await request(
      `/_matrix/client/v1/media/upload/bad%20server/abc123`,
      { method: 'PUT', headers: { Authorization: 'Bearer t' }, body: 'x' },
      h
    );
    expectInvalidParam(res);
    expect(h.puts).toHaveLength(0);
  });
});

describe('mxc path segments: valid inputs are unchanged', () => {
  it('GET v3 download serves a valid mediaId', async () => {
    const bytes = new TextEncoder().encode('PNGDATA').buffer;
    const h = createHarness([seedRow('abc123', { content_length: bytes.byteLength })], { abc123: bytes });
    const res = await request('/_matrix/media/v3/download/example.com/abc123', {}, h);
    expect(res.status).toBe(200);
    expect(res.text).toBe('PNGDATA');
  });

  it('GET v3 thumbnail returns 200 for valid params with stored media', async () => {
    const bytes = new TextEncoder().encode('PNGDATA').buffer;
    const h = createHarness([seedRow('abc123')], { abc123: bytes });
    const res = await request('/_matrix/media/v3/thumbnail/example.com/abc123?width=64&height=64', {}, h);
    expect(res.status).toBe(200);
    expect(res.text).toBe('PNGDATA');
  });

  it('GET v3 thumbnail returns 404 for a valid but unknown mediaId', async () => {
    const res = await request('/_matrix/media/v3/thumbnail/example.com/unknown123');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errcode: 'M_NOT_FOUND' });
  });

  it('accepts a numeric port and mixed case in serverName', async () => {
    const h = createHarness();
    const res = await request(
      '/_matrix/media/v3/download/Example.COM%3A8448/abc123?allow_remote=false', {}, h
    );
    // Valid segment: reaches the remote-media branch (404 without a peer), not 400.
    expect(res.status).toBe(404);
    expect(res.body).not.toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });

  it('accepts hyphen and underscore in mediaId', async () => {
    const h = createHarness();
    const res = await request('/_matrix/media/v3/download/example.com/abc-123_xyz', {}, h);
    expect(res.status).toBe(404);
    expect(res.body).not.toMatchObject({ errcode: 'M_INVALID_PARAM' });
  });
});

describe('PUT upload size cap', () => {
  const put = (path: string, init: RequestInit = {}, h: Harness = createHarness([seedRow('abc123')])) =>
    request(path, { method: 'PUT', headers: { Authorization: 'Bearer t' }, ...init }, h);

  it('POST /upload returns M_TOO_LARGE for an oversized body (reference shape)', async () => {
    const res = await request('/_matrix/media/v3/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(MAX_UPLOAD_SIZE + 1),
    });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errcode: 'M_TOO_LARGE',
      error: 'File exceeds maximum upload size',
    });
  });

  it('PUT upload returns the same 413 shape for an oversized body', async () => {
    const h = createHarness([seedRow('abc123')]);
    const res = await put(
      `/_matrix/client/v1/media/upload/${SERVER}/abc123`,
      { body: new Uint8Array(MAX_UPLOAD_SIZE + 1) },
      h
    );
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errcode: 'M_TOO_LARGE',
      error: 'File exceeds maximum upload size',
    });
    expect(h.puts).toHaveLength(0);
  });

  it('PUT upload rejects an oversized Content-Length with a small body', async () => {
    const h = createHarness([seedRow('abc123')]);
    const res = await put(
      `/_matrix/client/v1/media/upload/${SERVER}/abc123`,
      {
        headers: {
          Authorization: 'Bearer t',
          'Content-Length': String(MAX_UPLOAD_SIZE + 1),
        },
        body: 'x',
      },
      h
    );
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ errcode: 'M_TOO_LARGE' });
    expect(h.puts).toHaveLength(0);
  });

  it('PUT upload of a normal body succeeds and the media is downloadable', async () => {
    const h = createHarness([seedRow('abc123')]);
    const res = await put(
      `/_matrix/client/v1/media/upload/${SERVER}/abc123?filename=doc.txt`,
      { headers: { Authorization: 'Bearer t', 'Content-Type': 'text/plain' }, body: 'hello media' },
      h
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(h.puts).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ content_length: 11, content_type: 'text/plain' });

    const download = await request(`/_matrix/media/v3/download/${SERVER}/abc123`, {}, h);
    expect(download.status).toBe(200);
    expect(download.text).toBe('hello media');
  });
});
