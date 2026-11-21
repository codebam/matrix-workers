import { describe, it, expect } from 'vitest';
import { getRoomVersion } from '../src/services/room-versions';

/**
 * The registry is the single source of truth for per-version feature gates.
 * Pin the complete behavior object at the redaction-rule boundary so the
 * feature detection result cannot drift one field at a time.
 */
describe('getRoomVersion feature detection', () => {
  it('echoes the requested version key in every registered behavior', () => {
    for (let v = 1; v <= 12; v++) {
      const key = String(v);
      expect(getRoomVersion(key)?.version).toBe(key);
    }
  });

  it('pins the full v11 behavior (first version with updated redaction rules)', () => {
    expect(getRoomVersion('11')).toEqual({
      version: '11',
      stateResolution: 'v2',
      eventIdFormat: 'v4',
      redactionAlgorithm: 'v11',
      knockingSupported: true,
      restrictedJoinsSupported: true,
      integerPowerLevels: true,
      updatedRedactionRules: true,
      authRuleVariant: 'v10',
      knockRestrictedSupported: true,
      stable: true,
    });
  });

  it('pins the full v12 behavior (latest registered version)', () => {
    expect(getRoomVersion('12')).toEqual({
      version: '12',
      stateResolution: 'v2',
      eventIdFormat: 'v4',
      redactionAlgorithm: 'v11',
      knockingSupported: true,
      restrictedJoinsSupported: true,
      integerPowerLevels: true,
      updatedRedactionRules: true,
      authRuleVariant: 'v10',
      knockRestrictedSupported: true,
      stable: true,
    });
  });
});
