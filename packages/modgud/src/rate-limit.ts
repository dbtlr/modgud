import { isIPv6 } from 'node:net';

import { ipv6Groups } from './ip-address.ts';

// A sliding-window count of events per key: at most `limit` in any
// `windowMs`. Each key's times are kept oldest first and dropped from the
// front as they leave the window, so a check costs the same at any limit, and
// memory stays bounded by the events recorded within about two windows.
export const createWindowLimit = ({
  limit,
  now,
  windowMs,
}: {
  limit: number;
  now: () => number;
  windowMs: number;
}) => {
  // Each key's event times, oldest first. Those before `start` have left the
  // window and wait to be compacted away.
  const events = new Map<string, { start: number; times: number[] }>();

  // The key's times with those that left the window dropped, or undefined
  // when none is left.
  const recent = (key: string) => {
    const entry = events.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const since = now() - windowMs;
    while (entry.start < entry.times.length && (entry.times[entry.start] ?? 0) <= since) {
      entry.start += 1;
    }
    if (entry.start === entry.times.length) {
      events.delete(key);
      return undefined;
    }
    // Compacting once half the array has left keeps each drop amortized O(1).
    if (entry.start * 2 >= entry.times.length) {
      entry.times = entry.times.slice(entry.start);
      entry.start = 0;
    }
    return entry;
  };

  return {
    record: (key: string) => {
      const entry = recent(key);
      const time = now();
      if (entry === undefined) {
        events.set(key, { start: 0, times: [time] });
        return;
      }
      // A wall clock that stepped back records out of order: insert the time
      // in its place, so it still leaves from the front. Usually it is last.
      const { times } = entry;
      let at = times.length;
      while (at > entry.start && (times[at - 1] ?? 0) > time) {
        at -= 1;
      }
      times.splice(at, 0, time);
    },
    // Milliseconds until one more event under the key stays within the limit;
    // 0 when it does now.
    wait: (key: string) => {
      const entry = recent(key);
      if (entry === undefined || entry.times.length - entry.start < limit) {
        return 0;
      }
      const oldestCounted = entry.times[entry.times.length - limit] ?? 0;
      return oldestCounted + windowMs - now();
    },
  };
};

// The key a registration source counts under: an IPv4 address as is, an IPv6
// address by its /64 prefix, so one host cannot multiply its share by
// rotating addresses within its own network. An IPv4-mapped IPv6 address
// counts as its IPv4 address.
export const sourceKey = (address: string) => {
  const [plain = ''] = address.split('%');
  if (!isIPv6(plain)) {
    return address;
  }
  const groups = ipv6Groups(plain);
  const [g6 = 0, g7 = 0] = groups.slice(6);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 65_535) {
    return [g6 >> 8, g6 % 256, g7 >> 8, g7 % 256].join('.');
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
};
