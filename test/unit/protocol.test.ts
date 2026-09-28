import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MESSAGE_CHARS,
  MAX_UDP_PACKET_BYTES,
  PROTOCOL_VERSION,
} from '../../src/protocol/constants.js';
import { FrameDecoder, encodeFrame } from '../../src/protocol/framing.js';
import {
  createEnvelope,
  newMessageId,
  parseAnnounceData,
  parseEnvelope,
  parseMessageData,
  parsePeerListData,
  parseRoomListData,
} from '../../src/protocol/messages.js';
import {
  charLength,
  isValidClientId,
  isValidHost,
  isValidPort,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeUsername,
  stripControlSequences,
  truncateChars,
} from '../../src/protocol/sanitize.js';
import { buildBeacon } from '../../src/discovery/discovery.js';

const sender = { clientId: 'zc-11111111-2222-3333-4444-555555555555', username: 'sam' };

describe('sanitise: messages', () => {
  it('strips ANSI escapes and control characters', () => {
    const hostile = '\u001B[31mred\u001B[0m\u0007 and \u009Bmore';
    assert.equal(sanitizeMessageText(hostile), 'red and more');
    assert.equal(sanitizeMessageText('\u001B[2J\u001B[Hgotcha'), 'gotcha');
  });

  it('collapses whitespace, including newlines and tabs', () => {
    assert.equal(sanitizeMessageText('  hello\n\t world   '), 'hello world');
  });

  it('keeps emoji, CJK and combining marks', () => {
    assert.equal(sanitizeMessageText('hi 👋🏽 日本 café'), 'hi 👋🏽 日本 café');
  });

  it('truncates by code points, not bytes', () => {
    const long = '👍'.repeat(MAX_MESSAGE_CHARS + 50);
    assert.equal(charLength(sanitizeMessageText(long)), MAX_MESSAGE_CHARS);
  });

  it('returns an empty string for content that is only control characters', () => {
    assert.equal(sanitizeMessageText('\u001B[2J\u0000'), '');
  });

  it('truncateChars and stripControlSequences are safe on empty input', () => {
    assert.equal(truncateChars('', 10), '');
    assert.equal(truncateChars('abc', 0), '');
    assert.equal(stripControlSequences(''), '');
  });
});

describe('sanitise: usernames and rooms', () => {
  it('accepts ordinary usernames', () => {
    assert.equal(sanitizeUsername('sam'), 'sam');
    assert.equal(sanitizeUsername('Sam_99'), 'Sam_99');
    assert.equal(sanitizeUsername('jose.m'), 'jose.m');
    assert.equal(sanitizeUsername('ada-lovelace'), 'ada-lovelace');
  });

  it('rejects usernames with spaces or punctuation', () => {
    assert.equal(sanitizeUsername('sam smith'), null);
    assert.equal(sanitizeUsername('sam; rm -rf /'), null);
    assert.equal(sanitizeUsername('<script>'), null);
  });

  it('strips escapes and control characters from usernames', () => {
    assert.equal(sanitizeUsername('\u001B[31mred'), 'red');
    assert.equal(sanitizeUsername('\u001B[31mred\u0007'), 'red');
    assert.equal(sanitizeUsername('\u001B[2J'), null, 'nothing usable is left');
  });

  it('enforces the length rules', () => {
    assert.equal(sanitizeUsername(''), null);
    assert.equal(sanitizeUsername('   '), null);
    assert.equal(sanitizeUsername('a'.repeat(21)), null);
    assert.equal(sanitizeUsername('a'.repeat(20)), 'a'.repeat(20));
  });

  it('canonicalises room names to lower case', () => {
    assert.equal(sanitizeRoomName('General'), 'general');
    assert.equal(sanitizeRoomName('  CODING  '), 'coding');
    assert.equal(sanitizeRoomName('dev team'), 'dev team');
  });

  it('rejects room names that are unusable or unsafe', () => {
    assert.equal(sanitizeRoomName(''), null);
    assert.equal(sanitizeRoomName('#general'), null);
    assert.equal(sanitizeRoomName('room/../etc'), null);
    assert.equal(sanitizeRoomName('a'.repeat(21)), null);
    assert.equal(sanitizeRoomName('\u0000'), null);
  });

  it('repairs room names containing stray control characters', () => {
    assert.equal(sanitizeRoomName('nul\u0000room'), 'nulroom');
    assert.equal(sanitizeRoomName('\u001B[31mgeneral'), 'general');
  });

  it('validates client ids, hosts and ports', () => {
    assert.equal(isValidClientId('zc-abcdef12'), true);
    assert.equal(isValidClientId('short'), false);
    assert.equal(isValidClientId('has space in it'), false);
    assert.equal(isValidHost('192.168.1.24'), true);
    assert.equal(isValidHost('laptop.local'), true);
    assert.equal(isValidHost('192.168.1.24:45913'), false);
    assert.equal(isValidHost('http://evil.example'), false);
    assert.equal(isValidHost('999.1.1.1'), false);
    assert.equal(isValidPort(45913), true);
    assert.equal(isValidPort(0), false);
    assert.equal(isValidPort(70000), false);
    assert.equal(isValidPort(Number.NaN), false);
  });
});

