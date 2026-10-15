/**
 * Input sanitisation and validation helpers.
 *
 * Everything that arrives from the network is treated as untrusted text. Chat
 * bodies are *sanitised* (control characters and ANSI escapes stripped) while
 * structural fields such as usernames, room names and client ids are *validated*
 * and rejected outright when they do not match the expected shape.
 */

import {
  MAX_MESSAGE_CHARS,
  MAX_ROOM_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
} from './constants.js';

/** CSI / OSC / two-char escape sequences. */
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/** C0 controls (minus \t) plus DEL and C1 controls. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Characters allowed inside a username (Unicode letters/digits plus . _ -). */
const USERNAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Characters allowed inside a room name (Unicode letters/digits plus space . _ -). */
const ROOM_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

/** Client ids are opaque, but must be boring enough to embed in logs and keys. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/**
 * Remove ANSI escape sequences and control characters from arbitrary text.
 * This is the single most important protection for the TUI: a message body
 * containing escape sequences could otherwise move the cursor or repaint the
 * terminal.
 */
export function stripControlSequences(input: string): string {
  return input.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '');
}

/** Unicode-aware truncation by code points (never splits a surrogate pair). */
export function truncateChars(input: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }

  const codePoints = Array.from(input);
  return codePoints.length <= maxChars ? input : codePoints.slice(0, maxChars).join('');
}

/**
 * Normalise a chat message: strip control sequences, collapse all runs of
 * whitespace (including newlines and tabs) into a single space, then trim and
 * truncate. Returns an empty string when nothing printable is left.
 */
export function sanitizeMessageText(
  input: string,
  maxChars: number = MAX_MESSAGE_CHARS,
): string {
  const cleaned = stripControlSequences(input.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim();

  return truncateChars(cleaned, maxChars);
}

/** Count Unicode code points (what users think of as characters). */
export function charLength(input: string): number {
  return Array.from(input).length;
}

/**
 * Sanitise a username typed by a human. Returns `null` when the result is not a
 * usable username, so callers can show a precise error.
 */
export function sanitizeUsername(
  input: string,
  maxLength: number = MAX_USERNAME_LENGTH,
): string | null {
  const cleaned = stripControlSequences(input.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    return null;
  }

  if (charLength(cleaned) > maxLength) {
    return null;
  }

  return USERNAME_PATTERN.test(cleaned) ? cleaned : null;
}

export function isValidUsername(input: unknown): input is string {
  return typeof input === 'string' && sanitizeUsername(input) === input;
}

/**
 * Sanitise a room name. Room names are case-insensitive and canonicalised to
 * lower case so `#General` and `#general` are the same room on the LAN.
 */
export function sanitizeRoomName(
  input: string,
  maxLength: number = MAX_ROOM_NAME_LENGTH,
): string | null {
  const cleaned = stripControlSequences(input.normalize('NFC'))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (cleaned.length === 0) {
    return null;
  }

  if (charLength(cleaned) > maxLength) {
    return null;
  }

  return ROOM_PATTERN.test(cleaned) ? cleaned : null;
}

export function isValidRoomName(input: unknown): input is string {
  return typeof input === 'string' && sanitizeRoomName(input) === input;
}

export function isValidClientId(input: unknown): input is string {
  return typeof input === 'string' && CLIENT_ID_PATTERN.test(input);
}

/** IPv4 dotted quad, each octet 0-255. */
export function isValidIpv4(input: string): boolean {
  if (!IPV4_PATTERN.test(input)) {
    return false;
  }

  return input.split('.').every(part => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255 && String(value) === part;
  });
}

/**
 * Accept an IPv4 address or a DNS-style hostname. Rejects anything with scheme,
 * path, port or whitespace so it can only ever be used as a connect target.
 */
/**
 * Validate an IPv6 literal, optionally with a zone id (`fe80::1%eth0`).
 *
 * Written out rather than delegated to the URL parser so the accepted grammar
 * is exactly what we will put in a socket call: up to eight groups of 1-4 hex
 * digits, at most one `::` elision, and an optional trailing IPv4 quad (which
 * counts as the last two groups).
 */
export function isValidIpv6(input: unknown): boolean {
  if (typeof input !== 'string' || input.length === 0 || input.length > 45) {
    return false;
  }

  // A zone id is only meaningful on link-local, and never contains ':'.
  let address = input;
  const zoneAt = address.indexOf('%');
  if (zoneAt !== -1) {
    const zone = address.slice(zoneAt + 1);
    address = address.slice(0, zoneAt);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(zone)) {
      return false;
    }
  }

  if (address.length === 0 || !address.includes(':')) {
    return false;
  }

  const doubleColons = address.split('::').length - 1;
  if (doubleColons > 1) {
    return false;
  }

  const [head, tail] = address.split('::') as [string, string | undefined];
  // Groups before and after the elision; the trailing part may be empty.
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups =
    tail === undefined || tail === '' ? [] : (tail as string).split(':');

  let groups = 0;
  const allGroups = [...headGroups, ...tailGroups];
  for (const [index, group] of allGroups.entries()) {
    // A trailing IPv4 quad (`::ffff:192.168.0.1`) stands in for two groups.
    const isLast = index === allGroups.length - 1;
    if (group.includes('.')) {
      if (!isLast || !isValidIpv4(group)) {
        return false;
      }

      groups += 2;
      continue;
    }

    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) {
      return false;
    }

    groups += 1;
  }

  // With `::` any count below eight is legal (it stands for the elided zeros);
  // without it the address must be exactly full.
  return doubleColons === 1 ? groups <= 8 : groups === 8;
}

export function isValidHost(input: unknown): input is string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 253) {
    return false;
  }

  // A host with a colon can only be an IPv6 literal (the `[addr]:port` form is
  // split off before this runs); a hostname never contains one.
  if (input.includes(':')) {
    return isValidIpv6(input);
  }

  if (input.includes(' ') || input.includes('/')) {
    return false;
  }

  // Anything that looks like a dotted quad must actually be a valid IPv4
  // address: `999.1.1.1` is a typo, not a hostname.
  if (/^\d+(?:\.\d+)*$/.test(input)) {
    return isValidIpv4(input);
  }

  return HOSTNAME_PATTERN.test(input);
}

export function isValidPort(input: unknown): input is number {
  return (
    typeof input === 'number' &&
    Number.isInteger(input) &&
    input > 0 &&
    input <= 65535
  );
}

/** Sanitise an IP address list (used for advertised addresses in beacons). */
export function sanitizeAddressList(
  input: unknown,
  max: number,
): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  for (const candidate of input) {
    if (typeof candidate === 'string' && isValidIpv4(candidate)) {
      seen.add(candidate);
    }

    if (typeof candidate === 'string' && isValidIpv6(candidate)) {
      // Never advertise a zone id: it is local to this machine and means
      // nothing to a peer.
      const address = (candidate.split('%') as [string])[0];
      if (seen.size < max) {
        seen.add(address);
      }
    }

    if (seen.size >= max) {
      break;
    }
  }

  return [...seen];
}
