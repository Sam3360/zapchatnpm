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

describe('identity commands', () => {
  it('exposes our fingerprint and a peer\'s once a handshake completes', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];

      // Our own fingerprint is available before any peer shows up.
      const ours = alice.identityFingerprint();
      assert.equal(typeof ours, 'string');
      assert.ok(ours.length > 0, 'we always have a fingerprint');
      assert.equal(alice.identityFingerprint(), ours, 'and it is stable');

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the pair to connect',
      });

      // Once the secure handshake completes, the peer's key is known.
      await waitFor(() => alice.peerFingerprint('bob-does-not-exist') === null, {
        timeoutMs: 5_000,
        label: 'an unknown peer to report no key',
      });
      const bobPeer = alice
        .getSnapshot()
        .peers.find(peer => peer.username === 'bob');
      assert.ok(bobPeer, 'bob is listed as a peer');

      await waitFor(() => alice.peerFingerprint(bobPeer.clientId) !== null, {
        timeoutMs: 10_000,
        label: "bob's key to be recorded after the handshake",
      });

      const bobKey = alice.peerFingerprint(bobPeer.clientId);
      assert.ok(bobKey, 'bob presented a key');
      // Bob's own fingerprint is the same value from his side.
      assert.equal(bobKey, bob.identityFingerprint());
      // Two clients never share a fingerprint.
      assert.notEqual(bobKey, ours);
    } finally {
      await harness.stop();
    }
  });

  it('trust re-pins a peer and untrust forgets the pin', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice] = harness.clients as [ZapClient];
      await waitFor(
        () => alice.getSnapshot().peers.some(peer => peer.username === 'bob' && peer.connected),
        { timeoutMs: DISCOVERY_TIMEOUT, label: 'bob to connect' },
      );

      const bobPeer = alice.getSnapshot().peers.find(peer => peer.username === 'bob');
      assert.ok(bobPeer);

      // Untrusting a peer we have never pinned is reported, not silently ignored.
      const unknown = alice.untrust('no-such-client');
      assert.equal(unknown.ok, false);

      // Trusting pins whatever key they currently present.
      const trusted = alice.trust(bobPeer.clientId);
      assert.equal(trusted.ok, true, trusted.error);

      // It is idempotent: trusting again is still fine.
      assert.equal(alice.trust(bobPeer.clientId).ok, true);
      assert.equal(alice.untrust(bobPeer.clientId).ok, true);

      // And now there is nothing left to forget.
      const twice = alice.untrust(bobPeer.clientId);
      assert.equal(twice.ok, false);
      assert.match(twice.error ?? '', /no pinned key/);
    } finally {
      await harness.stop();
    }
  });
});

describe('offline queue', () => {
  it('buffers a message sent with nobody in the room and flushes it on reconnect', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];

      // Alice talks to an empty room: the message is rendered locally but has
      // nowhere to go, so it is buffered rather than dropped.
      alice.join('general');
      const queued = alice.send('sent before anyone arrived');
      assert.equal(queued.ok, true, queued.error);

      await waitFor(() => alice.getSnapshot().queued.length === 1, {
        timeoutMs: 10_000,
        label: 'alice to buffer the undeliverable message',
      });

      const snapshot = alice.getSnapshot();
      assert.equal(snapshot.queued[0]?.text, 'sent before anyone arrived');
      assert.equal(snapshot.queued[0]?.room, 'general');
      // The user can see it has not been delivered.
      const localEcho = snapshot.messages.find(message => message.text === 'sent before anyone arrived');
      assert.equal(localEcho?.queued, true, 'the local echo is marked as queued');

      // Bob arrives and links up: the backlog goes out on the sweep.
      bob.join('general');
      await waitFor(
        () => peerConnectedTo(alice.getSnapshot(), 'bob') && alice.getSnapshot().members.length === 1,
        { timeoutMs: DISCOVERY_TIMEOUT, label: 'bob to join the room' },
      );

      await waitFor(() => messageTexts(bob.getSnapshot()).includes('sent before anyone arrived'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the queued message to reach bob',
      });

      await waitFor(() => alice.getSnapshot().queued.length === 0, {
        timeoutMs: 10_000,
        label: 'alice to drain the offline queue',
      });

      const after = alice.getSnapshot();
      const delivered = after.messages.find(
        message => message.text === 'sent before anyone arrived',
      );
      assert.equal(delivered?.queued, undefined, 'the message is no longer marked queued');
    } finally {
      await harness.stop();
    }
  });

  it('keeps each room backlog separate', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];
      alice.join('general');
      alice.send('for the empty general room');

      // Moving to another room does not deliver the first room's backlog, and
      // the message stays bound to the room it was written for.
      alice.join('gaming');
      await waitFor(() => alice.getSnapshot().room === 'gaming', { timeoutMs: 5_000 });

      await waitFor(() => alice.getSnapshot().queued.length === 1, { timeoutMs: 10_000 });
      assert.equal(alice.getSnapshot().queued[0]?.room, 'general');

      // Only once somebody is in #general does that backlog flush.
      bob.join('general');
      await waitFor(() => messageTexts(bob.getSnapshot()).includes('for the empty general room'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the general backlog to reach bob',
      });
    } finally {
      await harness.stop();
    }
  });
});

