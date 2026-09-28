/**
 * End-to-end tests of the actual CLI binary.
 *
 * Two separate `zapchat --headless` processes discover each other over UDP and
 * exchange messages over TCP — the same code path two machines on the same Wi-Fi
 * use. Nothing is stubbed: these are real child processes, real sockets and the
 * real built entry point from package.json's `bin`.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { delay, uniquePort, waitFor } from '../helpers/wait.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist-test/test/integration → project root
const projectRoot = path.resolve(here, '..', '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli', 'main.js');

interface Cli {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  send: (line: string) => void;
  closeInput: () => void;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  kill: () => void;
}

let configCounter = 0;

function startCli(args: string[]): Cli {
  // Every process gets its own config directory: distinct client ids are what
  // make two instances separate clients (exactly like two machines). The
  // directory is under the OS temp dir so the developer's real config is never
  // touched.
  configCounter += 1;
  const configDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-cli-')),
    `instance-${configCounter}`,
  );

  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZAPCHAT_CONFIG_DIR: configDir,
    },
  }) as ChildProcessWithoutNullStreams;

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    out += String(chunk);
  });
  child.stderr.on('data', chunk => {
    err += String(chunk);
  });

  const exited = new Promise<number | null>(resolve => {
    child.once('close', code => resolve(code));
  });

  return {
    child,
    stdout: () => out,
    stderr: () => err,
    send: line => child.stdin.write(`${line}\n`),
    closeInput: () => child.stdin.end(),
    exited,
    kill: () => {
      if (!child.killed) {
        child.kill();
      }
    },
  };
}

/** Run the CLI to completion and collect its output. */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = startCli(args);
  cli.closeInput();
  const code = await cli.exited;
  return { code, stdout: cli.stdout(), stderr: cli.stderr() };
}

const built = fs.existsSync(cliPath);

