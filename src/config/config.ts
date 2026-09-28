/**
 * Local configuration file handling.
 *
 * The file is intentionally minimal: a client id (identity for this install),
 * the chosen username and the last room we were in. There is no chat history
 * and no personal data beyond what the user typed.
 *
 * Reads are defensive: a corrupt or hand-edited file is repaired, never fatal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROOM, MAX_USERNAME_LENGTH } from '../protocol/constants.js';
import { generatePrivateKey, identityPublicFromSeed, publicKeyId } from '../protocol/crypto.js';
import { sanitizeRoomName, sanitizeUsername } from '../protocol/sanitize.js';
import { createClientId, defaultUsername } from './identity.js';
import { resolveConfigPath, type PathEnvironment } from './paths.js';

export const CONFIG_VERSION = 1;

/** A pinned peer public key (TOFU), persisted so it survives restarts. */
export interface PeerPin {
  keyId: string;
  seenAt: number;
}

export interface Config {
  version: number;
  clientId: string;
  /** Empty string means "ask the user on first launch". */
  username: string;
  lastRoom: string;
  /** Base64 of our long-term X25519 identity private key (protocol v2). */
  identityKey: string;
  /** Peer public-key pins for TOFU checking, keyed by client id. */
  peerPins: Record<string, PeerPin>;
  createdAt: number;
  updatedAt: number;
}

export interface LoadConfigOptions extends PathEnvironment {
  /** Explicit config file path (tests). Overrides directory resolution. */
  configPath?: string;
  /** Current time, injectable for tests. */
  now?: number;
}

export interface LoadConfigResult {
  config: Config;
  /** Absolute path of the config file that was read or created. */
  path: string;
  /** True when the file did not exist and defaults were written. */
  created: boolean;
  /** Human-readable note when something had to be repaired. */
  warning?: string;
}

export function resolvePathFor(options: LoadConfigOptions = {}): string {
  return options.configPath ?? resolveConfigPath(options);
}

function buildDefaultConfig(now: number, username = ''): Config {
  return {
    version: CONFIG_VERSION,
    clientId: createClientId(),
    username,
    lastRoom: DEFAULT_ROOM,
    identityKey: generateIdentityKey(),
    peerPins: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Generate a new long-term identity seed (Ed25519, stored base64 in the config). */
function generateIdentityKey(): string {
  return generatePrivateKey().toString('base64');
}

/** True when `value` decodes to a usable 32-byte Ed25519 identity seed. */
function isValidIdentityKey(value: string): boolean {
  if (value.length === 0 || value.length > 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }

  try {
    identityPublicFromSeed(Buffer.from(value, 'base64'));
    return true;
  } catch {
    return false;
  }
}

/** Our long-term identity public key, derived from the stored seed. */
export function identityPublicKey(config: Config): Buffer {
  return identityPublicFromSeed(Buffer.from(config.identityKey, 'base64'));
}

/** Fingerprint of our long-term identity public key (for /status display). */
export function identityKeyId(config: Config): string {
  return publicKeyId(identityPublicKey(config));
}

/**
 * Coerce arbitrary parsed JSON into a valid `Config`, repairing or replacing
 * individual fields and reporting what changed.
 */
function normaliseConfig(raw: unknown, now: number): { config: Config; warning?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: buildDefaultConfig(now), warning: 'config file was not an object' };
  }

  const source = raw as Record<string, unknown>;
  const notes: string[] = [];

  const clientId =
    typeof source['clientId'] === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(source['clientId'])
      ? source['clientId']
      : null;
  if (clientId === null) {
    notes.push('regenerated client id');
  }

  let username = '';
  if (typeof source['username'] === 'string') {
    username = sanitizeUsername(source['username'], MAX_USERNAME_LENGTH) ?? '';
    if (username === '' && source['username'].trim().length > 0) {
      notes.push('ignored unusable stored username');
    }
  }

  let lastRoom = DEFAULT_ROOM;
  if (typeof source['lastRoom'] === 'string') {
    lastRoom = sanitizeRoomName(source['lastRoom']) ?? DEFAULT_ROOM;
  }

  let identityKey = typeof source['identityKey'] === 'string' ? source['identityKey'] : '';
  if (!isValidIdentityKey(identityKey)) {
    if (identityKey !== '') {
      notes.push('regenerated unusable identity key');
    }

    identityKey = generateIdentityKey();
  }

  const peerPins: Record<string, PeerPin> = {};
  const rawPins = source['peerPins'];
  if (typeof rawPins === 'object' && rawPins !== null && !Array.isArray(rawPins)) {
    for (const [id, pin] of Object.entries(rawPins as Record<string, unknown>)) {
      if (id.length === 0 || id.length > 64 || typeof pin !== 'object' || pin === null) {
        continue;
      }

      const record = pin as Record<string, unknown>;
      if (
        typeof record['keyId'] === 'string' &&
        record['keyId'].length > 0 &&
        record['keyId'].length <= 64 &&
        typeof record['seenAt'] === 'number' &&
        Number.isFinite(record['seenAt'])
      ) {
        peerPins[id] = { keyId: record['keyId'], seenAt: record['seenAt'] };
      }
    }
  }

  const createdAt =
    typeof source['createdAt'] === 'number' && Number.isFinite(source['createdAt'])
      ? source['createdAt']
      : now;

  return {
    config: {
      version: CONFIG_VERSION,
      clientId: clientId ?? createClientId(),
      username,
      lastRoom,
      identityKey,
      peerPins,
      createdAt,
      updatedAt: now,
    },
    ...(notes.length > 0 ? { warning: notes.join(', ') } : {}),
  };
}

