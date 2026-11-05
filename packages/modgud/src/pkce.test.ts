import { describe, expect, test } from 'bun:test';

import { isCodeChallenge, isCodeVerifier, s256Challenge } from './pkce.ts';

// RFC 7636, Appendix B.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('s256Challenge', () => {
  test('matches the RFC 7636 example', () => {
    expect(s256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });
});

describe('isCodeVerifier', () => {
  test('accepts 43 to 128 unreserved characters', () => {
    expect(isCodeVerifier(RFC_VERIFIER)).toBe(true);
    expect(isCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isCodeVerifier(`${'A1-._~'.repeat(21)}zz`)).toBe(true);
  });

  test('refuses a verifier too short, too long, or with other characters', () => {
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    expect(isCodeVerifier(`${'a'.repeat(42)}=`)).toBe(false);
  });
});

describe('isCodeChallenge', () => {
  test('accepts 43 characters of base64url', () => {
    expect(isCodeChallenge(RFC_CHALLENGE)).toBe(true);
  });

  test('refuses any other length or alphabet', () => {
    expect(isCodeChallenge(RFC_CHALLENGE.slice(1))).toBe(false);
    expect(isCodeChallenge(`${RFC_CHALLENGE}=`)).toBe(false);
    expect(isCodeChallenge(`${RFC_CHALLENGE.slice(1)}.`)).toBe(false);
  });
});
