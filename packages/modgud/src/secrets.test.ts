import { expect, test } from 'bun:test';

import { randomIdentifier } from './secrets.ts';

test('randomIdentifier is 32 random bytes in base64url', () => {
  const identifier = randomIdentifier();
  expect(identifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(Buffer.from(identifier, 'base64url')).toHaveLength(32);
  expect(randomIdentifier()).not.toBe(identifier);
});
