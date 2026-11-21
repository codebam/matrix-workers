import { describe, expect, it } from 'vitest';
import { parseAllowRemote } from '../src/api/media';

describe('parseAllowRemote', () => {
  // Only these exact lowercase values disable remote-origin media fetches.
  it.each([
    ['false', false],
    ['0', false],
  ])('maps %p to false', (raw, expected) => {
    expect(parseAllowRemote(raw)).toBe(expected);
  });

  // Every other raw query value leaves remote fetching enabled.
  it.each([
    ['true', true],
    ['1', true],
    ['', true],
    ['False', true],
    ['FALSE', true],
    ['00', true],
    ['0 ', true],
    ['no', true],
  ])('maps %p to true', (raw, expected) => {
    expect(parseAllowRemote(raw)).toBe(expected);
  });

  // Absent allow_remote defaults to allowing remote media.
  it('defaults to true when the query parameter is absent', () => {
    expect(parseAllowRemote(undefined)).toBe(true);
  });
});
