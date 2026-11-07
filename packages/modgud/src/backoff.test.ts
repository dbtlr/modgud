import { expect, test } from 'bun:test';

import { Backoff } from './backoff.ts';

const backoffAt = () => {
  const clock = { now: 0 };
  const backoff = new Backoff({ baseMs: 1000, maxMs: 60_000, now: () => clock.now });
  return { backoff, clock };
};

// How long the backoff blocks a start after the failures so far.
const blockedFor = (backoff: Backoff, clock: { now: number }) => {
  const start = clock.now;
  while (backoff.blocked) {
    clock.now += 500;
  }
  const blocked = clock.now - start;
  return blocked;
};

test('blocks nothing before a failure', () => {
  const { backoff } = backoffAt();

  expect(backoff.blocked).toBe(false);
});

test('waits 1 second after a failure, doubling with each consecutive failure up to 60 seconds', () => {
  const { backoff, clock } = backoffAt();
  const waits: number[] = [];

  for (let failure = 0; failure < 8; failure += 1) {
    backoff.failed();
    waits.push(blockedFor(backoff, clock));
  }

  expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
});

test('starts again from 1 second once the count is reset', () => {
  const { backoff, clock } = backoffAt();
  backoff.failed();
  backoff.failed();
  blockedFor(backoff, clock);

  backoff.reset();
  backoff.failed();

  expect(blockedFor(backoff, clock)).toBe(1000);
});
