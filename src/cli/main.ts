#!/usr/bin/env node
/**
 * zapchat entry point.
 *
 * Responsibilities are deliberately narrow: parse arguments, fail with a plain
 * explanation when something is wrong, start the client, and hand over to the
 * TUI or the headless loop. All networking lives in `core/client.ts`.
 */

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ZapClient } from '../core/client.js';
import { DEFAULT_ROOM, DEFAULT_TCP_PORT_BASE } from '../protocol/constants.js';
import { isValidHost } from '../protocol/sanitize.js';
import { runTui } from '../tui/render.js';
import { HELP_TEXT, parseArgs, splitTarget } from './args.js';
import { runHeadless } from './headless.js';
import { APP_NAME, VERSION } from '../version.js';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    process.stderr.write(`${APP_NAME}: ${parsed.error}\n`);
    process.stderr.write(`run \`${APP_NAME} --help\` for usage\n`);
    return 1;
  }

  const options = parsed.options;

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const interactive =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env['TERM'] !== 'dumb';

  if (!options.headless && !interactive) {
    process.stderr.write(
      `${APP_NAME} needs an interactive terminal.\n` +
        `  · run it directly in a terminal (not through a pipe or in CI), or\n` +
        `  · use \`${APP_NAME} --headless\` for plain text scripting.\n`,
    );
    return 1;
  }

  const client = new ZapClient({
    ...(options.name === undefined ? {} : { username: options.name }),
    // Headless starts in a room so scripts and tests are immediately useful;
    // the TUI lands in the lobby so the user can see what is on the LAN.
    room: options.headless ? (options.room ?? DEFAULT_ROOM) : (options.room ?? null),
    discovery: options.discovery,
    allowPlaintext: options.allowPlaintext,
    ...(options.discoveryPort === undefined ? {} : { discoveryPort: options.discoveryPort }),
    ...(options.multicastAddress === undefined ? {} : { multicastAddress: options.multicastAddress }),
    ...(options.tcpPort === undefined ? {} : { tcpPortBase: options.tcpPort }),
    log: (message, level) => {
      if (level === 'error') {
        process.stderr.write(`${APP_NAME}: ${message}\n`);
      }
    },
  });

  try {
    await client.start();
  } catch (error) {
    process.stderr.write(`${APP_NAME}: ${(error as Error).message}\n`);
    return 1;
  }

  if (options.connect !== undefined) {
    await connectDirectly(client, options.connect);
  }

  try {
    if (options.headless) {
      await runHeadless({ client });
    } else {
      await runTui({ client, alternateScreen: options.alternateScreen });
    }
  } finally {
    await client.stop();
  }

  return 0;
}

async function connectDirectly(client: ZapClient, target: string): Promise<void> {
  const [host, portText] = splitTarget(target);
  const port = portText === undefined || portText === '' ? undefined : Number(portText);

  if (!isValidHost(host)) {
    process.stderr.write(`${APP_NAME}: "${host}" is not a valid host\n`);
    return;
  }

  const result = await client.manualConnect(host, port);
  if (!result.ok) {
    process.stderr.write(
      `${APP_NAME}: ${result.error ?? 'could not connect'}\n` +
        `  (the peer must be running, and its TCP port must be reachable — by default ${DEFAULT_TCP_PORT_BASE})\n`,
    );
  }
}

/**
 * True when `modulePath` is the script the process was started with.
 *
 * The naive comparison (argv[1] === this file's path) is not enough on Unix:
 * `npm install -g` symlinks the bin (e.g. /opt/homebrew/bin/zapchat ->
 * ../lib/node_modules/zapchat/dist/cli/main.js), Node then sets argv[1] to
 * the *symlink* while the module knows its *realpath* — the two never
 * matched, so main() never ran and the command exited silently on macOS and
 * Linux (every version since v2; Windows was spared because its .cmd shim
 * passes the real path). Compare realpaths so symlinked installs work.
 *
 * `resolve` is injectable so tests can reproduce the Mac case without
 * needing symlink privileges.
 */
export function isDirectRunOf(
  modulePath: string,
  entryArg: string | undefined,
  resolve: (path: string) => string = p => realpathSync(p),
): boolean {
  if (entryArg === undefined) {
    return false;
  }

  try {
    return resolve(entryArg) === resolve(modulePath);
  } catch {
    // Unresolvable path: not a match we can prove.
    return false;
  }
}

if (isDirectRunOf(fileURLToPath(import.meta.url), process.argv[1])) {
  void main()
    .then(code => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${APP_NAME}: unexpected failure — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
