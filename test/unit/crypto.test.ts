import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEADER_BYTES, MAGIC_BYTE } from '../../src/protocol/constants.js';
import {
  deriveSessionKeys,
  generatePrivateKey,
  isValidPublicKey,
  open,
  publicKeyFromPrivate,
  publicKeyId,
  seal,
} from '../../src/protocol/crypto.js';
import {
  createSecureSession,
  decodeSecurePayload,
  encodeHandshakeFrame,
  encodeSecureFrame,
  type SecureSession,
} from '../../src/protocol/secureFraming.js';
import {
  PeerPinStore,
  completeHandshake,
  createKeyExchange,
  encodeKeyExchangeForWire,
  parseKeyExchangeFromWire,
} from '../../src/protocol/handshake.js';
import { verifyHandshake } from '../../src/protocol/crypto.js';

const NOW = 1_700_000_000_000;

/** Fixed identity seed for handshake tests (any 32 bytes). */
const TEST_SEED = Buffer.alloc(32, 7);

describe('crypto primitives', () => {
  it('derives a public key from a private key', () => {
    const priv = generatePrivateKey();
    const pub = publicKeyFromPrivate(priv);

    assert.equal(pub.length, 32);
    assert.ok(isValidPublicKey(pub));
  });

  it('produces the same public key for the same private key', () => {
    const priv = generatePrivateKey();
    assert.deepEqual(publicKeyFromPrivate(priv), publicKeyFromPrivate(priv));
  });

  it('seals and opens a frame round-trip', () => {
    const key = generatePrivateKey(); // any 32 bytes work as a symmetric key
    const plaintext = Buffer.from('{"v":2,"type":"MESSAGE"}');

    const sealed = seal(key, plaintext);
    assert.deepEqual(open(key, sealed), plaintext);
  });

  it('binds the AAD into the seal', () => {
    const key = generatePrivateKey();
    const plaintext = Buffer.from('payload');
    const aad = Buffer.from('header-a');

    const sealed = seal(key, plaintext, aad);
    assert.deepEqual(open(key, sealed, aad), plaintext);

    const differentAad = Buffer.from('header-b');
    assert.equal(open(key, sealed, differentAad), null);
  });

  it('rejects tampered ciphertext', () => {
    const key = generatePrivateKey();
    const sealed = seal(key, Buffer.from('secret message'));

    const tamperIndex = sealed.length - 5;
    sealed[tamperIndex] = (sealed[tamperIndex] ?? 0) ^ 0xff; // flip a bit inside the tag
    assert.equal(open(key, sealed), null);
  });

  it('rejects a wrong key', () => {
    const sealed = seal(generatePrivateKey(), Buffer.from('secret'));    assert.equal(open(generatePrivateKey(), sealed), null);
  });

  it('rejects truncated input without throwing', () => {
    const key = generatePrivateKey();
    const sealed = seal(key, Buffer.from('x'));
    assert.ok(sealed.length >= 5, 'sealed frame should be long enough to truncate');
    assert.equal(open(key, sealed.subarray(0, 5)), null);
    assert.equal(open(key, Buffer.alloc(0)), null);
  });

  it('uses a fresh nonce for every seal', () => {
    const key = generatePrivateKey();
    const a = seal(key, Buffer.from('same'));
    const b = seal(key, Buffer.from('same'));

    assert.equal(a.equals(b), false);
  });

  it('refuses an all-zero ECDH result instead of deriving keys', () => {
    const evil = Buffer.alloc(32); // all-zero public key is invalid on Curve25519
    const priv = generatePrivateKey();

    assert.equal(deriveSessionKeys(priv, evil, Buffer.alloc(32), true), null);
  });

  it('derives matching directional keys on both ends', () => {
    const initiator = createKeyExchange(TEST_SEED);
    const responder = createKeyExchange(TEST_SEED);

    // HKDF salt is always the initiator's nonce.
    const initResult = completeHandshake(
      responder.exchange,
      initiator.exchange.nonce,
      initiator.privateKey,
      true,
    );
    const respResult = completeHandshake(
      initiator.exchange,
      initiator.exchange.nonce,
      responder.privateKey,
      false,
    );

    assert.ok(initResult && respResult);
    assert.deepEqual(initResult.keys.send, respResult.keys.recv);
    assert.deepEqual(initResult.keys.recv, respResult.keys.send);
    assert.notDeepEqual(initResult.keys.send, initResult.keys.recv);
  });
});

