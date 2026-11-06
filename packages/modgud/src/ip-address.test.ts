import { describe, expect, test } from 'bun:test';

import { isPublicUnicastAddress } from './ip-address.ts';

const NO_INTERFACES: string[] = [];

describe('public unicast addresses', () => {
  test.each([
    ['a public IPv4 address', '93.184.215.14'],
    ['another public IPv4 address', '8.8.8.8'],
    ['a public IPv6 address', '2606:4700:4700::1111'],
    ['the IPv4-mapped form of a public address', '::ffff:8.8.8.8'],
  ])('accepts %s', (_, address) => {
    expect(isPublicUnicastAddress(address, NO_INTERFACES)).toBe(true);
  });

  test.each([
    ['unspecified IPv4', '0.0.0.0'],
    ['"this network"', '0.1.2.3'],
    ['private 10/8', '10.1.2.3'],
    ['shared 100.64/10, which holds tailnet addresses', '100.101.225.33'],
    ['loopback', '127.0.0.1'],
    ['link-local', '169.254.169.254'],
    ['private 172.16/12', '172.31.255.255'],
    ['IETF protocol assignments', '192.0.0.8'],
    ['TEST-NET-1', '192.0.2.10'],
    ['6to4 relay anycast', '192.88.99.1'],
    ['private 192.168/16', '192.168.1.1'],
    ['benchmarking', '198.19.0.1'],
    ['TEST-NET-2', '198.51.100.7'],
    ['TEST-NET-3', '203.0.113.9'],
    ['multicast', '224.0.0.251'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['unspecified IPv6', '::'],
    ['IPv6 loopback', '::1'],
    ['an IPv4-mapped private address', '::ffff:10.0.0.1'],
    ['an IPv4-mapped loopback address in hex', '::ffff:7f00:1'],
    ['an IPv4-mapped tailnet address', '::ffff:100.64.0.1'],
    ['an IPv4-compatible private address', '::192.168.0.1'],
    ['NAT64 64:ff9b::/96', '64:ff9b::808:808'],
    ['NAT64 64:ff9b::/96 in dotted form', '64:ff9b::10.0.0.1'],
    ['local-use NAT64 64:ff9b:1::/48', '64:ff9b:1::1'],
    ['discard-only', '100::1'],
    ['Teredo', '2001::1'],
    ['IPv6 benchmarking', '2001:2::1'],
    ['IPv6 documentation', '2001:db8::1'],
    ['6to4', '2002:c000:0204::1'],
    ['IPv6 documentation 3fff::/20', '3fff::1'],
    ['unique-local', 'fd00::1'],
    ['a tailnet IPv6 address', 'fd7a:115c:a1e0::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['site-local', 'fec0::1'],
    ['IPv6 multicast', 'ff02::1'],
    ['outside global unicast', '4000::1'],
    ['not an address', 'example.com'],
  ])('refuses %s', (_, address) => {
    expect(isPublicUnicastAddress(address, NO_INTERFACES)).toBe(false);
  });

  test("refuses an address of the host's own interfaces, in any written form", () => {
    const own = ['152.53.195.163', '2a0a:4cc0:2000:b273::1', 'fe80::1%eth0'];

    expect(isPublicUnicastAddress('152.53.195.163', own)).toBe(false);
    expect(isPublicUnicastAddress('::ffff:152.53.195.163', own)).toBe(false);
    expect(isPublicUnicastAddress('2a0a:4cc0:2000:b273:0:0:0:1', own)).toBe(false);
    expect(isPublicUnicastAddress('152.53.195.164', own)).toBe(true);
  });
});
