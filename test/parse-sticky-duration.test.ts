import { describe, expect, it } from 'vitest';
import { parseStickyDuration } from '../src/api/account-data';

describe('parseStickyDuration', () => {
  // MSC4354 accepts a strictly positive integer duration, supplied either as
  // a JSON number or as the all-digits unstable query parameter.
  it.each([
    [1, 1],
    [1234, 1234],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('accepts positive integer number %p', (input, expected) => {
    expect(parseStickyDuration(input)).toBe(expected);
  });

  it.each([
    ['1', 1],
    ['00123', 123],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])('accepts digit-only string %p', (input, expected) => {
    expect(parseStickyDuration(input)).toBe(expected);
  });

  // Anything else is invalid and falls back to null, which the PUT route
  // turns into an M_INVALID_PARAM response.
  it.each([
    0,
    -1,
    -100,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '0',
    '-1',
    '+1',
    '1.5',
    '',
    ' 1',
    '1 ',
    '1e3',
    'abc',
    '١٢٣',
    null,
    undefined,
    true,
    false,
    {},
    1n,
  ])('returns null for invalid input %p', (input) => {
    expect(parseStickyDuration(input)).toBeNull();
  });

  it('defaults to null when no value is supplied', () => {
    expect(parseStickyDuration(undefined)).toBeNull();
  });
});
