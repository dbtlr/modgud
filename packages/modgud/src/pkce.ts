import { createHash } from 'node:crypto';

// RFC 7636: a code verifier is 43 to 128 characters of its unreserved set.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/u;

// An S256 code challenge is a SHA-256 digest in unpadded base64url.
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;

export const isCodeVerifier = (value: string) => CODE_VERIFIER.test(value);

export const isCodeChallenge = (value: string) => CODE_CHALLENGE.test(value);

// The S256 challenge a verifier proves: BASE64URL(SHA256(verifier)).
export const s256Challenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