describe('envelopes', () => {
  it('round-trips a created envelope', () => {
    const envelope = createEnvelope('MESSAGE', sender, {
      room: 'general',
      data: { text: 'hello' },
    });

    const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
    assert.ok(parsed);
    assert.equal(parsed.type, 'MESSAGE');
    assert.equal(parsed.from, sender.clientId);
    assert.equal(parsed.room, 'general');
    assert.deepEqual(parsed.data, { text: 'hello' });
    assert.equal(parsed.v, PROTOCOL_VERSION);
  });

  it('gives every message a unique id', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMessageId()));
    assert.equal(ids.size, 200);
  });

  const valid = createEnvelope('PING', sender);

  it('rejects malformed envelopes', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', 'hello'],
      ['null', null],
      ['array', []],
      ['wrong version', { ...valid, v: 99 }],
      ['missing id', { ...valid, id: undefined }],
      ['id with spaces', { ...valid, id: 'not a valid id' }],
      ['unknown type', { ...valid, type: 'DROP TABLE' }],
      ['bad sender id', { ...valid, from: 'x' }],
      ['nan timestamp', { ...valid, ts: Number.NaN }],
      ['string timestamp', { ...valid, ts: '123' }],
      ['room that is a number', { ...valid, room: 42 }],
      ['room with slashes', { ...valid, room: 'a/b' }],
    ];

    for (const [label, value] of cases) {
      assert.equal(parseEnvelope(value), null, `should reject: ${label}`);
    }
  });

  it('rejects timestamps that are far outside the clock-skew window', () => {
    const future = createEnvelope('PING', sender, { ts: Date.now() + 60 * 60 * 1000 });
    assert.equal(parseEnvelope(future), null);
    assert.ok(parseEnvelope(future, { checkClockSkew: false }));
  });

  it('repairs a hostile username instead of trusting it', () => {
    const envelope = { ...valid, username: '\u001B[31mhacker\u001B[0m\u0007' };
    const parsed = parseEnvelope(envelope);
    assert.ok(parsed);
    assert.equal(parsed.username, 'hacker');
  });

  it('requires valid payload shapes for typed messages', () => {
    assert.equal(parseEnvelope({ ...valid, type: 'HELLO', data: {} }), null);
    assert.equal(parseEnvelope({ ...valid, type: 'HELLO', data: { port: 0 } }), null);
    assert.equal(parseEnvelope({ ...valid, type: 'MESSAGE', data: { text: '' } }), null);
    assert.equal(parseEnvelope({ ...valid, type: 'PEER_LIST', data: {} }), null);
    assert.ok(
      parseEnvelope({ ...valid, type: 'HELLO', data: { port: 45913, addresses: ['192.168.1.4'] } }),
    );
  });
});

describe('payload validation', () => {
  it('filters addresses and rooms in an announce', () => {
    const data = parseAnnounceData({
      port: 45913,
      addresses: ['192.168.1.4', 'not-an-ip', '192.168.1.4', '10.0.0.7'],
      rooms: ['general', 'GENERAL', 42, 'coding'],
    });

    assert.deepEqual(data, {
      port: 45913,
      addresses: ['192.168.1.4', '10.0.0.7'],
      rooms: ['general', 'coding'],
    });
  });

  it('rejects invalid message bodies and sanitises valid ones', () => {
    assert.equal(parseMessageData({ text: '   ' }), null);
    assert.equal(parseMessageData({ text: 42 }), null);
    assert.equal(parseMessageData({ text: 'x'.repeat(MAX_MESSAGE_CHARS * 5) }), null);
    assert.deepEqual(parseMessageData({ text: 'hey\u001B[0m there' }), { text: 'hey there' });
  });

  it('drops entries with an invalid client id or port', () => {
    const data = parsePeerListData({
      peers: [
        { clientId: 'zc-abcdefgh', username: 'sam', room: 'general', port: 45913, addresses: [] },
        { clientId: 'nope', username: 'x', room: null, port: 1, addresses: [] },
        { clientId: 'zc-ijklmnop', username: 'sam', room: null, port: 0, addresses: [] },
      ],
    });

    assert.ok(data);
    assert.equal(data.peers.length, 1);
    assert.equal(data.peers[0]?.username, 'sam');
  });

  it('degrades an unusable room name to null without dropping the peer', () => {
    const data = parsePeerListData({
      peers: [
        {
          clientId: 'zc-abcdefgh',
          username: 'SAM',
          room: 'room/../etc',
          port: 45913,
          addresses: [],
        },
      ],
    });

    assert.equal(data?.peers.length, 1);
    assert.equal(data?.peers[0]?.room, null);
    assert.equal(data?.peers[0]?.username, 'SAM');
  });

  it('clamps room list entries', () => {
    const data = parseRoomListData({
      rooms: [
        { name: 'general', online: 3 },
        { name: 'coding', online: -5 },
        { name: 42, online: 1 },
        { name: 'gaming', online: 99_999 },
      ],
    });

    assert.deepEqual(data?.rooms, [
      { name: 'general', online: 3 },
      { name: 'coding', online: 0 },
      { name: 'gaming', online: 0 },
    ]);
  });
});

