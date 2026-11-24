import { describe, expect, test } from 'bun:test';

import { createWindowLimit, sourceKey } from './rate-limit.ts';

// A limit over a 1-second window, with a clock the test moves.
const limitAt = (limit: number) => {
  const clock = { now: 0 };
  return { clock, window: createWindowLimit({ limit, now: () => clock.now, windowMs: 1000 }) };
};

describe('a sliding-window limit', () => {
  test('allows events up to the limit within the window, then waits for the oldest to leave it', () => {
    const { clock, window } = limitAt(2);

    expect(window.wait('a')).toBe(0);
    window.record('a');
    clock.now = 300;
    window.record('a');

    expect(window.wait('a')).toBe(700);
    clock.now = 999;
    expect(window.wait('a')).toBe(1);
    clock.now = 1000;
    expect(window.wait('a')).toBe(0);
  });

  test('counts each key on its own', () => {
    const { window } = limitAt(1);

    window.record('a');

    expect(window.wait('a')).toBe(1000);
    expect(window.wait('b')).toBe(0);
  });
});

describe('a sliding-window limit sweeping keys that are never checked again', () => {
  test('drops one-off keys once they leave the window, without those keys being checked', () => {
    const { clock, window } = limitAt(1);
    for (let source = 0; source < 100; source += 1) {
      window.record(`old-${source}`);
    }
    expect(window.size()).toBe(100);

    clock.now = 1000;
    for (let source = 0; source < 100; source += 1) {
      window.record(`new-${source}`);
    }

    // Each record sweeps a few keys, so the 100 old ones are gone, while the
    // 100 new ones are still in the window.
    expect(window.size()).toBe(100);
  });

  test('keeps a key whose times are still inside the window, and still counts it', () => {
    const { clock, window } = limitAt(2);
    window.record('busy');
    clock.now = 600;
    window.record('busy');
    for (let source = 0; source < 50; source += 1) {
      window.record(`other-${source}`);
    }

    // Many sweeps over every key, with 'busy' having one time in the window.
    clock.now = 1200;
    for (let source = 0; source < 200; source += 1) {
      window.record(`later-${source}`);
    }

    expect(window.wait('busy')).toBe(0);
    window.record('busy');
    expect(window.wait('busy')).toBe(400);
  });

  test('drops one-off keys behind a busy key that never leaves the window', () => {
    const { clock, window } = limitAt(1);
    // One new key every millisecond for 20 windows, and one key, recorded
    // first, that stays in the window throughout.
    for (let time = 0; time < 20_000; time += 1) {
      clock.now = time;
      if (time % 500 === 0) {
        window.record('busy');
      }
      window.record(`once-${time}`);
    }

    // About 1000 keys are inside the window at the end. The sweep keeps the
    // rest to within that many again, rather than holding all 20,000.
    expect(window.size()).toBeLessThanOrEqual(2 * 1001);
    expect(window.wait('busy')).toBeGreaterThan(0);
  });

  test('keeps a key swept 1 ms before its last time leaves the window', () => {
    const { clock, window } = limitAt(1);
    window.record('a');
    clock.now = 999;
    // This record sweeps 'a', whose time at 0 is still inside the window.
    window.record('b');

    expect(window.wait('a')).toBe(1);
  });

  test('does not drop a key whose out-of-order time is the only one still in the window', () => {
    const { clock, window } = limitAt(1);
    clock.now = 1000;
    window.record('a');
    clock.now = 500;
    window.record('a');
    clock.now = 1600;
    for (let source = 0; source < 20; source += 1) {
      window.record(`other-${source}`);
    }

    expect(window.wait('a')).toBe(400);
  });
});

// The wait a plain list of every recorded time gives, for comparison.
const referenceWait = (times: number[], limit: number, now: number, windowMs: number) => {
  const recent = times.filter((time) => time > now - windowMs);
  const oldestCounted = recent[recent.length - limit];
  return oldestCounted === undefined ? 0 : oldestCounted + windowMs - now;
};

describe('a sliding-window limit over a long run', () => {
  test('waits exactly as long as a plain list of recorded times says, as times leave the window', () => {
    const limit = 5;
    const clock = { now: 0 };
    const window = createWindowLimit({ limit, now: () => clock.now, windowMs: 1000 });
    const recorded: number[] = [];

    // Steps of 1 to 97 ms, recording whenever the limit allows.
    for (let step = 0; step < 5000; step += 1) {
      clock.now += 1 + ((step * 37) % 97);
      expect(window.wait('a')).toBe(referenceWait(recorded, limit, clock.now, 1000));
      if (window.wait('a') === 0) {
        window.record('a');
        recorded.push(clock.now);
      }
    }
  });

  test('drops a time recorded after the clock stepped back once it leaves the window', () => {
    const { clock, window } = limitAt(2);

    clock.now = 1000;
    window.record('a');
    // A wall clock corrected backwards.
    clock.now = 500;
    window.record('a');
    clock.now = 1600;

    expect(window.wait('a')).toBe(0);
  });

  test('checks a full window of the highest limit without copying it each time', () => {
    const limit = 6000;
    const clock = { now: 0 };
    const window = createWindowLimit({ limit, now: () => clock.now, windowMs: 60_000 });
    for (let call = 0; call < limit; call += 1) {
      clock.now = call;
      window.record('grant');
    }

    // 20000 checks: about 4 s when each check rebuilds the 6000 times.
    const started = performance.now();
    for (let check = 0; check < 20_000; check += 1) {
      clock.now = limit + check;
      if (window.wait('grant') === 0) {
        window.record('grant');
      }
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('a registration source', () => {
  test('is an IPv4 address as given', () => {
    expect(sourceKey('203.0.113.7')).toBe('203.0.113.7');
  });

  test('is an IPv6 address by its /64 prefix, however it is written', () => {
    expect(sourceKey('2001:db8:1:2:aaaa::1')).toBe(sourceKey('2001:0DB8:1:2:ffff:ffff:ffff:ffff'));
    expect(sourceKey('2001:db8:1:2::1')).not.toBe(sourceKey('2001:db8:1:3::1'));
    expect(sourceKey('2001:db8::1')).toBe(sourceKey('2001:db8:0:0:1::'));
  });

  test('is the IPv4 address an IPv4-mapped IPv6 address carries', () => {
    expect(sourceKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  test('is a value that is no address as given, so it still counts on its own', () => {
    expect(sourceKey('not-an-address')).toBe('not-an-address');
  });
});
