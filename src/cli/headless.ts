/**
 * Headless mode.
 *
 * The same client and the same protocol, without the TUI: lines from stdin are
 * sent to the current room, incoming messages are printed to stdout. It exists
 * for three honest reasons — scripting, debugging a network problem over SSH,
 * and letting the test suite drive two real clients end to end.
 */

import readline from 'node:readline';
import type { ZapClient } from '../core/client.js';
import { parseCommand } from '../commands/commands.js';
import { runCommand } from '../tui/runCommand.js';
import { DEFAULT_ROOM } from '../protocol/constants.js';

export interface HeadlessOptions {
  client: ZapClient;
  /** Streams are injectable so tests can capture output. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
}

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const { client } = options;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  const write = (line: string): void => {
    output.write(`${line}\n`);
  };

  const snapshot = client.getSnapshot();
  write(`zapchat — headless mode`);
  write(`client   ${snapshot.me.username}  ${snapshot.me.clientId}`);
  write(`room     #${snapshot.room ?? DEFAULT_ROOM}`);
  write(`listening tcp:${snapshot.status.tcpPort}  discovery ${snapshot.status.discovery} (udp:${snapshot.status.discoveryPort})`);
  write(`network  ${snapshot.status.lan}`);
  if (snapshot.status.discovery !== 'ok') {
    write(`warning  ${snapshot.status.discoveryDetail}`);
  }

  write('type /help for commands, ctrl+c or ctrl+d to quit');

  const printed = new Set<string>();
  const connectedPeers = new Set<string>();

  const flush = (): void => {
    const current = client.getSnapshot();
    const room = current.room;
    for (const message of current.messages) {
      if (printed.has(message.id)) {
        continue;
      }

      printed.add(message.id);
      const label = room === null ? '?' : `#${room}`;
      if (message.kind === 'system') {
        write(`[${label}] ${message.text}`);
      } else {
        write(`[${label}] ${message.username}: ${message.text}`);
      }
    }

    // Link up/down is the single most useful thing to see while debugging a
    // network, so say it out loud in plain text mode.
    const nowConnected = new Set(
      current.peers.filter(peer => peer.connected).map(peer => peer.username),
    );

    for (const username of nowConnected) {
      if (!connectedPeers.has(username)) {
        write(`[local] connected to ${username}`);
      }
    }

    for (const username of connectedPeers) {
      if (!nowConnected.has(username)) {
        write(`[local] connection to ${username} lost`);
      }
    }

    connectedPeers.clear();
    for (const username of nowConnected) {
      connectedPeers.add(username);
    }
  };

  flush();
  const unsubscribe = client.subscribe(flush);

  const print = (text: string): void => {
    for (const line of text.split('\n')) {
      write(`[local] ${line}`);
    }
  };

  const rl = readline.createInterface({ input, terminal: false });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    const parsed = parseCommand(trimmed);
    if (parsed !== null) {
      const outcome = runCommand(parsed, { client, print });
      if (outcome === 'quit') {
        rl.close();
      }

      return;
    }

    const result = client.send(trimmed);
    if (!result.ok && result.error !== undefined) {
      write(`[error] ${result.error}`);
    }
  });

  await new Promise<void>(resolve => {
    const finish = (): void => resolve();

    rl.once('close', finish);
    process.once('SIGINT', () => {
      rl.close();
      finish();
    });
    process.once('SIGTERM', () => {
      rl.close();
      finish();
    });
  });

  unsubscribe();
  rl.close();
  await client.stop();
}
