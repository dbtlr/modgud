import { createHash, timingSafeEqual } from 'node:crypto';

// The token an `Authorization: Bearer <token>` header carries, or undefined
// when the header is missing or uses another scheme.
export const bearerToken = (header: string | null): string | undefined => {
  const match = header === null ? null : /^Bearer +(\S+) *$/iu.exec(header);
  return match?.[1];
};

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

// Whether the presented token hashes to the configured hash. Both sides are
// fixed-length digests, so the comparison takes the same time for every token.
export const matchesTokenHash = (token: string, expectedHex: string): boolean =>
  timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(expectedHex, 'hex'));
