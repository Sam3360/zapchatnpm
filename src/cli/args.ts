/**
 * Command line parsing.
 *
 * Hand-rolled on purpose: the flag set is tiny, and a hand-rolled parser means
 * zero runtime dependencies and precise error messages.
 */

import {
  DEFAULT_DISCOVERY_PORT,
  DEFAULT_TCP_PORT_BASE,
  MAX_ROOM_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  DEFAULT_MULTICAST_ADDRESS,
} from '../protocol/constants.js';
import { isValidHost, sanitizeRoomName, sanitizeUsername } from '../protocol/sanitize.js';
import { APP_NAME, TAGLINE, VERSION } from '../version.js';

export const HELP_TEXT = `${APP_NAME} ${VERSION} — ${TAGLINE}

Usage
  ${APP_NAME} [options]

Options
  -n, --name <username>        display name (remembered between runs)
  -r, --room <room>            join this room on start
  -c, --connect <host[:port]>  connect straight to a peer, for networks that
                               block UDP discovery (default port ${DEFAULT_TCP_PORT_BASE})
      --discovery-port <port>  UDP discovery port (default ${DEFAULT_DISCOVERY_PORT})
      --multicast <address>    discovery multicast group (default ${DEFAULT_MULTICAST_ADDRESS})
      --tcp-port <port>        first TCP port to try (default ${DEFAULT_TCP_PORT_BASE})
      --no-discovery           share no beacons; manual connections only
      --allow-plaintext        permit unencrypted links to legacy (v1) peers,
                               e.g. the Python client. Off by default: chat
                               content on such links is NOT encrypted
      --inline                 render in the normal screen buffer
      --headless               plain text mode for scripting and debugging:
                               lines from stdin are sent, incoming messages print
  -h, --help                   show this help
  -v, --version                print the version

Inside the app
  Type /help for the command list. Ctrl+C leaves cleanly.

Privacy
  zapchat only talks to your local network. No accounts, no servers, no
  telemetry, and messages are never sent anywhere else.
`;

export interface CliOptions {
  help: boolean;
  version: boolean;
  name?: string;
  room?: string;
  connect?: string;
  headless: boolean;
  discovery: boolean;
  /** Opt-in: accept/open unencrypted v1 links (legacy peers). */
  allowPlaintext: boolean;
  discoveryPort?: number;
  multicastAddress?: string;
  tcpPort?: number;
  alternateScreen: boolean;
}

export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string; options: CliOptions };

const DEFAULT_OPTIONS: CliOptions = {
  help: false,
  version: false,
  headless: false,
  discovery: true,
  allowPlaintext: false,
  alternateScreen: true,
};

export function parseArgs(argv: readonly string[]): ParseResult {
  const options: CliOptions = { ...DEFAULT_OPTIONS };

  const fail = (error: string): ParseResult => ({ ok: false, error, options });

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined) {
      continue;
    }

    // Support `--name=value` as well as `--name value`.
    const equals = raw.indexOf('=');
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);

    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }

      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        return undefined;
      }

      index += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;

      case '-v':
      case '--version':
        options.version = true;
        break;

      case '--headless':
        options.headless = true;
        break;

      case '--no-discovery':
        options.discovery = false;
        break;

      case '--allow-plaintext':
        options.allowPlaintext = true;
        break;

      case '--inline':
      case '--no-alt-screen':
        options.alternateScreen = false;
        break;

      case '-n':
      case '--name': {
        const value = takeValue();
        if (value === undefined) {
          return fail('--name needs a value');
        }

        const username = sanitizeUsername(value, MAX_USERNAME_LENGTH);
        if (username === null) {
          return fail(
            `"${value}" is not a valid username (1-${MAX_USERNAME_LENGTH} characters: letters, numbers, . _ -)`,
          );
        }

        options.name = username;
        break;
      }

      case '-r':
      case '--room': {
        const value = takeValue();
        if (value === undefined) {
          return fail('--room needs a value');
        }

        const room = sanitizeRoomName(value, MAX_ROOM_NAME_LENGTH);
        if (room === null) {
          return fail(`"${value}" is not a valid room name`);
        }

        options.room = room;
        break;
      }

      case '-c':
      case '--connect': {
        const value = takeValue();
        if (value === undefined) {
          return fail('--connect needs a host, e.g. --connect 192.168.1.24');
        }

        const [host, port] = splitTarget(value);
        if (!isValidHost(host)) {
          return fail(`"${host}" is not a valid host`);
        }

        if (port !== undefined && !isValidPortNumber(port)) {
          return fail(`"${port}" is not a valid port`);
        }

        options.connect = value;
        break;
      }

      case '--discovery-port': {
        const value = takeValue();
        if (value === undefined || !isValidPortNumber(value)) {
          return fail('--discovery-port needs a port number (1-65535)');
        }

        options.discoveryPort = Number(value);
        break;
      }

      case '--tcp-port': {
        const value = takeValue();
        if (value === undefined || !isValidPortNumber(value)) {
          return fail('--tcp-port needs a port number (1-65535)');
        }

        options.tcpPort = Number(value);
        break;
      }

      case '--multicast': {
        const value = takeValue();
        if (value === undefined || !isMulticastAddress(value)) {
          return fail('--multicast needs an IPv4 multicast address, e.g. 239.255.42.99');
        }

        options.multicastAddress = value;
        break;
      }

      default:
        return fail(`unknown option ${flag}`);
    }
  }

  return { ok: true, options };
}

export function splitTarget(value: string): [string, string | undefined] {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(':');
  if (separator === -1) {
    return [trimmed, undefined];
  }

  return [trimmed.slice(0, separator), trimmed.slice(separator + 1)];
}

function isValidPortNumber(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535;
}

function isMulticastAddress(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }

  const first = Number(parts[0]);
  return Number.isInteger(first) && first >= 224 && first <= 239;
}
