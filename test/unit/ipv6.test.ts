import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isValidHost,
  isValidIpv6,
  sanitizeAddressList,
} from '../../src/protocol/sanitize.js';
import { listLocalV6Addresses, localAddresses } from '../../src/network/interfaces.js';
import { splitTarget } from '../../src/cli/args.js';

describe('sanitise: IPv6 literals', () => {
  it('accepts full and compressed literals', () => {
    for (const address of [
      '::',
      '::1',
      'fe80::',
      'fe80::1',
      '2001:db8::',
      '2001:db8::8a2e:370:7334',
      '1:2:3:4:5:6:7:8',
      '2001:0db8:0000:0000:0000:ff00:0042:8329',
    ]) {
      assert.equal(isValidIpv6(address), true, address);
      assert.equal(isValidHost(address), true, address);
    }
  });

  it('accepts an embedded IPv4 quad', () => {
    assert.equal(isValidIpv6('::ffff:192.168.0.1'), true);
    assert.equal(isValidIpv6('64:ff9b::1.2.3.4'), true);
  });

  it('accepts a zone id on link-local', () => {
    assert.equal(isValidIpv6('fe80::1%eth0'), true);
    assert.equal(isValidIpv6('fe80::1%'), false);
    assert.equal(isValidIpv6('::%'), false);
  });

  it('rejects the wrong number of groups', () => {
    assert.equal(isValidIpv6('1:2:3:4:5:6:7:8:9'), false, 'nine groups');
    assert.equal(isValidIpv6('1:2:3:4:5:6:7'), false, 'seven without ::');
  });

  it('rejects two elisions', () => {
    assert.equal(isValidIpv6('1::2::3'), false);
  });

  it('rejects a leading or trailing colon', () => {
    assert.equal(isValidIpv6(':1:2:3:4:5:6:7:8'), false);
    assert.equal(isValidIpv6('1:2:3:4:5:6:7:'), false);
  });

  it('rejects out-of-range and non-hex groups', () => {
    assert.equal(isValidIpv6('gggg::1'), false);
    assert.equal(isValidIpv6('12345::1'), false);
  });

  it('rejects a malformed embedded quad', () => {
    assert.equal(isValidIpv6('1:2:3:4:5:6:1.2.3'), false);
    assert.equal(isValidIpv6('1:2:3:4:5:6:7:999.1.1.1'), false);
  });

  it('rejects IPv4 and non-strings', () => {
    assert.equal(isValidIpv6('192.168.0.1'), false);
    assert.equal(isValidIpv6(''), false);
    assert.equal(isValidIpv6(undefined), false);
  });
});

describe('sanitise: hosts with IPv6', () => {
  it('still accepts hostnames and IPv4', () => {
    assert.equal(isValidHost('example.com'), true);
    assert.equal(isValidHost('a'), true);
    assert.equal(isValidHost('192.168.1.5'), true);
  });

  it('still rejects a broken dotted quad, whitespace and slashes', () => {
    assert.equal(isValidHost('999.1.1.1'), false);
    assert.equal(isValidHost('has space'), false);
    assert.equal(isValidHost('a/b'), false);
    assert.equal(isValidHost('http://evil.example'), false);
  });

  it('a host:port pair is not a host', () => {
    assert.equal(isValidHost('192.168.1.24:45913'), false);
  });
});

describe('args: splitTarget with IPv6', () => {
  it('splits an IPv4 host and port', () => {
    assert.deepEqual(splitTarget('192.168.1.5:45913'), ['192.168.1.5', '45913']);
    assert.deepEqual(splitTarget('192.168.1.5'), ['192.168.1.5', undefined]);
  });

  it('splits a bracketed IPv6 literal', () => {
    assert.deepEqual(splitTarget('[::1]:45913'), ['::1', '45913']);
    assert.deepEqual(splitTarget('[fe80::1%eth0]:45913'), ['fe80::1%eth0', '45913']);
    assert.deepEqual(splitTarget('[::1]'), ['::1', undefined]);
  });

  it('never splits a bare IPv6 literal on its last colon', () => {
    assert.deepEqual(splitTarget('fe80::1'), ['fe80::1', undefined]);
    assert.deepEqual(splitTarget('::1'), ['::1', undefined]);
  });

  it('passes an unterminated bracket through', () => {
    assert.deepEqual(splitTarget('[::1'), ['[::1', undefined]);
  });
});

describe('sanitise: advertised address lists', () => {
  it('keeps both families and drops junk', () => {
    const result = sanitizeAddressList(
      ['192.168.1.5', 'fe80::1%eth0', 'not an address', '::1', '10.0.0.1'],
      8,
    );
    assert.deepEqual(result, ['192.168.1.5', 'fe80::1', '::1', '10.0.0.1']);
  });

  it('strips the zone id before advertising', () => {
    assert.deepEqual(sanitizeAddressList(['fe80::1%eth0'], 8), ['fe80::1']);
  });

  it('honours the cap and rejects a non-array', () => {
    assert.equal(sanitizeAddressList(['10.0.0.1', '10.0.0.2', '::1', '::2'], 2).length, 2);
    assert.deepEqual(sanitizeAddressList('192.168.1.5', 8), []);
  });
});

describe('interfaces: IPv6 enumeration', () => {
  const table = {
    eth0: [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '2001:db8::42', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: 'fd12:3456::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: true },
    ],
    eth1: [
      { address: '2001:db8::42', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    ],
  } as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

  it('keeps routable global addresses only', () => {
    // fe80::/10 link-local and fc00::/7 unique-local cannot reach a peer.
    assert.deepEqual(listLocalV6Addresses(table), ['2001:db8::42']);
  });

  it('de-duplicates an address seen on two interfaces', () => {
    assert.deepEqual(listLocalV6Addresses(table), ['2001:db8::42']);
  });

  it('advertises IPv4 first, then IPv6', () => {
    const addresses = localAddresses(table);
    assert.deepEqual(addresses, ['192.168.1.5', '2001:db8::42']);
  });
});