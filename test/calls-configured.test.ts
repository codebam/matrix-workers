// Pins the pure isCallsConfigured predicate across Env shapes. No Calls API
// calls are made; only the configuration gate is exercised.
import { describe, expect, it } from 'vitest';
import { isCallsConfigured } from '../src/services/cloudflare-calls';
import type { Env } from '../src/types';

function env(partial: Partial<Env> = {}): Env {
  return { ...partial } as Env;
}

describe('isCallsConfigured', () => {
  it('is false when neither credential is set', () => {
    expect(isCallsConfigured(env())).toBe(false);
  });

  it('is false when only the app id is set', () => {
    expect(isCallsConfigured(env({ CALLS_APP_ID: 'app-123' }))).toBe(false);
  });

  it('is false when only the app secret is set', () => {
    expect(isCallsConfigured(env({ CALLS_APP_SECRET: 'secret-xyz' }))).toBe(false);
  });

  it('is true when both credentials are set', () => {
    expect(isCallsConfigured(env({
      CALLS_APP_ID: 'app-123',
      CALLS_APP_SECRET: 'secret-xyz',
    }))).toBe(true);
  });

  it('treats an empty-string credential as unconfigured', () => {
    expect(isCallsConfigured(env({
      CALLS_APP_ID: '',
      CALLS_APP_SECRET: 'secret-xyz',
    }))).toBe(false);
    expect(isCallsConfigured(env({
      CALLS_APP_ID: 'app-123',
      CALLS_APP_SECRET: '',
    }))).toBe(false);
  });

  it('uses Boolean truthiness of both operands, not non-empty-string checks', () => {
    // Whitespace-only strings are truthy for both operands.
    expect(isCallsConfigured(env({
      CALLS_APP_ID: ' ',
      CALLS_APP_SECRET: ' ',
    }))).toBe(true);
    // Falsy non-string values short-circuit the && even when typed as Env.
    expect(isCallsConfigured(env({
      CALLS_APP_ID: 0 as unknown as string,
      CALLS_APP_SECRET: 'secret-xyz',
    }))).toBe(false);
    expect(isCallsConfigured(env({
      CALLS_APP_ID: 'app-123',
      CALLS_APP_SECRET: 0 as unknown as string,
    }))).toBe(false);
  });
});
