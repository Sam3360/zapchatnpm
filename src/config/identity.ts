/**
 * Local identity: a stable client id for this machine/installation and a
 * sensible default username.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { sanitizeUsername } from '../protocol/sanitize.js';

const CLIENT_ID_PREFIX = 'zc-';

/** Stable, opaque id for this installation. Generated once and kept in config. */
export function createClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomUUID()}`;
}

/**
 * Best-effort default username: the operating system account name when it is a
 * legal username, otherwise a random `zapper-xxxx` handle.
 */
export function defaultUsername(): string {
  try {
    const account = os.userInfo().username;
    const sanitised = sanitizeUsername(account);
    if (sanitised !== null) {
      return sanitised;
    }
  } catch {
    // os.userInfo() can throw in stripped-down containers; fall through.
  }

  return randomUsername();
}

/** Random friendly handle used when we cannot derive one from the OS. */
export function randomUsername(): string {
  const suffix = randomUUID().replace(/[^a-f0-9]/g, '').slice(0, 4);
  return `zapper-${suffix}`;
}
