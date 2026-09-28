/**
 * Snapshot factory for view tests.
 *
 * Views take an immutable snapshot as their only input, so building one by hand
 * keeps those tests fast, deterministic and free of sockets.
 */

import type { ChatMessage } from '../../src/rooms/registry.js';
import type { PeerSnapshot, Snapshot, StatusSnapshot } from '../../src/core/client.js';

export function makePeer(overrides: Partial<PeerSnapshot> = {}): PeerSnapshot {
  return {
    clientId: 'zc-peer',
    username: 'peer',
    room: null,
    online: true,
    connected: true,
    addresses: ['192.168.1.9'],
    latencyMs: 5,
    source: 'lan',
    ...overrides,
  };
}

export function makeStatus(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    discovery: 'ok',
    discoveryDetail: 'listening on udp:45912',
    multicast: true,
    broadcast: true,
    discoveryPort: 45912,
    tcpPort: 45913,
    peersOnline: 0,
    peersConnected: 0,
    beaconsSent: 1,
    beaconsReceived: 1,
    droppedFrames: 0,
    lan: '192.168.1.42/24',
    warnings: [],
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${Math.random().toString(16).slice(2)}`,
    room: 'general',
    kind: 'chat',
    text: 'hello',
    from: 'zc-peer',
    username: 'peer',
    ts: 1_700_000_000_000,
    self: false,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 1,
    me: { clientId: 'zc-self', username: 'me', usernameConfirmed: true },
    room: 'general',
    rooms: [],
    peers: [],
    members: [],
    messages: [],
    notice: null,
    status: makeStatus(),
    ...overrides,
  };
}
