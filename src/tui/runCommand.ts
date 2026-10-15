/**
 * Local command handling.
 *
 * Commands never touch the network (except `/leave`, `/join` and `/connect`,
 * which change our own presence or open a direct link). Output is printed
 * locally: in a room it lands in that room's timeline, in the lobby it goes to
 * the activity log.
 */

import type { ZapClient, PeerSnapshot, Snapshot } from '../core/client.js';
import { helpLines, type ParsedCommand } from '../commands/commands.js';
import { charLength, sanitizeMessageText } from '../protocol/sanitize.js';
import {
  REACTION_SET,
  MAX_REACTION_CHARS,
  MIN_ID_PREFIX_CHARS,
} from '../protocol/constants.js';
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
      if (status.plaintextLinks > 0) {
        print(
          `encryption   WARNING: ${status.plaintextLinks} link(s) without encryption (legacy peers)`,
          'warn',
        );
      }
      print(`protocol    ${status.droppedFrames} rejected frames so far`, 'info');
      if (snapshot.transfers.length > 0) {
        print(`transfers   ${snapshot.transfers.length} active`, 'info');
      }
      if (snapshot.queued.length > 0) {
        print(
          `queued      ${snapshot.queued.length} message${snapshot.queued.length === 1 ? '' : 's'} waiting for a peer`,
          'warn',
        );
      }
      print(`identity    ${client.identityFingerprint()}`, 'info');
      if (status.warnings.length > 0) {
        for (const warning of status.warnings) {
          print(`warning     ${warning}`, 'warn');
        }
      }

      return 'handled';
    }

    case 'identity': {
      print(`your identity fingerprint: ${client.identityFingerprint()}`, 'info');
      print('share it with a peer (or run /fingerprint on their side) to verify the link', 'info');
      return 'handled';
    }

    case 'fingerprint': {
      if (parsed.args.length === 0) {
        print('usage: /fingerprint <username>', 'warn');
        return 'handled';
      }

      const peer = findPeerByUsername(client.getSnapshot(), parsed.args);
      if (peer === undefined) {
        print(`no peer named "${parsed.args}"`, 'warn');
        return 'handled';
      }

      const keyId = client.peerFingerprint(peer.clientId);
      if (keyId === null) {
        print(`${peer.username} has not completed a handshake yet — no key to show`, 'warn');
        return 'handled';
      }

      print(`${peer.username}  ${peer.clientId}\n  key ${keyId}`, 'info');
      return 'handled';
    }

    case 'trust':
    case 'untrust': {
      if (parsed.args.length === 0) {
        print(`usage: /${parsed.name} <username>`, 'warn');
        return 'handled';
      }

      const peer = findPeerByUsername(client.getSnapshot(), parsed.args);
      if (peer === undefined) {
        print(`no peer named "${parsed.args}"`, 'warn');
        return 'handled';
      }

      const result =
        parsed.name === 'trust'
          ? client.trust(peer.clientId)
          : client.untrust(peer.clientId);
      if (result.ok) {
        print(
          parsed.name === 'trust'
            ? `pinned ${peer.username}'s current key`
            : `forgot ${peer.username}'s pinned key`,
          'info',
        );
      } else if (result.error !== undefined) {
        print(result.error, 'error');
      }

      return 'handled';
    }

    case 'ids': {
      // Ids are the targets of /reply and /react, but they are not rendered
      // inline (the timeline stays clean) — this is where a user finds them.
      const snapshot = client.getSnapshot();
      const chat = snapshot.messages.filter(message => message.kind !== 'system');
      if (chat.length === 0) {
        print('no messages in this room yet — ids will list here for /reply and /react', 'info');
        return 'handled';
      }

      for (const message of [...chat].reverse().slice(0, 20)) {
        const preview = messagePreview(message);
        const name = message.username.length > 0 ? message.username : 'someone';
        print(`${message.id}  ${name}: ${preview}`, 'info');
      }

      return 'handled';
    }

    case 'reply': {
      const reply = parseReplyCommand(parsed.args);
      if (reply === null) {
        print('usage: /reply <id|prefix> <text>', 'warn');
        return 'handled';
      }

      const result = client.sendReply(reply.targetId, reply.text);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'error');
      }

      return 'handled';
    }

    case 'react': {
      const react = parseReactCommand(parsed.args);
      if (react === null) {
        print(`usage: /react <id|prefix> <${REACTION_SET.slice(0, 4).join('|')}|...>`, 'warn');
        return 'handled';
      }

      const result = client.sendReaction(react.targetId, react.reaction);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'error');
      }

      return 'handled';
    }

    case 'file': {
      if (parsed.args.length === 0) {
        print('usage: /file <file-path>  ·  /file cancel [id]', 'warn');
        return 'handled';
      }

      // `/file cancel [id]` aborts active transfers (all of them without an id).
      const cancelMatch = /^cancel(?:\s+(\S+))?$/.exec(parsed.args);
      const result =
        cancelMatch === null
          ? client.offerFile(parsed.args)
          : client.cancelTransfer(cancelMatch[1]);
      if (!result.ok && result.error !== undefined) {
        print(result.error, 'error');
      }

      return 'handled';
    }

    default: {
      print(`unknown command /${parsed.name} — try /help`, 'warn');
      return 'handled';
    }
  }
}

const REPLY_REACTION_WORD_RE = /^[A-Za-z0-9_-]+$/;

/** Resolve a `/fingerprint`, `/trust` or `/untrust` argument to a peer. */
/** One-line preview of a message for `/ids` (reactions show their emoji). */
function messagePreview(message: Snapshot['messages'][number]): string {
  if (message.reaction !== undefined && message.reaction.length > 0) {
    return `${message.reaction} reacted`;
  }

  const text = message.text.replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    return '(no text)';
  }

  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function findPeerByUsername(snapshot: Snapshot, name: string): PeerSnapshot | undefined {
  const needle = name.trim().replace(/^@/, '').toLowerCase();
  return (
    snapshot.peers.find(peer => peer.username.toLowerCase() === needle) ??
    // Fall back to a client-id prefix so a peer can always be named.
    snapshot.peers.find(peer => needle.length >= MIN_ID_PREFIX_CHARS && peer.clientId.startsWith(needle))
  );
}

function parseReplyCommand(args: string): { targetId: string; text: string } | null {
  const spaceAt = args.indexOf(' ');
  if (spaceAt < 0) {
    return null;
  }

  const targetId = args.slice(0, spaceAt);
  const text = sanitizeMessageText(args.slice(spaceAt + 1));

  if (!REPLY_REACTION_WORD_RE.test(targetId) || targetId.length < MIN_ID_PREFIX_CHARS) {
    return null;
  }

  if (text.length === 0) {
    return null;
  }

  return { targetId, text };
}

function parseReactCommand(args: string): { targetId: string; reaction: string } | null {
  const spaceAt = args.indexOf(' ');
  if (spaceAt < 0) {
    return null;
  }

  const targetId = args.slice(0, spaceAt);
  const reaction = args.slice(spaceAt + 1).trim();

  if (!REPLY_REACTION_WORD_RE.test(targetId) || targetId.length < MIN_ID_PREFIX_CHARS) {
    return null;
  }

  if (!(REACTION_SET as readonly string[]).includes(reaction)) {
    return null;
  }

  if (charLength(reaction) > MAX_REACTION_CHARS) {
    return null;
  }

  return { targetId, reaction };
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
