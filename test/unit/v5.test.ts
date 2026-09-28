import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import {
  LEGACY_WIRE_VERSION,
  MAGIC_BYTE,
  PROTOCOL_VERSION,
} from '../../src/protocol/constants.js';
import {
  SUPPORTED_WIRE_VERSION_SET,
  createEnvelope,
  parseEnvelope,
  rewriteEnvelopeForWire,
} from '../../src/protocol/messages.js';
import { buildBeacon } from '../../src/discovery/discovery.js';
import { encodeFrame } from '../../src/protocol/framing.js';
import { TcpTransport, type PeerHandle } from '../../src/network/transport.js';

// ------------------------------------------------------------------ versions

describe('wire versions', () => {
  it('defaults to v2 for both building and parsing', () => {
    const envelope = createEnvelope('PING', { clientId: 'zc-test-12345', username: 'sam' });
    assert.equal(envelope.v, PROTOCOL_VERSION);
    assert.equal(parseEnvelope(envelope)?.v, PROTOCOL_VERSION);
  });

  it('can stamp and accept v1 envelopes explicitly', () => {
    const envelope = createEnvelope(
      'PING',
      { clientId: 'zc-test-12345', username: 'sam' },
      { version: LEGACY_WIRE_VERSION },
    );
    assert.equal(envelope.v, LEGACY_WIRE_VERSION);
    const parsed = parseEnvelope(envelope, { allowedVersions: SUPPORTED_WIRE_VERSION_SET });
    assert.ok(parsed !== null);
    assert.equal(parsed.v, LEGACY_WIRE_VERSION);
  });

  it('still rejects v1 by default (v2-only links unchanged)', () => {
    const envelope = createEnvelope(
      'PING',
      { clientId: 'zc-test-12345', username: 'sam' },
      { version: LEGACY_WIRE_VERSION },
    );
    assert.equal(parseEnvelope(envelope), null);
    assert.equal(parseEnvelope({ ...envelope, v: 3 }), null);
  });

  it('rewriteEnvelopeForWire re-stamps across versions and drops nonsense', () => {
    const v2 = createEnvelope(
      'MESSAGE',
      { clientId: 'zc-test-12345', username: 'sam' },
      { room: 'general', data: { text: 'hi' } },
    );
    const asV1 = rewriteEnvelopeForWire(v2, LEGACY_WIRE_VERSION);
    assert.ok(asV1 !== null);
    assert.equal(asV1.v, 1);
    assert.equal(asV1.id, v2.id);
    assert.deepEqual(asV1.data, v2.data);
    // Same-version rewrite is the identity.
    assert.equal(rewriteEnvelopeForWire(asV1, LEGACY_WIRE_VERSION), asV1);
    assert.equal(rewriteEnvelopeForWire(v2, 3), null);
  });
});

// ------------------------------------------------------------------- beacons

describe('dual-version beacons', () => {
  it('builds parseable beacons for both versions', () => {
    for (const version of [LEGACY_WIRE_VERSION, PROTOCOL_VERSION]) {
      const packet = buildBeacon(
        { clientId: 'zc-test-12345', username: 'sam', room: 'general' },
        { port: 45913, addresses: ['192.168.1.5'], rooms: ['general'] },
        1_700_000_000_000,
        version,
      );
      assert.ok(packet !== null);
      const parsed = parseEnvelope(JSON.parse(packet.toString('utf8')), {
        checkClockSkew: false,
        allowedVersions: SUPPORTED_WIRE_VERSION_SET,
      });
      assert.ok(parsed !== null);
      assert.equal(parsed.v, version);
      assert.equal(parsed.type, 'ANNOUNCE');
    }
  });
});

// ------------------------------------------------------ plaintext v1 links

interface StartedTransport {
  transport: TcpTransport;
  port: number;
  peers: PeerHandle[];
  stop: () => void;
}

