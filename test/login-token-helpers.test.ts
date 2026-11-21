import { describe, expect, it } from 'vitest';
import {
  isLoginTokenExpired,
  matchesLoginTokenVerifier,
  type LoginTokenRecord,
} from '../src/api/login';
import { hashToken } from '../src/utils/crypto';

function record(
  expiresAt: number,
  secureOob?: LoginTokenRecord['secure_oob']
): LoginTokenRecord {
  return {
    user_id: '@alice:example.org',
    expires_at: expiresAt,
    ...(secureOob ? { secure_oob: secureOob } : {}),
  };
}

describe('isLoginTokenExpired', () => {
  const EXPIRES_AT = 1_700_000_000_000;

  it('is false while now is before expires_at', () => {
    expect(isLoginTokenExpired(record(EXPIRES_AT), EXPIRES_AT - 1)).toBe(false);
  });

  it('is false exactly at expires_at (strict > boundary)', () => {
    expect(isLoginTokenExpired(record(EXPIRES_AT), EXPIRES_AT)).toBe(false);
  });

  it('is true once now is past expires_at', () => {
    expect(isLoginTokenExpired(record(EXPIRES_AT), EXPIRES_AT + 1)).toBe(true);
  });

  it('defaults now to Date.now()', () => {
    expect(isLoginTokenExpired(record(Date.now() - 60_000))).toBe(true);
    expect(isLoginTokenExpired(record(Date.now() + 60_000))).toBe(false);
  });
});

describe('matchesLoginTokenVerifier', () => {
  it('returns null for a token without a secure-OOB binding', async () => {
    expect(await matchesLoginTokenVerifier(record(0), undefined)).toBeNull();
    expect(await matchesLoginTokenVerifier(record(0), 'anything')).toBeNull();
  });

  it('hashes the presented verifier before comparing it to verifier_hash', async () => {
    const verifier = 'secure-oob-verifier-0123456789';
    const bound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken(verifier),
    });
    expect(await matchesLoginTokenVerifier(bound, verifier)).toBe(true);
  });

  it('returns false for a wrong verifier', async () => {
    const bound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken('right-verifier'),
    });
    expect(await matchesLoginTokenVerifier(bound, 'wrong-verifier')).toBe(false);
  });

  it('does not accept a raw verifier stored in place of its hash', async () => {
    const verifier = 'raw-verifier';
    const bound = record(0, { rendezvous_id: 'rendezvous-abc', verifier_hash: verifier });
    expect(await matchesLoginTokenVerifier(bound, verifier)).toBe(false);
  });

  it('returns false for missing, empty, or non-string verifiers', async () => {
    const bound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken('verifier'),
    });
    expect(await matchesLoginTokenVerifier(bound, undefined)).toBe(false);
    expect(await matchesLoginTokenVerifier(bound, null)).toBe(false);
    expect(await matchesLoginTokenVerifier(bound, 42)).toBe(false);
    expect(await matchesLoginTokenVerifier(bound, {})).toBe(false);
    expect(await matchesLoginTokenVerifier(bound, '')).toBe(false);
  });

  it('accepts 1..512 character verifiers and rejects longer ones', async () => {
    const short = 'x';
    const max = 'v'.repeat(512);
    const tooLong = 'v'.repeat(513);
    const shortBound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken(short),
    });
    const maxBound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken(max),
    });
    const tooLongBound = record(0, {
      rendezvous_id: 'rendezvous-abc',
      verifier_hash: await hashToken(tooLong),
    });
    expect(await matchesLoginTokenVerifier(shortBound, short)).toBe(true);
    expect(await matchesLoginTokenVerifier(maxBound, max)).toBe(true);
    expect(await matchesLoginTokenVerifier(tooLongBound, tooLong)).toBe(false);
  });
});
