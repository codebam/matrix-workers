import { describe, it, expect, vi } from 'vitest';
import {
  putDeviceKeysToDO,
  deleteDeviceKeysFromDO,
  recordKeyChange,
} from '../src/api/keys';
import type { Env } from '../src/types';

// These named exports are pure request/write-shape helpers: every dependency
// is a fake here, so no Durable Object / D1 binding is needed. The existing
// keys route tests exercise the Hono app only, not these exports directly.

type SentRequest = {
  url: string;
  method: string;
  body: unknown;
};

function envWithUserKeys(opts: { status?: number; body?: unknown } = {}) {
  const requests: SentRequest[] = [];
  const USER_KEYS = {
    idFromName(userId: string) {
      return { userId };
    },
    get() {
      return {
        async fetch(request: Request) {
          const text = await request.text();
          requests.push({
            url: request.url,
            method: request.method,
            body: text ? JSON.parse(text) : null,
          });
          return new Response(JSON.stringify(opts.body ?? {}), {
            status: opts.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      };
    },
  };
  return { env: { USER_KEYS } as unknown as Env, requests };
}

function createKeysDb(position: { position: number } | null) {
  const prepared: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepared,
    prepare(sql: string) {
      const stmt = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          stmt.args = args;
          return stmt;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return position;
        },
      };
      prepared.push(stmt);
      return stmt;
    },
  };
  return db;
}

describe('putDeviceKeysToDO — pure DO request shape', () => {
  it('posts device_id and keys to the device-keys/put endpoint', async () => {
    const { env, requests } = envWithUserKeys();
    const keys = { algorithms: ['Ed25519'], device_keys: { key: 'value' } };

    await putDeviceKeysToDO(env, '@alice:example.org', 'DEV1', keys);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://internal/device-keys/put');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ device_id: 'DEV1', keys });
  });

  it('throws with the status on a non-ok DO response', async () => {
    const { env } = envWithUserKeys({ status: 500, body: 'backend down' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        putDeviceKeysToDO(env, '@alice:example.org', 'DEV1', {})
      ).rejects.toThrow(/DO device-keys put failed: 500/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('deleteDeviceKeysFromDO — pure DO request shape', () => {
  it('is a no-op when the USER_KEYS binding is absent', async () => {
    await expect(
      deleteDeviceKeysFromDO({} as Env, '@alice:example.org', 'DEV1')
    ).resolves.toBeUndefined();
  });

  it('posts the device id to the delete endpoint and tolerates a non-ok response', async () => {
    const { env, requests } = envWithUserKeys({ status: 500, body: 'nope' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        deleteDeviceKeysFromDO(env, '@alice:example.org', 'DEV1')
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://internal/device-keys/delete');
    expect(requests[0].body).toEqual({ device_id: 'DEV1' });
  });
});

describe('recordKeyChange — pure write-shape decisions', () => {
  it('stamps device_key_changes with the next stream position', async () => {
    const db = createKeysDb({ position: 42 });

    await recordKeyChange(
      db as unknown as D1Database,
      '@alice:example.org',
      'DEV1',
      'added'
    );

    expect(db.prepared[0].sql).toContain('UPDATE stream_positions');
    expect(db.prepared[0].args).toEqual(['device_keys']);
    const insert = db.prepared.find((s) =>
      s.sql.includes('INSERT INTO device_key_changes')
    );
    expect(insert?.args).toEqual(['@alice:example.org', 'DEV1', 'added', 42]);
  });

  it('defaults a missing stream row to 1 and keeps a null device_id', async () => {
    const db = createKeysDb(null);

    await recordKeyChange(
      db as unknown as D1Database,
      '@alice:example.org',
      null,
      'deleted'
    );

    const insert = db.prepared.find((s) =>
      s.sql.includes('INSERT INTO device_key_changes')
    );
    expect(insert?.args).toEqual(['@alice:example.org', null, 'deleted', 1]);
  });
});
