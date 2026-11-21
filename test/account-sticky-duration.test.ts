import { describe, expect, it } from 'vitest';
import { parseStickyDuration } from '../src/api/account-data';

describe('parseStickyDuration', () => {
  it('accepts a positive integer number', () => {
    expect(parseStickyDuration(1)).toBe(1);
    expect(parseStickyDuration(1500)).toBe(1500);
    expect(parseStickyDuration(3_600_000)).toBe(3_600_000);
  });

  it('accepts a decimal string and coerces it to a number', () => {
    expect(parseStickyDuration('1500')).toBe(1500);
    expect(parseStickyDuration('0007')).toBe(7);
  });

  it('rejects non-positive, fractional and non-finite numbers', () => {
    for (const bad of [0, -1, -0.5, 1.5, NaN, Infinity, -Infinity]) {
      expect(parseStickyDuration(bad)).toBeNull();
    }
  });

  it('rejects strings that are not positive whole decimal digits', () => {
    for (const bad of ['', '0', '-5', '1.5', ' 5', '5 ', '5\n', '1e3', '+5', 'abc']) {
      expect(parseStickyDuration(bad)).toBeNull();
    }
  });

  it('rejects every other input type', () => {
    for (const bad of [null, undefined, true, false, {}, [], [5], () => 5]) {
      expect(parseStickyDuration(bad)).toBeNull();
    }
  });
});
