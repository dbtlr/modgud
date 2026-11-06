import { isIPv6 } from 'node:net';

// A sliding-window count of events per key: at most `limit` in any
// `windowMs`. Memory stays bounded by the events recorded within one window.
export const createWindowLimit = ({
  limit,
  now,
  windowMs,
}: {
  limit: number;
  now: () => number;
  windowMs: number;
}) => {
  // Each key's event times within the window, oldest first.
  const events = new Map<string, number[]>();

  const recent = (key: string) => {
    const since = now() - windowMs;
    const times = (events.get(key) ?? []).filter((time) => time > since);
    if (times.length === 0) {
      events.delete(key);
    } else {
      events.set(key, times);
    }
    return times;
  };

  return {
    record: (key: string) => {
      events.set(key, [...recent(key), now()]);
    },
    // Milliseconds until one more event under the key stays within the limit;
    // 0 when it does now.
    wait: (key: string) => {
      const times = recent(key);
      const oldestCounted = times[times.length - limit];
      return oldestCounted === undefined ? 0 : oldestCounted + windowMs - now();
    },
  };
};

// The 16-bit groups written in one side of an IPv6 address's `::`.
const hexGroups = (part: string) =>
  part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));

// The eight 16-bit groups of an IPv6 address, written in any valid form.
const ipv6Groups = (address: string): number[] => {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const front = hexGroups(head);
  const back = tail === undefined ? [] : hexGroups(tail);
  return [...front, ...Array.from({ length: 8 - front.length - back.length }, () => 0), ...back];
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
