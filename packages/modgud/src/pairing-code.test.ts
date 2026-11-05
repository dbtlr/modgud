import { describe, expect, test } from 'bun:test';

import { mintPairingCode, normalizePairingCode } from './pairing-code.ts';

describe('mintPairingCode', () => {
  test('shows eight Crockford base32 characters as XXXX-XXXX', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(mintPairingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
    }
  });

  test('mints a different code each time', () => {
    const codes = new Set(Array.from({ length: 100 }, () => mintPairingCode()));
    expect(codes.size).toBe(100);
  });

  test('mints a code that normalizes to itself without the hyphen', () => {
    const code = mintPairingCode();
    expect(normalizePairingCode(code)).toBe(code.replace('-', ''));
  });
});

describe('normalizePairingCode', () => {
  test('ignores case, spaces, and hyphens', () => {
    expect(normalizePairingCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ab cd ef gh')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCD--EFGH')).toBe('ABCDEFGH');
  });

  test('reads I and L as 1 and O as 0', () => {
    expect(normalizePairingCode('IiLl-Oo00')).toBe('11110000');
  });

  test('refuses a code of another length', () => {
    expect(normalizePairingCode('ABCD-EFG')).toBeUndefined();
    expect(normalizePairingCode('ABCD-EFGHJ')).toBeUndefined();
    expect(normalizePairingCode('')).toBeUndefined();
  });

  test('refuses a character outside the alphabet', () => {
    expect(normalizePairingCode('ABCD-EFGU')).toBeUndefined();
    expect(normalizePairingCode('ABCD_EFGH')).toBeUndefined();
    expect(normalizePairingCode('ABCD\tEFGH')).toBeUndefined();
  });
});
