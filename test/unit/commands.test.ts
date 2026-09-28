import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COMMANDS, findCommand, footerHint, helpLines, parseCommand } from '../../src/commands/commands.js';
import { runCommand, splitHostPort } from '../../src/tui/runCommand.js';
import { ZapClient } from '../../src/core/client.js';

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-cmd-'));
  return path.join(dir, 'config.json');
}

/** Run a command against a real (unstarted, offline) client and collect output. */
async function withClient(
  body: (client: ZapClient, print: (text: string) => void, output: string[]) => Promise<void>,
): Promise<void> {
  const client = new ZapClient({ username: 'tester', configPath: tempConfigPath() });
  const output: string[] = [];
  const print = (text: string): void => {
    output.push(text);
  };

  try {
    await body(client, print, output);
  } finally {
    await client.stop();
  }
}

describe('parseCommand', () => {
  it('returns null for ordinary chat text', () => {
    assert.equal(parseCommand('hello'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('http://example.com'), null);
  });

  it('parses a command with arguments', () => {
    const parsed = parseCommand('/join dev team');
    assert.ok(parsed);
    assert.equal(parsed.name, 'join');
    assert.equal(parsed.args, 'dev team');
    assert.equal(parsed.known, true);
  });

  it('parses a command without arguments and trims padding', () => {
    const parsed = parseCommand('   /leave   ');
    assert.ok(parsed);
    assert.equal(parsed.name, 'leave');
    assert.equal(parsed.args, '');
  });

  it('resolves aliases to the canonical name', () => {
    assert.equal(parseCommand('/q')?.name, 'quit');
    assert.equal(parseCommand('/h')?.name, 'help');
    assert.equal(parseCommand('/?')?.name, 'help');
    assert.equal(parseCommand('/who')?.name, 'users');
    assert.equal(parseCommand('/nick sam')?.name, 'name');
  });

  it('marks unknown commands without assuming they are chat', () => {
    const parsed = parseCommand('/explode now');
    assert.ok(parsed);
    assert.equal(parsed.known, false);
    assert.equal(parsed.name, 'explode');
    assert.equal(parsed.args, 'now');
  });

  it('treats a lone slash as an unknown command', () => {
    const parsed = parseCommand('/');
    assert.ok(parsed);
    assert.equal(parsed.known, false);
    assert.equal(parsed.name, '');
  });
});

describe('command metadata', () => {
  it('documents every command in /help', () => {
    const lines = helpLines().join('\n');
    for (const command of COMMANDS) {
      assert.ok(lines.includes(`/${command.name}`), `missing ${command.name}`);
    }
  });

  it('queries commands by name or alias', () => {
    assert.equal(findCommand('JOIN')?.name, 'join');
    assert.equal(findCommand('/quit')?.name, 'quit');
    assert.equal(findCommand('h')?.name, 'help');
    assert.equal(findCommand('nope'), undefined);
  });

  it('provides footer hints for both contexts', () => {
    assert.match(footerHint('lobby'), /enter/);
    assert.match(footerHint('room'), /enter send/);
  });
});

describe('splitHostPort', () => {
  it('splits host and optional port', () => {
    assert.deepEqual(splitHostPort('192.168.1.24'), ['192.168.1.24', undefined]);
    assert.deepEqual(splitHostPort('192.168.1.24:45913'), ['192.168.1.24', '45913']);
    assert.deepEqual(splitHostPort(' laptop.local '), ['laptop.local', undefined]);
    assert.deepEqual(splitHostPort('[::1]:45913'), ['::1', '45913']);
  });
});

describe('runCommand', () => {
  it('prints help without sending anything', async () => {
    await withClient(async (client, print, output) => {
      const outcome = runCommand(parseCommand('/help')!, { client, print });
      assert.equal(outcome, 'handled');
      assert.ok(output.join('\n').includes('/connect'));
    });
  });

  it('reports unknown commands instead of sending them', async () => {
    await withClient(async (client, print, output) => {
      runCommand(parseCommand('/nope')!, { client, print });
      assert.match(output.join('\n'), /unknown command \/nope/);
    });
  });

  it('joins and leaves rooms', async () => {
    await withClient(async (client, print) => {
      runCommand(parseCommand('/join general')!, { client, print });
      assert.equal(client.room, 'general');

      runCommand(parseCommand('/leave')!, { client, print });
      assert.equal(client.room, null);
    });
  });

  it('explains how to use commands that need arguments', async () => {
    await withClient(async (client, print, output) => {
      runCommand(parseCommand('/connect')!, { client, print });
      runCommand(parseCommand('/name')!, { client, print });

      assert.match(output.join('\n'), /usage: \/connect/);
      assert.match(output.join('\n'), /usage: \/name/);
    });
  });

  it('rejects invalid names and rooms', async () => {
    await withClient(async (client, print) => {
      runCommand(parseCommand('/name a b c!')!, { client, print });
      assert.equal(client.username, 'tester');

      runCommand(parseCommand('/join #bad/room')!, { client, print });
      assert.equal(client.room, null);
    });
  });

  it('signals quit without exiting the process itself', async () => {
    await withClient(async (client, print) => {
      assert.equal(runCommand(parseCommand('/quit')!, { client, print }), 'quit');
    });
  });

  it('describes status, rooms and users', async () => {
    await withClient(async (client, print, output) => {
      runCommand(parseCommand('/status')!, { client, print });
      runCommand(parseCommand('/rooms')!, { client, print });
      runCommand(parseCommand('/users')!, { client, print });

      const text = output.join('\n');
      assert.match(text, /client\s+tester/);
      assert.match(text, /no rooms discovered yet/);
      assert.match(text, /you\s+tester/);
    });
  });

  it('clears history and the lobby log with /clear', async () => {
    await withClient(async (client, print) => {
      let cleared = false;
      runCommand(parseCommand('/join general')!, { client, print });
      client.systemMessage('something to forget');

      runCommand(parseCommand('/clear')!, {
        client,
        print,
        clearOutput: () => {
          cleared = true;
        },
      });

      assert.equal(cleared, true);
      assert.deepEqual(client.getSnapshot().messages, []);
    });
  });
});