describe('public key ids', () => {
  it('are stable and differ across keys', () => {
    const pubA = publicKeyFromPrivate(generatePrivateKey());
    const pubB = publicKeyFromPrivate(generatePrivateKey());

    assert.equal(publicKeyId(pubA), publicKeyId(pubA));
    assert.notEqual(publicKeyId(pubA), publicKeyId(pubB));
  });
});

describe('secure framing', () => {
  function makeSessionPair(): [SecureSession, SecureSession] {
    const initiator = createKeyExchange(TEST_SEED);
    const responder = createKeyExchange(TEST_SEED);

    const initResult = completeHandshake(
      responder.exchange,
      initiator.exchange.nonce,
      initiator.privateKey,
      true,
    );
    const respResult = completeHandshake(
      initiator.exchange,
      initiator.exchange.nonce,
      responder.privateKey,
      false,
    );

    assert.ok(initResult && respResult);
    return [
      createSecureSession(initResult.keys.send, initResult.keys.recv),
      createSecureSession(respResult.keys.send, respResult.keys.recv),
    ];
  }

  it('round-trips a data frame between two sessions', () => {
    const [alice, bob] = makeSessionPair();
    const payload = Buffer.from(JSON.stringify({ v: 2, type: 'MESSAGE', data: { text: 'hi' } }));

    const wire = encodeSecureFrame(alice, payload);
    assert.equal(wire[0], MAGIC_BYTE);
    assert.equal(wire.length, HEADER_BYTES + wire.readUInt32BE(9));

    const opened = decodeSecurePayload(
      bob,
      Number(wire.readBigUInt64BE(1)),
      wire.subarray(0, HEADER_BYTES),
      wire.subarray(HEADER_BYTES),
    );

    assert.deepEqual(opened, payload);
  });

  it('rejects a replayed frame', () => {
    const [alice, bob] = makeSessionPair();
    const payload = Buffer.from('once');

    const wire = encodeSecureFrame(alice, payload);
    const seq = Number(wire.readBigUInt64BE(1));
    const head = wire.subarray(0, HEADER_BYTES);
    const body = wire.subarray(HEADER_BYTES);

    assert.ok(decodeSecurePayload(bob, seq, head, body));
    assert.equal(decodeSecurePayload(bob, seq, head, body), null); // same seq again
  });

  it('rejects an out-of-order (gap) frame', () => {
    const [alice, bob] = makeSessionPair();

    encodeSecureFrame(alice, Buffer.from('one'));
    encodeSecureFrame(alice, Buffer.from('two'));
    const third = encodeSecureFrame(alice, Buffer.from('three'));

    // Deliver only the third frame: the skipped two create a gap.
    const seq = Number(third.readBigUInt64BE(1));
    assert.equal(
      decodeSecurePayload(bob, seq, third.subarray(0, HEADER_BYTES), third.subarray(HEADER_BYTES)),
      null,
    );
  });

  it('rejects a frame before any session exists', () => {
    const [alice] = makeSessionPair();
    const wire = encodeSecureFrame(alice, Buffer.from('early'));

    assert.equal(
      decodeSecurePayload(
        null,
        Number(wire.readBigUInt64BE(1)),
        wire.subarray(0, HEADER_BYTES),
        wire.subarray(HEADER_BYTES),
      ),
      null,
    );
  });

  it('encodes handshake frames as plaintext seq-0 frames', () => {
    const payload = Buffer.from('public handshake payload');
    const wire = encodeHandshakeFrame(payload);

    assert.equal(wire[0], MAGIC_BYTE);
    assert.equal(Number(wire.readBigUInt64BE(1)), 0);
    assert.deepEqual(wire.subarray(HEADER_BYTES), payload);
  });

  it('survives chunk-split delivery of concatenated frames', () => {
    const [alice, bob] = makeSessionPair();
    const first = encodeSecureFrame(alice, Buffer.from('a'));
    const second = encodeSecureFrame(alice, Buffer.from('b'));
    const both = Buffer.concat([first, second]);

    // Feed one byte at a time, decoding as soon as a full frame is available.
    let buffer = Buffer.alloc(0);
    let decoded = 0;
    for (let i = 0; i < both.length; i += 1) {
      buffer = Buffer.concat([buffer, both.subarray(i, i + 1)]);
      if (buffer.length >= HEADER_BYTES) {
        const length = buffer.readUInt32BE(9);
        if (buffer.length >= HEADER_BYTES + length) {
          const frame = buffer.subarray(0, HEADER_BYTES + length);
          buffer = buffer.subarray(HEADER_BYTES + length);
          const result = decodeSecurePayload(
            bob,
            Number(frame.readBigUInt64BE(1)),
            frame.subarray(0, HEADER_BYTES),
            frame.subarray(HEADER_BYTES),
          );
          if (result !== null) {
            decoded += 1;
          }
        }
      }
    }

    assert.equal(decoded, 2);
  });
});

