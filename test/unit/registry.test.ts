import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoomRegistry, mergeAddresses } from '../../src/rooms/registry.js';
import type { PeerContact } from '../../src/protocol/messages.js';

const NOW = 1_700_000_000_000;

function contact(overrides: Partial<PeerContact> & { clientId: string }): PeerContact {
  return {
    username: 'peer',
    room: null,
    port: 45913,
    addresses: ['192.168.1.10'],
    ...overrides,
  };
}

function makeRegistry(staleMs = 5000): RoomRegistry {
  return new RoomRegistry({ selfClientId: 'zc-self', selfUsername: 'me', staleMs });
}

describe('presence', () => {
  it('adds a new peer and reports it as added', () => {
    const registry = makeRegistry();
    const result = registry.upsertPeer(contact({ clientId: 'zc-a', username: 'sam' }), 'lan', NOW);

    assert.equal(result.added, true);
    assert.equal(result.peer.username, 'sam');
    assert.equal(result.previousRoom, null);
    assert.equal(registry.getPeer('zc-a')?.connected, false);
  });

  it('merges updates and reports the previous room', () => {
    const registry = makeRegistry();
    registry.upsertPeer(contact({ clientId: 'zc-a', room: 'general' }), 'lan', NOW);
    const result = registry.upsertPeer(
      contact({ clientId: 'zc-a', username: 'alex', room: 'coding' }),
      'lan',
      NOW + 100,
    );

    assert.equal(result.added, false);
    assert.equal(result.previousRoom, 'general');
    assert.equal(result.peer.username, 'alex');
    assert.equal(result.peer.room, 'coding');
  });

  it('never downgrades a v2-capable peer to legacy (v6 dual beacons)', () => {
    // v6+ clients announce in every wire version they speak, so beacons for
    // the same peer arrive stamped v1 and v2 in arbitrary order. The record
    // must keep the highest version seen — a downgrade used to make the
    // dialer skip the peer and stall the mesh.
    const registry = makeRegistry();
    registry.upsertPeer(contact({ clientId: 'zc-a' }), 'lan', NOW, { wireVersion: 2 });
    registry.upsertPeer(contact({ clientId: 'zc-a' }), 'lan', NOW + 1, { wireVersion: 1 });
    assert.equal(registry.getPeer('zc-a')?.wireVersion, 2);

    // And a genuinely legacy peer stays legacy.
    registry.upsertPeer(contact({ clientId: 'zc-b' }), 'lan', NOW, { wireVersion: 1 });
    registry.upsertPeer(contact({ clientId: 'zc-b' }), 'lan', NOW + 1, { wireVersion: 1 });
    assert.equal(registry.getPeer('zc-b')?.wireVersion, 1);
  });

  it('tracks online/offline and removes stale peers', () => {
    const registry = makeRegistry(1000);
    registry.upsertPeer(contact({ clientId: 'zc-a' }), 'lan', NOW);

    assert.equal(registry.online(NOW).length, 1);
    assert.equal(registry.online(NOW + 2000).length, 0, 'stale peers are not online');

    const removed = registry.removeStale(NOW + 2000);
    assert.equal(removed.length, 1);
    assert.equal(removed[0]?.clientId, 'zc-a');
    assert.equal(registry.getPeer('zc-a'), undefined);
  });

  it('keeps the observed address at the front of the candidate list', () => {
    const registry = makeRegistry();
    registry.upsertPeer(
      contact({ clientId: 'zc-a', addresses: ['10.0.0.9'] }),
      'lan',
      NOW,
    );
    registry.notePeerAddress('zc-a', '192.168.1.55', NOW);

    assert.deepEqual(registry.getPeer('zc-a')?.addresses, ['192.168.1.55', '10.0.0.9']);
  });

  it('tracks connection state and latency per peer', () => {
    const registry = makeRegistry();
    registry.upsertPeer(contact({ clientId: 'zc-a' }), 'lan', NOW);
    registry.setPeerConnection('zc-a', true, NOW);
    registry.setPeerLatency('zc-a', 12);

    assert.equal(registry.getPeer('zc-a')?.connected, true);
    assert.equal(registry.getPeer('zc-a')?.latencyMs, 12);

    registry.setPeerConnection('zc-a', false, NOW);
    assert.equal(registry.getPeer('zc-a')?.connected, false);
    assert.equal(registry.getPeer('zc-a')?.latencyMs, null);
  });

  it('ignores updates for unknown peers', () => {
    const registry = makeRegistry();
    assert.equal(registry.setPeerConnection('zc-missing', true), undefined);
    assert.equal(registry.setPeerRoom('zc-missing', 'general'), undefined);
    registry.touchPeer('zc-missing');
    assert.equal(registry.peers().length, 0);
  });
});

