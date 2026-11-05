import { describe, expect, test } from 'bun:test';

import { bearerToken, matchesTokenHash, sha256Hex } from './bearer.ts';

describe('bearerToken', () => {
  test('reads the token from a Bearer header, whatever the scheme case', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
  });

  test('reads nothing from a missing header or another scheme', () => {
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken('Basic abc123')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken('Bearer two tokens')).toBeUndefined();
  });
});

describe('matchesTokenHash', () => {
  test('accepts the token whose hash is configured and refuses any other', () => {
    const hash = sha256Hex('right-token');

    expect(matchesTokenHash('right-token', hash)).toBe(true);
    expect(matchesTokenHash('wrong-token', hash)).toBe(false);
  });
});