describe('key exchange wire format', () => {
  it('survives encode → parse round-trip', () => {
    const { exchange } = createKeyExchange(TEST_SEED);
    const parsed = parseKeyExchangeFromWire(encodeKeyExchangeForWire(exchange));

    assert.ok(parsed);
    assert.deepEqual(parsed.pubKey, exchange.pubKey);
    assert.equal(parsed.keyId, exchange.keyId);
    assert.deepEqual(parsed.nonce, exchange.nonce);
    assert.deepEqual(parsed.identityKey, exchange.identityKey);
    assert.equal(parsed.identityKeyId, exchange.identityKeyId);
  });

  it('carries a valid handshake signature', () => {
    const { exchange } = createKeyExchange(TEST_SEED);
    const parsed = parseKeyExchangeFromWire(encodeKeyExchangeForWire(exchange));

    assert.ok(parsed);
    assert.ok(verifyHandshake(parsed.identityKey, parsed.pubKey, parsed.nonce, parsed.signature));
  });

  it('rejects a signature made with a different identity key', () => {
    const { exchange } = createKeyExchange(TEST_SEED);
    const other = createKeyExchange(Buffer.alloc(32, 9));

    // Signature from `other` paired with the identity of `exchange`.
    const forged = { ...exchange, signature: other.exchange.signature };
    assert.equal(parseKeyExchangeFromWire(encodeKeyExchangeForWire(forged)), null);
  });

  it('rejects a keyId that does not match the key', () => {
    const { exchange } = createKeyExchange(TEST_SEED);
    const wire = encodeKeyExchangeForWire(exchange);
    wire['keyId'] = 'AAAA'; // wrong fingerprint

    assert.equal(parseKeyExchangeFromWire(wire), null);
  });

  it('rejects malformed base64 payloads', () => {
    assert.equal(parseKeyExchangeFromWire({ pubKey: 'not base64!', keyId: 'x', nonce: '' }), null);
    assert.equal(parseKeyExchangeFromWire(null), null);
    assert.equal(parseKeyExchangeFromWire('string'), null);
  });
});

describe('TOFU pin store', () => {
  it('records a pin on first contact and accepts it afterwards', () => {
    const store = new PeerPinStore();

    assert.equal(store.check('client-a', 'key-1', NOW), 'new');
    assert.equal(store.check('client-a', 'key-1', NOW + 1000), 'ok');
  });

  it('flags a key change as a mismatch', () => {
    const store = new PeerPinStore();
    store.check('client-a', 'key-1', NOW);

    assert.equal(store.check('client-a', 'key-2', NOW + 1000), 'mismatch');
  });

  it('treats a long-expired pin as first contact again', () => {
    const store = new PeerPinStore();
    store.check('client-a', 'key-1', NOW);

    // Beyond PEER_PIN_TTL_MS the pin is re-recorded, not compared.
    const yearLater = NOW + 366 * 24 * 60 * 60 * 1000;
    assert.equal(store.check('client-a', 'key-2', yearLater), 'new');
  });

  it('seeds from config and persists back out', () => {
    const store = new PeerPinStore();
    store.seed({ 'client-a': { keyId: 'key-1', seenAt: NOW } });
    assert.equal(store.check('client-a', 'key-1', NOW + 1), 'ok');

    const roundTrip = new PeerPinStore();
    roundTrip.seed(store.toConfig());
    assert.equal(roundTrip.check('client-a', 'key-1', NOW + 2), 'ok');
  });

  it('ignores malformed seed entries', () => {
    const store = new PeerPinStore();
    store.seed({
      'client-b': { keyId: 42, seenAt: 'not a number' },
      '': { keyId: 'k', seenAt: 1 },
    } as unknown as Record<string, { keyId: string; seenAt: number }>);

    assert.deepEqual(store.toConfig(), {});
  });

  it('keeps pins for different clients independent', () => {
    const store = new PeerPinStore();
    store.check('client-a', 'key-1', NOW);
    store.check('client-b', 'key-2', NOW);

    assert.equal(store.check('client-a', 'key-2', NOW + 1), 'mismatch');
    assert.equal(store.check('client-b', 'key-1', NOW + 1), 'mismatch');
  });
});