async function startTransport(allowPlaintext: boolean): Promise<StartedTransport> {
  const peers: PeerHandle[] = [];
  const transport = new TcpTransport(
    {
      getHello: () => ({ username: 'npm-side', room: 'general', port: 45998, addresses: [] }),
      onPeerReady: peer => peers.push(peer),
      onPeerGone: () => {},
      onEnvelope: () => {},
    },
    {
      clientId: 'zc-npm-side-0001',
      identitySeed: new Uint8Array(32).fill(7),
      allowPlaintext,
    },
  );
  const port = await transport.listen(0, 1);
  return { transport, port, peers, stop: () => transport.close() };
}

/** A minimal v1 peer: connect, then send a plaintext JSON HELLO line. */
async function v1Peer(port: number, clientId = 'zc-py-peer-0001'): Promise<net.Socket> {
  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const hello = createEnvelope(
    'HELLO',
    { clientId, username: 'py' },
    { room: 'general', version: 1, data: { port: 45999, addresses: ['127.0.0.1'] } },
  );
  socket.write(encodeFrame(hello));
  return socket;
}

describe('plaintext v1 links', () => {
  it('accepts a legacy v1 peer and answers in plaintext when allowed', async () => {
    const server = await startTransport(true);
    try {
      const socket = await v1Peer(server.port);

      const reply = await new Promise<string>((resolve, reject) => {
        let buffer = '';
        socket.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline !== -1) resolve(buffer.slice(0, newline));
        });
        socket.once('error', reject);
      });

      // The acceptor's HELLO is plaintext JSON stamped v1.
      const replyEnvelope = parseEnvelope(JSON.parse(reply), {
        allowedVersions: SUPPORTED_WIRE_VERSION_SET,
      });
      assert.ok(replyEnvelope !== null);
      assert.equal(replyEnvelope.v, LEGACY_WIRE_VERSION);
      assert.equal(replyEnvelope.type, 'HELLO');
      assert.equal(replyEnvelope.from, 'zc-npm-side-0001');

      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(server.peers.length, 1);
      assert.equal(server.peers[0]?.encrypted, false);
      assert.equal(server.peers[0]?.username, 'py');

      socket.destroy();
    } finally {
      server.stop();
    }
  });

  it('refuses a legacy v1 peer when allowPlaintext is off', async () => {
    const server = await startTransport(false);
    try {
      const socket = await v1Peer(server.port);
      await Promise.race([
        once(socket, 'close'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('v1 peer was not refused')), 2_000),
        ),
      ]);
    } finally {
      server.stop();
    }
  });

  it('dials a v1 listener in plaintext and completes the link', async () => {
    // A fake v1 listener: accepts, answers the first line with our HELLO.
    const received: string[] = [];
    const listener = net.createServer(socket => {
      socket.on('data', chunk => {
        received.push(chunk.toString('utf8'));
        if (received.length === 1) {
          const reply = createEnvelope(
            'HELLO',
            { clientId: 'zc-py-listen-001', username: 'py' },
            { room: 'general', version: 1, data: { port: 46001, addresses: ['127.0.0.1'] } },
          );
          socket.write(encodeFrame(reply));
        }
      });
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as net.AddressInfo).port;

    const client = await startTransport(true);
    try {
      const peer = await client.transport.connect('127.0.0.1', port, { plaintext: true });
      assert.equal(peer.encrypted, false);
      assert.equal(peer.clientId, 'zc-py-listen-001');
      // Our dial sent an unsealed JSON line, never a 0xC2 frame.
      assert.ok(received[0]?.startsWith('{'));
      assert.notEqual(received[0]?.charCodeAt(0), MAGIC_BYTE);
    } finally {
      client.stop();
      listener.close();
    }
  });

  it('rejects plaintext dials when allowPlaintext is off', async () => {
    const client = await startTransport(false);
    try {
      await assert.rejects(
        client.transport.connect('127.0.0.1', 45999, { plaintext: true }),
        /allow-plaintext/,
      );
    } finally {
      client.stop();
    }
  });
});
