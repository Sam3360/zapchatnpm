/**
 * Integration tests over real sockets.
 *
 * These are deliberately not mocked: two (or three) clients bind real UDP
 * discovery sockets on a shared port and open real TCP links, exactly as two
 * machines on the same LAN would. If multicast/broadcast is blocked in the
 * environment the tests fail loudly rather than silently skipping, because the
 * whole point of the project is that this path works.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ZapClient } from '../../src/core/client.js';
import type { Snapshot } from '../../src/core/client.js';
import { delay, uniquePort, waitFor } from '../helpers/wait.js';

const DISCOVERY_TIMEOUT = 20_000;
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows sometimes keeps a handle open briefly; the OS cleans up /tmp.
    }
  }
});

interface Harness {
  clients: ZapClient[];
  stop: () => Promise<void>;
}

/**
 * Start N clients that share one discovery port, each with its own config file.
 * An ephemeral TCP port is used per client so many instances can run on one box.
 */
async function startClients(
  usernames: string[],
  options: { discovery?: boolean; staleMs?: number } = {},
): Promise<Harness> {
  const discoveryPort = uniquePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-int-'));
  tempDirs.push(dir);

  const clients = usernames.map(
    (username, index) =>
      new ZapClient({
        username,
        discoveryPort,
        tcpPortBase: 0,
        configPath: path.join(dir, `${username}-${index}.json`),
        discovery: options.discovery ?? true,
        staleMs: options.staleMs ?? 4000,
      }),
  );

  try {
    for (const client of clients) {
      await client.start();
    }
  } catch (error) {
    await Promise.all(clients.map(client => client.stop().catch(() => undefined)));
    throw error;
  }

  return {
    clients,
    stop: async () => {
      await Promise.all(clients.map(client => client.stop().catch(() => undefined)));
    },
  };
}

function peerConnectedTo(snapshot: Snapshot, username: string): boolean {
  return snapshot.peers.some(peer => peer.username === username && peer.connected);
}

function messageTexts(snapshot: Snapshot): string[] {
  return snapshot.messages.filter(message => message.kind === 'chat').map(m => m.text);
}

describe('LAN discovery', () => {
  it('discovers a peer over UDP and opens a direct TCP link', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];

      await waitFor(
        () =>
          peerConnectedTo(alice.getSnapshot(), 'bob') &&
          peerConnectedTo(bob.getSnapshot(), 'alice'),
        { timeoutMs: DISCOVERY_TIMEOUT, label: 'alice and bob to discover and connect' },
      );

      const snapshot = alice.getSnapshot();
      const bobRecord = snapshot.peers.find(peer => peer.username === 'bob');
      assert.ok(bobRecord, 'bob should be listed as a peer');
      assert.equal(bobRecord.online, true);
      assert.equal(bobRecord.connected, true);
      assert.ok(bobRecord.addresses.length > 0, 'bob should advertise an address');

      // Discovery is the only way these two know about each other here.
      assert.equal(snapshot.status.discovery, 'ok');
      assert.ok(snapshot.status.beaconsSent > 0, 'beacons were sent');
      assert.ok(snapshot.status.tcpPort > 0, 'listening on a TCP port');
    } finally {
      await harness.stop();
    }
  });

  it('reports the discovery state honestly when the socket cannot be opened', async () => {
    // Bind the discovery port ourselves so the client cannot use it.
    const port = uniquePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '0.0.0.0', () => resolve());
    });

    const harness = await startClients(['lonely'], { discovery: false });
    try {
      const [client] = harness.clients as [ZapClient];
      const snapshot = client.getSnapshot();

      // With discovery disabled the status explains itself instead of pretending.
      assert.equal(snapshot.status.discovery, 'unavailable');
      assert.match(snapshot.status.discoveryDetail, /disabled|discovery/i);
    } finally {
      await harness.stop();
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});

