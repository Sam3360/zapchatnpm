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
import { sanitizeRoomName, sanitizeUsername } from '../protocol/sanitize.js';
import { createClientId, defaultUsername } from './identity.js';
import { resolveConfigPath, type PathEnvironment } from './paths.js';

export const CONFIG_VERSION = 1;

export interface Config {
  version: number;
  clientId: string;
  /** Empty string means "ask the user on first launch". */
  username: string;
  lastRoom: string;
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
    createdAt: now,
    updatedAt: now,
  };
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