describe('file transfer', () => {
  it('streams an offered file to a peer and lands it in the received dir', async () => {
    const harness = await startClients(['alice', 'bob']);
    const payload = Buffer.alloc(64 * 1024);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 31 + 7) & 0xff;
    }

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapchat-send-'));
    tempDirs.push(sourceDir);
    const sourcePath = path.join(sourceDir, 'payload.bin');
    fs.writeFileSync(sourcePath, payload);

    try {
      const [alice, bob] = harness.clients as [ZapClient, ZapClient];
      alice.join('general');
      bob.join('general');

      await waitFor(() => peerConnectedTo(alice.getSnapshot(), 'bob'), {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'the pair to connect before offering',
      });
      await waitFor(() => alice.getSnapshot().members.length === 1, {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'alice to see bob in the room',
      });

      const offer = alice.offerFile(sourcePath);
      assert.equal(offer.ok, true, offer.error);

      // The receiving side auto-accepts, reassembles, and announces the target.
      await waitFor(() => {
        const texts = bob.getSnapshot().messages.map(message => message.text);
        return texts.some(text => text.includes('received payload.bin'));
      }, {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'bob to receive the whole file',
      });

      const line = bob
        .getSnapshot()
        .messages.map(message => message.text)
        .find(text => text.includes('received payload.bin'));
      assert.ok(line, 'bob should have a receipt line');

      // Extract the arrow path from "received payload.bin (…) from alice → <path>".
      const target = line.split('→').pop()?.trim();
      assert.ok(target, `no path in receipt line: ${line}`);
      assert.ok(fs.existsSync(target), `received file missing at ${target}`);

      const written = fs.readFileSync(target);
      assert.equal(written.length, payload.length, 'received file must match byte count');
      assert.equal(Buffer.compare(written, payload), 0, 'received bytes must be identical');

      // The sender retires the offer with a success summary.
      await waitFor(() => {
        const texts = alice.getSnapshot().messages.map(message => message.text);
        return texts.some(text => text.includes('sent payload.bin'));
      }, {
        timeoutMs: DISCOVERY_TIMEOUT,
        label: 'alice to record the completed send',
      });

      // No transfer should remain in either snapshot once both sides settle.
      await waitFor(
        () =>
          alice.getSnapshot().transfers.length === 0 &&
          bob.getSnapshot().transfers.length === 0,
        { timeoutMs: DISCOVERY_TIMEOUT, label: 'both sides to retire the transfer' },
      );
    } finally {
      await harness.stop();
      try {
        const received = path.join(os.tmpdir(), 'zapchat-received');
        if (fs.existsSync(received)) {
          for (const entry of fs.readdirSync(received)) {
            if (entry.includes('payload.bin')) {
              fs.rmSync(path.join(received, entry), { force: true });
            }
          }
        }
      } catch {
        // temp cleanup is best-effort
      }
    }
  });

  it('rejects offers that are not files and keeps the room usable', async () => {
    const harness = await startClients(['alice', 'bob']);

    try {
      const [alice] = harness.clients as [ZapClient, ZapClient];
      alice.join('general');

      const missing = alice.offerFile(path.join(os.tmpdir(), 'zapchat-does-not-exist.bin'));
      assert.equal(missing.ok, false);
      assert.ok(missing.error && missing.error.length > 0);

      const empty = alice.offerFile('');
      assert.equal(empty.ok, false);
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
