/**
 * Local command handling.
 *
 * Commands never touch the network (except `/leave`, `/join` and `/connect`,
 * which change our own presence or open a direct link). Output is printed
 * locally: in a room it lands in that room's timeline, in the lobby it goes to
 * the activity log.
 */

import type { ZapClient } from '../core/client.js';
import { helpLines, type ParsedCommand } from '../commands/commands.js';
import { plural } from './view/status.js';

export interface CommandContext {
  client: ZapClient;
  /** Print a local line (trimmed, never sent to peers). */
  print: (text: string, tone?: 'info' | 'warn' | 'error') => void;
  /** Clear the lobby activity log (`/clear` outside a room). */
  clearOutput?: () => void;
}

export type CommandOutcome = 'handled' | 'quit';

export function runCommand(parsed: ParsedCommand, context: CommandContext): CommandOutcome {
  const { client, print } = context;

  if (!parsed.known) {
    print(`unknown command /${parsed.name} — try /help`, 'warn');
    return 'handled';
  }

  switch (parsed.name) {
    case 'help': {
      for (const line of helpLines()) {
        print(line);
      }

      return 'handled';
    }

    case 'quit':
      return 'quit';

    case 'leave': {
      const result = client.leave();
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }

      return 'handled';
    }

    case 'clear': {
      client.clearHistory();
      context.clearOutput?.();
      return 'handled';
    }

    case 'join':
    case 'create': {
      if (parsed.args.length === 0) {
        print(`usage: /${parsed.name} <room>`, 'warn');
        return 'handled';
      }

      const result = parsed.name === 'create' ? client.create(parsed.args) : client.join(parsed.args);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }

      return 'handled';
    }

    case 'name': {
      if (parsed.args.length === 0) {
        print(`you are ${client.username} — usage: /name <username>`, 'info');
        return 'handled';
      }

      const result = client.setUsername(parsed.args);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }

      return 'handled';
    }

    case 'me': {
      if (parsed.args.length === 0) {
        print('usage: /me <action>   e.g. /me waves hello', 'warn');
        return 'handled';
      }

      const result = client.sendAction(parsed.args);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'warn');
      }

      return 'handled';
    }

    case 'connect': {
      if (parsed.args.length === 0) {
        print('usage: /connect <host[:port]>   e.g. /connect 192.168.1.24', 'warn');
        return 'handled';
      }

      const [host, portText] = splitHostPort(parsed.args);
      const port = portText === undefined ? undefined : Number(portText);
      if (portText !== undefined && !Number.isInteger(port)) {
        print(`"${portText}" is not a port number`, 'warn');
        return 'handled';
      }

      void client.manualConnect(host, port).then(result => {
        if (!result.ok && result.error !== undefined) {
          print(result.error, 'error');
        }
      });

      return 'handled';
    }

    case 'rooms': {
      const snapshot = client.getSnapshot();
      if (snapshot.rooms.length === 0) {
        print('no rooms discovered yet — /create <name> starts one', 'info');
        return 'handled';
      }

      for (const room of snapshot.rooms) {
        const here = snapshot.room === room.name ? '  ← you are here' : '';
        const marker = room.online === 0 ? 'empty' : plural(room.online, 'online', 'online');
        print(`#${room.name.padEnd(18)} ${marker}${here}`);
      }

      return 'handled';
    }

    case 'users': {
      const snapshot = client.getSnapshot();
      const lanNames = snapshot.peers.filter(peer => peer.online).map(peer => peer.username);
      const roomNames = snapshot.members.map(member => member.username);

      print(`you        ${snapshot.me.username}${snapshot.room === null ? '' : `  #${snapshot.room}`}`);
      print(
        `in room    ${roomNames.length === 0 ? 'nobody else' : roomNames.join(', ')}`,
        'info',
      );
      print(
        `on the LAN ${lanNames.length === 0 ? 'nobody else' : `${lanNames.join(', ')} (${snapshot.status.peersConnected} connected)`}`,
        'info',
      );
      return 'handled';
    }

    case 'status': {
      const snapshot = client.getSnapshot();
      const { status } = snapshot;
      print(`client      ${snapshot.me.username}  ${snapshot.me.clientId}`, 'info');
      print(`room        ${snapshot.room === null ? 'none (lobby)' : `#${snapshot.room}`}`, 'info');
      print(`listening   tcp:${status.tcpPort}   discovery udp:${status.discoveryPort}`, 'info');
      print(
        `discovery   ${status.discovery} — ${status.discoveryDetail}${status.multicast ? ' [multicast]' : ''}${status.broadcast ? ' [broadcast]' : ''}`,
        status.discovery === 'ok' ? 'info' : 'warn',
      );
      print(`this machine ${status.lan}`, 'info');
      print(
        `peers       ${status.peersOnline} on LAN, ${status.peersConnected} connected · ${status.beaconsSent} beacons sent, ${status.beaconsReceived} received`,
        'info',
      );
      print(`protocol    ${status.droppedFrames} rejected frames so far`, 'info');
      if (status.warnings.length > 0) {
        for (const warning of status.warnings) {
          print(`warning     ${warning}`, 'warn');
        }
      }

      return 'handled';
    }

    default: {
      print(`unknown command /${parsed.name} — try /help`, 'warn');
      return 'handled';
    }
  }
}

/** Split `host`, `host:port` or `[ipv6]:port` into parts. */
export function splitHostPort(value: string): [string, string | undefined] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end !== -1) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      return [host, rest.startsWith(':') ? rest.slice(1) : undefined];
    }
  }

  const separator = trimmed.lastIndexOf(':');
  if (separator === -1) {
    return [trimmed, undefined];
  }

  return [trimmed.slice(0, separator), trimmed.slice(separator + 1)];
}