describe('framing', () => {
  it('decodes several frames from one chunk', () => {
    const decoder = new FrameDecoder();
    const a = createEnvelope('PING', sender);
    const b = createEnvelope('PONG', sender);
    const frames = decoder.push(Buffer.concat([encodeFrame(a), encodeFrame(b)]));

    assert.equal(frames.length, 2);
    assert.equal(frames[0]?.id, a.id);
    assert.equal(frames[1]?.id, b.id);
  });

  it('decodes a frame split across chunks', () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(createEnvelope('PING', sender));

    assert.deepEqual(decoder.push(frame.subarray(0, 5)), []);
    assert.equal(decoder.push(frame.subarray(5)).length, 1);
  });

  it('reassembles multi-byte characters split across chunks', () => {
    const decoder = new FrameDecoder();
    const envelope = createEnvelope('MESSAGE', sender, {
      room: 'general',
      data: { text: 'héllo 👋🏽 日本' },
    });
    const frame = encodeFrame(envelope);
    const split = Math.floor(frame.length / 2);

    assert.deepEqual(decoder.push(frame.subarray(0, split)), []);
    const frames = decoder.push(frame.subarray(split));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]?.data, { text: 'héllo 👋🏽 日本' });
  });

  it('drops malformed frames without throwing', () => {
    const decoder = new FrameDecoder();
    const junk = Buffer.from(
      `${JSON.stringify({ hello: 'world' })}\nnot json at all\n${JSON.stringify({ v: 1, id: 'aaaaaaaa', type: 'PING', ts: 1, from: 'bad', username: 'x', room: null })}\n`,
    );

    assert.deepEqual(decoder.push(junk), []);
    assert.ok(decoder.stats.dropped >= 3);
  });

  it('rejects frames larger than the limit', () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 128 });
    const big = `{"v":1,"id":"${'a'.repeat(500)}"}\n`;
    assert.deepEqual(decoder.push(Buffer.from(big)), []);
    assert.equal(decoder.stats.dropped, 1);
  });

  it('discards an endless stream with no delimiter instead of buffering it', () => {
    const decoder = new FrameDecoder({ maxFrameBytes: 512 });
    decoder.push(Buffer.from('x'.repeat(2000)));
    assert.ok(decoder.stats.discardedBytes > 0);

    // The tail of the oversized line is skipped, and the next frame still parses.
    const frame = encodeFrame(createEnvelope('PING', sender));
    const frames = decoder.push(Buffer.from(`tail${'\n'}${frame.toString('utf8')}`));
    assert.equal(frames.length, 1);
  });
});

describe('discovery beacons', () => {
  it('builds a beacon that parses back into the same contact', () => {
    const packet = buildBeacon(sender, {
      port: 45913,
      addresses: ['192.168.1.4', '10.0.0.7'],
      rooms: ['general', 'coding'],
    });

    assert.ok(packet);
    assert.ok(packet.length <= MAX_UDP_PACKET_BYTES);

    const parsed = parseEnvelope(JSON.parse(packet.toString('utf8')));
    assert.ok(parsed);
    assert.equal(parsed.type, 'ANNOUNCE');
    assert.equal(parsed.from, sender.clientId);

    const data = parseAnnounceData(parsed.data);
    assert.deepEqual(data, {
      port: 45913,
      addresses: ['192.168.1.4', '10.0.0.7'],
      rooms: ['general', 'coding'],
    });
  });

  it('carries the sender\'s room so presence does not flap', () => {
    // Regression: beacons used to be built without the room, so every peer
    // appeared to leave its room (and rejoin) on each 2-second beacon.
    const packet = buildBeacon(
      { clientId: sender.clientId, username: sender.username, room: 'general' },
      { port: 45913, addresses: ['192.168.1.4'], rooms: ['general'] },
    );

    assert.ok(packet);
    const parsed = parseEnvelope(JSON.parse(packet.toString('utf8')));
    assert.ok(parsed);
    assert.equal(parsed.room, 'general');

    // …and a client with no room advertises none, rather than a stale one.
    const idle = buildBeacon(
      { clientId: sender.clientId, username: sender.username, room: null },
      { port: 45913, addresses: [], rooms: [] },
    );
    assert.ok(idle);
    assert.equal(parseEnvelope(JSON.parse(idle.toString('utf8')))?.room, null);
  });

  it('shrinks an oversized beacon instead of sending it', () => {
    const packet = buildBeacon(sender, {
      port: 45913,
      addresses: Array.from({ length: 40 }, (_, index) => `192.168.1.${index}`),
      rooms: Array.from({ length: 40 }, (_, index) => `room-${index}-with-a-long-name`),
    });

    assert.ok(packet);
    assert.ok(packet.length <= MAX_UDP_PACKET_BYTES);

    const parsed = parseAnnounceData(
      parseEnvelope(JSON.parse(packet.toString('utf8')))?.data,
    );
    assert.ok(parsed);
    assert.ok(parsed.rooms.length < 40);
    assert.ok(parsed.addresses.length <= 8);
  });
});