describe('cli: basics', { skip: built ? false : 'run `npm run build` first' }, () => {
  it('prints its version', async () => {
    const result = await runCli(['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it('prints usage', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage/);
    assert.match(result.stdout, /--headless/);
    assert.match(result.stdout, /LAN/);
  });

  it('explains bad arguments instead of starting', async () => {
    const result = await runCli(['--nope']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown option --nope/);

    const badName = await runCli(['--name', 'not a name']);
    assert.equal(badName.code, 1);
    assert.match(badName.stderr, /not a valid username/);

    const badPort = await runCli(['--tcp-port', '99999']);
    assert.equal(badPort.code, 1);
    assert.match(badPort.stderr, /--tcp-port needs a port number/);
  });

  it('refuses to run the TUI without a terminal, and explains the way out', async () => {
    const result = await runCli([]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /needs an interactive terminal/);
    assert.match(result.stderr, /--headless/);
  });

  it('reports an unreachable manual connection but keeps running', async () => {
    const cli = startCli([
      '--headless',
      '--name',
      'lonely',
      '--no-discovery',
      '--connect',
      '127.0.0.1:9',
    ]);

    try {
      await waitFor(() => cli.stderr().includes('127.0.0.1:9'), {
        timeoutMs: 15000,
        label: 'the failed connection to be reported',
      });

      // Still alive and usable: the process did not exit on a failed connect.
      assert.equal(cli.child.exitCode, null);
      cli.send('/help');
      await waitFor(() => cli.stdout().includes('[local] commands:'), {
        timeoutMs: 5000,
        label: 'commands to still work',
      });
    } finally {
      cli.closeInput();
      await cli.exited;
    }
  });

  it('shuts down cleanly when its input ends', async () => {
    const cli = startCli(['--headless', '--name', 'quitter', '--no-discovery']);
    await waitFor(() => cli.stdout().includes('headless mode'), {
      timeoutMs: 15000,
      label: 'the banner',
    });

    cli.closeInput();
    const code = await cli.exited;
    assert.equal(code, 0, `expected a clean exit, got ${code} (stderr: ${cli.stderr()})`);
    assert.equal(cli.stderr().includes('unexpected'), false);
  });
});

describe('cli: two processes chat over the LAN', { skip: built ? false : 'run `npm run build` first' }, () => {
  it('discovers, joins a room and exchanges messages in both directions', async () => {
    const discoveryPort = uniquePort();
    const alicePort = uniquePort();
    const bobPort = uniquePort();

    const alice = startCli([
      '--headless',
      '--name',
      'alice',
      '--room',
      'general',
      '--discovery-port',
      String(discoveryPort),
      '--tcp-port',
      String(alicePort),
    ]);

    const bob = startCli([
      '--headless',
      '--name',
      'bob',
      '--room',
      'general',
      '--discovery-port',
      String(discoveryPort),
      '--tcp-port',
      String(bobPort),
    ]);

    try {
      await waitFor(
        () => alice.stdout().includes('headless mode') && bob.stdout().includes('headless mode'),
        { timeoutMs: 15000, label: 'both clients to start' },
      );

      // Alice's discovery must be genuinely up (not silently degraded).
      assert.match(alice.stdout(), /discovery ok/);

      await waitFor(
        () => alice.stdout().includes('[local] connected to bob'),
        { timeoutMs: 20000, label: 'alice to connect to bob' },
      );

      await waitFor(
        () => bob.stdout().includes('[local] connected to alice'),
        { timeoutMs: 20000, label: 'bob to connect to alice' },
      );

      // alice → bob
      alice.send('hey bob, can you read this?');
      await waitFor(
        () => bob.stdout().includes('[#general] alice: hey bob, can you read this?'),
        { timeoutMs: 15000, label: 'bob to receive alice\'s message' },
      );

      // bob → alice
      bob.send('loud and clear 👋');
      await waitFor(
        () => alice.stdout().includes('[#general] bob: loud and clear 👋'),
        { timeoutMs: 15000, label: 'alice to receive bob\'s message' },
      );

      // Locally handled commands must not be sent to the peer.
      bob.send('/name bobby');
      await waitFor(() => alice.stdout().includes('[local] connected'), {
        timeoutMs: 5000,
        label: 'a beat',
      });

      bob.send('name changed');
      await waitFor(
        () => alice.stdout().includes('[#general] bobby: name changed'),
        { timeoutMs: 15000, label: 'alice to see the new name' },
      );

      assert.equal(
        alice.stdout().includes('/name'),
        false,
        'commands must never appear as chat messages',
      );
    } finally {
      alice.closeInput();
      bob.closeInput();
      await Promise.all([alice.exited, bob.exited]);
      alice.kill();
      bob.kill();
    }
  });

  it('keeps talking when a peer restarts', async () => {
    const discoveryPort = uniquePort();

    const alice = startCli([
      '--headless',
      '--name',
      'alice',
      '--room',
      'general',
      '--discovery-port',
      String(discoveryPort),
      '--tcp-port',
      String(uniquePort()),
    ]);

    let bob = startCli([
      '--headless',
      '--name',
      'bob',
      '--room',
      'general',
      '--discovery-port',
      String(discoveryPort),
      '--tcp-port',
      String(uniquePort()),
    ]);

    try {
      await waitFor(() => alice.stdout().includes('[local] connected to bob'), {
        timeoutMs: 20000,
        label: 'the first connection',
      });

      // Bob goes away.
      bob.closeInput();
      await bob.exited;
      await waitFor(() => alice.stdout().includes('connection to bob lost'), {
        timeoutMs: 15000,
        label: 'alice to notice the lost connection',
      });

      // Bob comes back on the same ports.
      bob = startCli([
        '--headless',
        '--name',
        'bob',
        '--room',
        'general',
        '--discovery-port',
        String(discoveryPort),
        '--tcp-port',
        String(uniquePort()),
      ]);

      await waitFor(
        () => countOccurrences(alice.stdout(), '[local] connected to bob') >= 2,
        { timeoutMs: 25000, label: 'alice to reconnect to the restarted bob' },
      );

      alice.send('still here?');
      await waitFor(() => bob.stdout().includes('[#general] alice: still here?'), {
        timeoutMs: 15000,
        label: 'the restarted peer to receive messages again',
      });

      await delay(10);
    } finally {
      alice.closeInput();
      bob.closeInput();
      await Promise.all([alice.exited, bob.exited]);
      alice.kill();
      bob.kill();
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
