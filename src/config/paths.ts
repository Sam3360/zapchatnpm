/**
 * Where zapchat keeps its (tiny) local configuration.
 *
 * Nothing here is synced anywhere: the config file holds a username, a client
 * id and the last room you visited.
 */

import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_ENV = 'ZAPCHAT_CONFIG_DIR';
export const CONFIG_FILE_NAME = 'config.json';

export interface PathEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Resolve the directory that holds zapchat's config file. */
export function resolveConfigDir(options: PathEnvironment = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();

  const override = env[CONFIG_DIR_ENV];
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override.trim());
  }

  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const base =
      typeof appData === 'string' && appData.trim().length > 0
        ? appData
        : path.join(home, 'AppData', 'Roaming');
    return path.join(base, 'zapchat');
  }

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'zapchat');
  }

  const xdg = env['XDG_CONFIG_HOME'];
  const base =
    typeof xdg === 'string' && xdg.trim().length > 0 ? xdg : path.join(home, '.config');
  return path.join(base, 'zapchat');
}

export function resolveConfigPath(options: PathEnvironment = {}): string {
  return path.join(resolveConfigDir(options), CONFIG_FILE_NAME);
}
