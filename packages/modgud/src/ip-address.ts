import { isIPv4, isIPv6 } from 'node:net';

// IP address arithmetic for registration limits and for the addresses a
// Client ID Metadata Document may be fetched from (docs/oauth.md, "Client
// metadata documents").

// The 16-bit groups written in one side of an IPv6 address's `::`.
const hexGroups = (part: string) =>
  part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));

// The eight 16-bit groups of an IPv6 address, written in any valid form.
export const ipv6Groups = (address: string): number[] => {
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

type Address = { bits: 32 | 128; value: bigint };

const parseIPv4 = (address: string): Address => ({
  bits: 32,
  value: address.split('.').reduce((value, part) => (value << 8n) | BigInt(part), 0n),
});

const parseIPv6 = (address: string): Address => ({
  bits: 128,
  value: ipv6Groups(address).reduce((value, group) => (value << 16n) | BigInt(group), 0n),
});

// An address as a number, without any IPv6 zone; undefined when it is not one.
const parseAddress = (written: string): Address | undefined => {
  const [address = ''] = written.split('%');
  if (isIPv4(address)) {
    return parseIPv4(address);
  }
  return isIPv6(address) ? parseIPv6(address) : undefined;
};

type Range = { address: Address; prefix: number };

const range = (cidr: string): Range => {
  const [base = '', prefix = ''] = cidr.split('/');
  const address = parseAddress(base);
  if (address === undefined) {
    throw new Error(`Not a CIDR range: ${cidr}`);
  }
  return { address, prefix: Number(prefix) };
};

const inRange = (address: Address, { address: base, prefix }: Range) => {
  const shift = BigInt(address.bits - prefix);
  return address.bits === base.bits && address.value >> shift === base.value >> shift;
};

// The IPv4 special-purpose ranges of RFC 6890 and its IANA registry, with
// multicast and the reserved block.
const REFUSED_IPV4 = [
  '0.0.0.0/8', // "this network", including unspecified
  '10.0.0.0/8', // private
  '100.64.0.0/10', // shared, which holds tailnet addresses
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, including broadcast
].map(range);

// IPv6 global unicast. Everything outside it is special-use or unassigned,
// which covers unspecified, loopback, NAT64 (64:ff9b::/96 and
// 64:ff9b:1::/48), discard-only, unique-local, link-local, and multicast.
const IPV6_GLOBAL_UNICAST = range('2000::/3');

// The special-purpose ranges inside global unicast.
const REFUSED_IPV6 = [
  '2001::/23', // IETF protocol assignments: Teredo, benchmarking, ORCHID
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4, which embeds any IPv4 address
  '3fff::/20', // documentation
].map(range);

// IPv6 forms that carry an IPv4 address in their last 32 bits.
const IPV4_MAPPED = range('::ffff:0:0/96');
const IPV4_COMPATIBLE = range('::/96');

// The IPv4 address an IPv4-mapped or IPv4-compatible IPv6 address carries.
const embeddedIPv4 = (address: Address): Address | undefined =>
  inRange(address, IPV4_MAPPED) || inRange(address, IPV4_COMPATIBLE)
    ? { bits: 32, value: address.value % (1n << 32n) }
    : undefined;

const isSame = (a: Address, b: Address) => a.bits === b.bits && a.value === b.value;

// Whether an address is a public unicast address that is not one of the
// host's own: the only kind Modgud fetches a metadata document from.
// `ownAddresses` are the addresses of the host's interfaces, in any form.
export const isPublicUnicastAddress = (written: string, ownAddresses: readonly string[]) => {
  const parsed = parseAddress(written);
  if (parsed === undefined) {
    return false;
  }
  const address = embeddedIPv4(parsed) ?? parsed;
  const own = ownAddresses
    .map(parseAddress)
    .map((ownAddress) =>
      ownAddress === undefined ? undefined : (embeddedIPv4(ownAddress) ?? ownAddress),
    );
  if (own.some((ownAddress) => ownAddress !== undefined && isSame(ownAddress, address))) {
    return false;
  }
  if (address.bits === 32) {
    return !REFUSED_IPV4.some((refused) => inRange(address, refused));
  }
  return (
    inRange(address, IPV6_GLOBAL_UNICAST) &&
    !REFUSED_IPV6.some((refused) => inRange(address, refused))
  );
};