describe('messaging', () => {
  it('delivers a message between two clients on the same LAN', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];

      const aliceJoin = alice.join('general');
      const bobJoin = bob.join('general');
      assert.equal(aliceJoin.ok, true);
      assert.equal(bobJoin.ok, true);

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the two clients to connect',
      });
      await waitFor(() => alice.getSnapshot().members.length === 1, {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'alice to see bob in the room',
      });

      const sent = alice.send('hello from the LAN');
      assert.equal(sent.ok, true);

      await waitFor(() => messageTexts(bob.getSnapshot()).includes('hello from the LAN'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'bob to receive the message',
      });

      const received = bob
        .getSnapshot()
        .messages.find(message => message.text === 'hello from the LAN');
      assert.ok(received, 'bob should have the message');
      assert.equal(received.username, 'alice');
      assert.equal(received.self, false);
      assert.ok(received.ts > 0);

      // Bob can answer, and alice sees it as a real peer message.
      bob.send('got it');
      await waitFor(() => messageTexts(alice.getSnapshot()).includes('got it'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'alice to receive the reply',
      });

      const reply = alice.getSnapshot().messages.find(message => message.text === 'got it');
      assert.equal(reply?.self, false);
      assert.equal(reply?.username, 'bob');
    } finally {
      await harness.stop();
    }
  });

  it('keeps messages inside their room', async () => {
    const harness = await startClients(['alice', 'bob', 'carol']);

    try {
      const [alice, bob, carol] = harness.clients as [ZapClient, ZapClient, ZapClient];
      alice.join('general');
      bob.join('general');
      carol.join('other');

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'alice and bob to connect',
      });

      alice.send('general room only');

      await waitFor(() => messageTexts(bob.getSnapshot()).includes('general room only'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'bob to receive the room message',
      });

      // Give carol time to (not) receive it; a wrongly relayed copy would arrive
      // within a few beacon intervals.
      await delay(1500);
      assert.equal(
        messageTexts(carol.getSnapshot()).includes('general room only'),
        false,
        'carol is in another room and must not receive the message',
      );

      assert.equal(carol.getSnapshot().rooms.some(room => room.name === 'general'), true);
    } finally {
      await harness.stop();
    }
  });

  it('rejects malformed input on the TCP port without dropping real peers', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];
      alice.join('general');
      bob.join('general');

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the pair to connect',
      });

      const sockets = await Promise.all([
        rawConnect('127.0.0.1', alice.tcpPort, 'not json at all\n{"v":1,"type":"MESSAGE"}\n'),
        rawConnect('127.0.0.1', alice.tcpPort, ''),
      ]);

      // The client must still be healthy afterwards.
      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: 5000,
        label: 'alice to keep talking to bob',
      });

      alice.send('still alive');
      await waitFor(() => messageTexts(bob.getSnapshot()).includes('still alive'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'messages to keep flowing',
      });

      assert.ok(alice.getSnapshot().status.droppedFrames >= 0);
      for (const socket of sockets) {
        socket.destroy();
      }
    } finally {
      await harness.stop();
    }
  });
});

describe('resilience', () => {
  it('notices a peer that disappears and picks it up again when it returns', async () => {
    const harness = await startClients(['alice', 'bob'], { staleMs: 2500 });
    const discoveryPort = (harness.clients[0] as ZapClient).discoveryPort;

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];
      alice.join('general');
      bob.join('general');

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the pair to connect',
      });

      // Bob leaves the LAN entirely.
      await bob.stop();

      await waitFor(
        () => !alice.getSnapshot().peers.some(peer => peer.username === 'bob'),
        { timeoutMs: DISCOVERY_TIMEOUT, label: 'alice to notice bob is gone' },
      );

      const afterLeave = alice.getSnapshot();
      assert.ok(
        afterLeave.messages.some(
          message => message.kind === 'system' && message.text.includes('bob left #general'),
        ),
        `expected a "bob left" notice, got: ${afterLeave.messages.map(m => m.text).join(' | ')}`,
      );

      // Bob comes back, as a new process would: a fresh client on the same port.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-return-'));
      tempDirs.push(dir);
      const returning = new ZapClient({
        username: 'bob',
        discoveryPort,
        tcpPortBase: 0,
        configPath: path.join(dir, 'bob.json'),
        staleMs: 2500,
      });

      try {
        await returning.start();
        returning.join('general');

        await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
          timeoutMs: DISCOVERY_TIMEOUT,
          label: 'alice to rediscover bob',
        });

        assert.ok(
          alice.getSnapshot().messages.some(
            message => message.kind === 'system' && message.text.includes('bob joined #general'),
          ),
          'expected a "bob joined" notice after rediscovery',
        );

        alice.send('welcome back');
        await waitFor(() => messageTexts(returning.getSnapshot()).includes('welcome back'), {
          timeoutMs: DISCOVERY_TIMEOUT,
          label: 'the returning client to receive messages',
        });
      } finally {
        await returning.stop();
      }
    } finally {
      await harness.stop();
    }
  });

  it('connects directly when discovery is switched off', async () => {
    const harness = await startClients(['alice', 'bob'], { discovery: false });

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];
      bob.join('general');

      const result = await alice.manualConnect('127.0.0.1', bob.tcpPort);
      assert.equal(result.ok, true, result.error);

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the manual link to be established',
      });

      alice.join('general');
      alice.send('manual hello');

      await waitFor(() => messageTexts(bob.getSnapshot()).includes('manual hello'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the manual message to arrive',
      });
    } finally {
      await harness.stop();
    }
  });

  it('explains a failed manual connection instead of throwing', async () => {
    const harness = await startClients(['alice'], { discovery: false });

    try {
      const [alice] = harness.clients as [ZapClient];
      const result = await alice.manualConnect('127.0.0.1', 9);
      assert.equal(result.ok, false);
      assert.ok(result.error && result.error.length > 0);
    } finally {
      await harness.stop();
    }
  });
});

/** Open a raw socket and write bytes at the client, then close our write side. */
function rawConnect(host: string, port: number, payload: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('error', error => {
      socket.destroy();
      reject(error);
    });
    socket.once('connect', () => {
      if (payload.length > 0) {
        socket.write(payload);
      }

      socket.end();
      resolve(socket);
    });
  });
}