/**
 * Load the config, creating it (with a fresh client id) when missing.
 *
 * Never throws for filesystem or parse problems: the worst case is a warning
 * plus in-memory defaults so the app still starts.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadConfigResult {
  const now = options.now ?? Date.now();
  const filePath = resolvePathFor(options);

  let contents: string;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const config = buildDefaultConfig(now, '');
      const written = trySave(config, filePath);
      return {
        config,
        path: filePath,
        created: true,
        ...(written === undefined ? {} : { warning: written }),
      };
    }

    return {
      config: buildDefaultConfig(now),
      path: filePath,
      created: false,
      warning: `could not read config (${(error as Error).message}); using defaults`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    const config = buildDefaultConfig(now);
    const written = trySave(config, filePath);
    return {
      config,
      path: filePath,
      created: false,
      warning: `config file was not valid JSON; replaced it`,
      ...(written === undefined ? {} : { warning: `${written}` }),
    };
  }

  const { config, warning } = normaliseConfig(parsed, now);
  const needsWrite = JSON.stringify(config) !== JSON.stringify(parsed);
  if (needsWrite) {
    trySave(config, filePath);
  }

  return {
    config,
    path: filePath,
    created: false,
    ...(warning === undefined ? {} : { warning }),
  };
}

function trySave(config: Config, filePath: string): string | undefined {
  try {
    saveConfigTo(config, filePath);
    return undefined;
  } catch (error) {
    return `could not write config (${(error as Error).message})`;
  }
}

/** Write the config atomically (temp file + rename) with owner-only permissions. */
export function saveConfigTo(config: Config, filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.tmp`;

  fs.writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Persist a patch over the existing config and return the merged result. */
export function updateConfig(
  patch: Partial<Omit<Config, 'version' | 'clientId' | 'createdAt'>>,
  options: LoadConfigOptions = {},
): LoadConfigResult {
  const loaded = loadConfig(options);
  const now = options.now ?? Date.now();

  const merged: Config = {
    ...loaded.config,
    ...patch,
    version: CONFIG_VERSION,
    updatedAt: now,
  };

  try {
    saveConfigTo(merged, loaded.path);
    return { ...loaded, config: merged };
  } catch (error) {
    return {
      ...loaded,
      config: merged,
      warning: `could not save config (${(error as Error).message})`,
    };
  }
}

/** Convenience used by first-run and by CLI flags. */
export function suggestedUsername(): string {
  return defaultUsername();
}
