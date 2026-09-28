/**
 * Local network interface helpers.
 *
 * Discovery needs two things from the OS: the addresses we can advertise, and
 * the directed broadcast address of every subnet we are on (broadcasting to
 * 255.255.255.255 alone is unreliable on multi-homed machines).
 */

import os from 'node:os';

export interface LocalInterface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

export function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }

    value = (value << 8) | octet;
  }

  return value >>> 0;
}

export function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.');
}

/** Directed broadcast address for `address` inside `netmask`. */
export function broadcastFor(address: string, netmask: string): string | null {
  const addressInt = ipv4ToInt(address);
  const maskInt = ipv4ToInt(netmask);
  if (addressInt === null || maskInt === null) {
    return null;
  }

  return intToIpv4((addressInt & maskInt) | (~maskInt >>> 0));
}

/**
 * IPv4 interfaces that are worth talking on: up, not loopback, not link-local.
 * Link-local (169.254/16) addresses are advertised by APIPA-only machines and
 * cannot reach anything useful, so they are skipped.
 */
export function listLocalInterfaces(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LocalInterface[] {
  const result: LocalInterface[] = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (entries === undefined) {
      continue;
    }

    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }

      if (entry.address.startsWith('169.254.')) {
        continue;
      }

      const broadcast = broadcastFor(entry.address, entry.netmask);
      if (broadcast === null) {
        continue;
      }

      result.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        broadcast,
      });
    }
  }

  return result;
}

/** Advertised addresses, most-globally-useful first. */
export function localAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const addresses = listLocalInterfaces(interfaces).map(entry => entry.address);
  return [
    ...addresses.filter(isPrivateAddress),
    ...addresses.filter(address => !isPrivateAddress(address)),
  ];
}

/** RFC1918 ranges — the ones that actually appear on home/office LANs. */
export function isPrivateAddress(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) {
    return false;
  }

  return (
    (value >= ipv4ToInt('10.0.0.0')! && value <= ipv4ToInt('10.255.255.255')!) ||
    (value >= ipv4ToInt('172.16.0.0')! && value <= ipv4ToInt('172.31.255.255')!) ||
    (value >= ipv4ToInt('192.168.0.0')! && value <= ipv4ToInt('192.168.255.255')!)
  );
}

/** Unique directed broadcast addresses for every usable interface. */
export function localBroadcasts(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  return [...new Set(listLocalInterfaces(interfaces).map(entry => entry.broadcast))];
}

/** One-line summary of the LAN we think we are on, for the UI. */
export function describeNetwork(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  const entries = listLocalInterfaces(interfaces);
  if (entries.length === 0) {
    return 'no LAN interfaces detected';
  }

  return entries
    .map(entry => `${entry.address}/${netmaskPrefix(entry.netmask)}`)
    .join(', ');
}

export function netmaskPrefix(netmask: string): number {
  const value = ipv4ToInt(netmask);
  if (value === null) {
    return 0;
  }

  let bits = 0;
  for (let i = 31; i >= 0; i -= 1) {
    if ((value >>> i) & 1) {
      bits += 1;
    } else {
      break;
    }
  }

  return bits;
}
