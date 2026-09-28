import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';
import {
  broadcastFor,
  describeNetwork,
  intToIpv4,
  ipv4ToInt,
  isPrivateAddress,
  listLocalInterfaces,
  localAddresses,
  localBroadcasts,
  netmaskPrefix,
} from '../../src/network/interfaces.js';
import { explainSocketError } from '../../src/discovery/discovery.js';

function iface(
  address: string,
  netmask: string,
  options: { internal?: boolean } = {},
): os.NetworkInterfaceInfoIPv4 {
  return {
    address,
    netmask,
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: options.internal ?? false,
    cidr: `${address}/${netmaskPrefix(netmask)}`,
  };
}

const ipv6Interface: os.NetworkInterfaceInfoIPv6 = {
  address: 'fe80::1',
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: 'fe80::1/64',
  scopeid: 0,
};

function errorWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

describe('ipv4 helpers', () => {
  it('converts addresses to integers and back', () => {
    assert.equal(ipv4ToInt('0.0.0.0'), 0);
    assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
    assert.equal(ipv4ToInt('192.168.1.42'), 3232235818);
    assert.equal(intToIpv4(3232235818), '192.168.1.42');

    for (const address of ['10.0.0.1', '172.16.5.9', '127.0.0.1', '192.168.255.254']) {
      assert.equal(intToIpv4(ipv4ToInt(address)!), address);
    }
  });

  it('returns null for malformed addresses', () => {
    assert.equal(ipv4ToInt('192.168.1'), null);
    assert.equal(ipv4ToInt('192.168.1.256'), null);
    assert.equal(ipv4ToInt('192.168.1.x'), null);
    assert.equal(ipv4ToInt(''), null);
  });

  it('computes directed broadcast addresses', () => {
    assert.equal(broadcastFor('192.168.1.42', '255.255.255.0'), '192.168.1.255');
    assert.equal(broadcastFor('10.4.9.7', '255.255.0.0'), '10.4.255.255');
    assert.equal(broadcastFor('172.16.3.9', '255.255.252.0'), '172.16.3.255');
    assert.equal(broadcastFor('bad', '255.255.255.0'), null);
  });

  it('counts netmask bits', () => {
    assert.equal(netmaskPrefix('255.255.255.0'), 24);
    assert.equal(netmaskPrefix('255.255.0.0'), 16);
    assert.equal(netmaskPrefix('255.255.255.128'), 25);
    assert.equal(netmaskPrefix('255.255.255.255'), 32);
    assert.equal(netmaskPrefix('0.0.0.0'), 0);
  });

  it('detects private ranges', () => {
    assert.equal(isPrivateAddress('192.168.1.1'), true);
    assert.equal(isPrivateAddress('10.255.255.255'), true);
    assert.equal(isPrivateAddress('172.16.0.1'), true);
    assert.equal(isPrivateAddress('172.32.0.1'), false);
    assert.equal(isPrivateAddress('8.8.8.8'), false);
    assert.equal(isPrivateAddress('nonsense'), false);
  });
});

describe('interface enumeration', () => {
  const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
    Loopback: [iface('127.0.0.1', '255.0.0.0', { internal: true })],
    Ethernet: [iface('192.168.1.42', '255.255.255.0')],
    'vEthernet (WSL)': [iface('172.20.16.1', '255.255.240.0')],
    LinkLocal: [iface('169.254.10.20', '255.255.0.0')],
    'Wi-Fi': [ipv6Interface],
    undefinedEntry: undefined,
  };

  it('keeps usable IPv4 interfaces and skips the rest', () => {
    const entries = listLocalInterfaces(interfaces);
    assert.deepEqual(
      entries.map(entry => [entry.name, entry.address, entry.broadcast]),
      [
        ['Ethernet', '192.168.1.42', '192.168.1.255'],
        ['vEthernet (WSL)', '172.20.16.1', '172.20.31.255'],
      ],
    );
  });

  it('advertises private addresses first', () => {
    const withPublic: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      Ethernet: [iface('192.168.1.42', '255.255.255.0')],
      Corporate: [iface('203.0.113.9', '255.255.255.0')],
    };

    assert.deepEqual(localAddresses(withPublic), ['192.168.1.42', '203.0.113.9']);
  });

  it('de-duplicates broadcast addresses', () => {
    const doubled: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      a: [iface('10.0.0.5', '255.255.255.0')],
      b: [iface('10.0.0.6', '255.255.255.0')],
    };

    assert.deepEqual(localBroadcasts(doubled), ['10.0.0.255']);
  });

  it('describes the LAN in one line', () => {
    assert.equal(describeNetwork(interfaces), '192.168.1.42/24, 172.20.16.1/20');
    assert.equal(describeNetwork({}), 'no LAN interfaces detected');
  });
});

describe('discovery error messages', () => {
  it('explains message and provides a way forward', () => {
    assert.match(explainSocketError(errorWithCode('EADDRINUSE'), 45912), /45912/);
    assert.match(explainSocketError(errorWithCode('EADDRINUSE'), 45912), /\/connect/);
    assert.match(explainSocketError(errorWithCode('EACCES'), 45912), /permission denied/i);
    assert.match(explainSocketError(errorWithCode('ENETUNREACH'), 45912), /no route/i);
    assert.match(explainSocketError(errorWithCode('EWHATEVER'), 45912), /\/connect/);
  });
});