describe('rooms', () => {
  it('derives rooms from peers plus our own room', () => {
    const registry = makeRegistry();
    registry.setSelfRoom('general');
    registry.upsertPeer(contact({ clientId: 'zc-a', username: 'sam', room: 'general' }), 'lan', NOW);
    registry.upsertPeer(contact({ clientId: 'zc-b', username: 'jay', room: 'coding' }), 'lan', NOW);

    const rooms = registry.rooms(NOW);
    assert.deepEqual(
      rooms.map(room => [room.name, room.online, room.self]),
      [
        ['general', 2, true],
        ['coding', 1, false],
      ],
    );
  });

  it('includes advertised rooms with nobody in them', () => {
    const registry = makeRegistry();
    registry.noteRoom('gaming', NOW);
    const rooms = registry.rooms(NOW);

    assert.deepEqual(rooms, [
      { name: 'gaming', online: 0, self: false, connectedPeers: 0 },
    ]);
  });

  it('forgets advertised rooms after their ttl', () => {
    const registry = new RoomRegistry({ selfClientId: 'zc-self', knownRoomTtlMs: 1000 });
    registry.noteRoom('gaming', NOW);

    assert.deepEqual(registry.knownRooms(NOW), ['gaming']);
    assert.deepEqual(registry.knownRooms(NOW + 2000), []);
  });

  it('lists members of a room and excludes stale ones', () => {
    const registry = makeRegistry(1000);
    registry.setSelfRoom('general');
    registry.upsertPeer(contact({ clientId: 'zc-a', username: 'sam', room: 'general' }), 'lan', NOW);
    registry.upsertPeer(contact({ clientId: 'zc-b', username: 'jay', room: 'general' }), 'lan', NOW);

    assert.deepEqual(
      registry.membersIn('general', NOW).map(peer => peer.username),
      ['jay', 'sam'],
    );
    assert.equal(registry.membersIn('general', NOW + 5000).length, 0);
  });

  it('reports the previous room when a peer moves', () => {
    const registry = makeRegistry();
    registry.upsertPeer(contact({ clientId: 'zc-a', room: 'general' }), 'lan', NOW);

    assert.equal(registry.setPeerRoom('zc-a', 'coding', NOW), 'general');
    assert.equal(registry.setPeerRoom('zc-a', null, NOW), 'coding');
    assert.equal(registry.getPeer('zc-a')?.room, null);
  });

  it('removes a peer on request', () => {
    const registry = makeRegistry();
    registry.upsertPeer(contact({ clientId: 'zc-a' }), 'lan', NOW);
    assert.equal(registry.removePeer('zc-a')?.clientId, 'zc-a');
    assert.equal(registry.peers().length, 0);
  });
});

describe('duplicate suppression', () => {
  it('accepts an id once and rejects it afterwards', () => {
    const registry = makeRegistry();

    assert.equal(registry.markSeen('id-1', NOW), true);
    assert.equal(registry.markSeen('id-1', NOW), false);
    assert.equal(registry.hasSeen('id-1'), true);
    assert.equal(registry.markSeen('id-2', NOW), true);
  });

  it('keeps the cache bounded', () => {
    const registry = new RoomRegistry({ selfClientId: 'zc-self', dedupLimit: 50 });

    for (let index = 0; index < 500; index += 1) {
      registry.markSeen(`id-${index}`, NOW);
    }

    assert.ok(registry.seenCount <= 50, `cache grew to ${registry.seenCount}`);
    assert.equal(registry.hasSeen('id-499'), true, 'recent ids survive');
  });

  it('expires ids after the dedup window', () => {
    const registry = new RoomRegistry({
      selfClientId: 'zc-self',
      dedupLimit: 100,
      dedupWindowMs: 1000,
    });

    assert.equal(registry.markSeen('id-1', NOW), true);
    assert.equal(registry.markSeen('id-1', NOW + 5000), true, 'old id is forgotten');
  });
});

describe('history', () => {
  it('stores messages per room and trims to the limit', () => {
    const registry = new RoomRegistry({ selfClientId: 'zc-self', historyLimit: 3 });

    for (let index = 0; index < 5; index += 1) {
      registry.recordMessage({
        id: `m-${index}`,
        room: 'general',
        kind: 'chat',
        text: `message ${index}`,
        from: 'zc-a',
        username: 'sam',
        ts: NOW + index,
        self: false,
      });
    }

    const history = registry.history('general');
    assert.equal(history.length, 3);
    assert.equal(history[0]?.text, 'message 2');
    assert.deepEqual(registry.history('coding'), []);
  });

  it('labels locally generated notices as system messages', () => {
    const registry = makeRegistry();
    const message = registry.appendSystem('general', 'you joined #general', 'info', NOW);

    assert.equal(message.kind, 'system');
    assert.equal(message.self, true);
    assert.equal(registry.history('general').length, 1);
  });

  it('clears a room timeline', () => {
    const registry = makeRegistry();
    registry.appendSystem('general', 'hello', 'info', NOW);
    registry.clearHistory('general');

    assert.deepEqual(registry.history('general'), []);
    assert.equal(registry.historyRoomCount, 0);
  });
});

describe('address merging', () => {
  it('keeps order, removes duplicates and caps the list', () => {
    assert.deepEqual(mergeAddresses(['10.0.0.1'], ['10.0.0.1', '10.0.0.2']), [
      '10.0.0.1',
      '10.0.0.2',
    ]);

    const many = Array.from({ length: 20 }, (_, index) => `10.0.0.${index}`);
    assert.equal(mergeAddresses(many, []).length, 8);
  });
});
