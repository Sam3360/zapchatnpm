/**
 * The protocol v2 TCP handshake.
 *
 * Two frames are exchanged before any data flows, both as plaintext seq-0
 * frames (every value in them is public):
 *
 *   initiator → responder : HELLO { port, addresses, pubKey, keyId, nonce }
 *   responder → initiator : HELLO { port, addresses, pubKey, keyId, nonce }
 *
 * Each side then derives the same directional AES-256-GCM session keys via
 * HKDF over the ECDH shared secret, binding both public keys and both nonces,
 * so a relaying attacker cannot agree on keys with either end.
 *
 * Identity binding (TOFU): every install has a long-term X25519 identity key.
 * The first time we talk to a client id we record the public key it used; later
 * connections must present the same key or the link is refused — that is what
 * makes an active man-in-the-middle detectable rather than silent. Pins are
 * kept in the local config and expire after `PEER_PIN_TTL_MS`.
 */

import { randomBytes } from 'node:crypto';
import {
  HANDSHAKE_NONCE_BYTES,
  PEER_PIN_TTL_MS,
} from './constants.js';
import {
  deriveSessionKeys,
  generatePrivateKey,
  identityPublicFromSeed,
  isValidPublicKey,
  publicKeyFromPrivate,
  publicKeyId,
  signHandshake,
  verifyHandshake,
  type SessionKeys,
} from './crypto.js';

/** Public key exchange payload carried inside a v2 HELLO envelope. */
export interface HelloKeyExchange {
  /** X25519 ephemeral public key for this connection. */
  pubKey: Buffer;
  /** 8-byte fingerprint of `pubKey`, so receivers can cheaply sanity-check. */
  keyId: string;
  /** Fresh 32-byte nonce contributed to the session key derivation. */
  nonce: Buffer;
  /** Sender's long-term Ed25519 public key (the TOFU identity). */
  identityKey: Buffer;
  /** 8-byte fingerprint of `identityKey` — what gets pinned. */
  identityKeyId: string;
  /** Ed25519 signature over (ephemeral pubKey || nonce) with the identity key. */
  signature: Buffer;
}

/** Everything the transport needs from a completed handshake. */
export interface HandshakeResult {
  keys: SessionKeys;
  /** SHA-256 fingerprint (base64url) of the peer's ephemeral public key. */
  peerKeyId: string;
}

/** True when `value` is a well-formed key-exchange payload. */
export function isValidKeyExchange(value: unknown): value is HelloKeyExchange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isValidPublicKey(candidate['pubKey']) &&
    isValidPublicKey(candidate['identityKey']) &&
    typeof candidate['keyId'] === 'string' &&
    candidate['keyId'].length > 0 &&
    candidate['keyId'].length <= 64 &&
    typeof candidate['identityKeyId'] === 'string' &&
    candidate['identityKeyId'].length > 0 &&
    candidate['identityKeyId'].length <= 64 &&
    Buffer.isBuffer(candidate['nonce']) &&
    candidate['nonce'].length === HANDSHAKE_NONCE_BYTES &&
    Buffer.isBuffer(candidate['signature']) &&
    (candidate['signature'] as Buffer).length > 0 &&
    (candidate['signature'] as Buffer).length <= 128
  );
}

/** Build our half of the key exchange, signed with our identity key. */
export function createKeyExchange(identitySeed: Uint8Array): {
  exchange: HelloKeyExchange;
  privateKey: Buffer;
} {
  const privateKey = generatePrivateKey();
  const pubKey = publicKeyFromPrivate(privateKey);
  const nonce = randomBytes(HANDSHAKE_NONCE_BYTES);
  const signature = signHandshake(identitySeed, pubKey, nonce);
  const identityKey = identityPublicFromSeed(identitySeed);

  return {
    privateKey,
    exchange: {
      pubKey,
      keyId: publicKeyId(pubKey),
      nonce,
      identityKey,
      identityKeyId: publicKeyId(identityKey),
      signature,
    },
  };
}

/**
 * Run one full handshake from both perspectives (used by the transport).
 *
 * Each side contributes a key exchange; the initiator's nonce is the HKDF salt
 * for both. Returns our derived session keys plus the peer's key id, or `null`
 * when anything is malformed.
 */
export function runHandshake(
  myPrivateKey: Buffer,
  theirExchange: HelloKeyExchange,
  initiatorNonce: Buffer,
  isInitiator: boolean,
): HandshakeResult | null {
  if (!isValidPublicKey(theirExchange.pubKey) || initiatorNonce.length !== HANDSHAKE_NONCE_BYTES) {
    return null;
  }

  const keys = deriveSessionKeys(myPrivateKey, theirExchange.pubKey, initiatorNonce, isInitiator);
  if (keys === null) {
    return null;
  }

  return { keys, peerKeyId: publicKeyId(theirExchange.pubKey) };
}

/**
 * Complete our side of the handshake.
 *
 * `theirExchange` is the peer's key-exchange payload; `myPrivateKey` is our
 * ephemeral private key from `createKeyExchange`; `initiatorNonce` is the nonce
 * the *initiator* offered, which HKDF mixes in as salt. `isInitiator` must be
 * true on the dialling side and false on the listening side so each end ends up
 * with opposite send/recv keys.
 *
 * Returns `null` when the exchange is malformed or derivation fails.
 */
export function completeHandshake(
  theirExchange: HelloKeyExchange,
  initiatorNonce: Buffer,
  myPrivateKey: Buffer,
  isInitiator: boolean,
): HandshakeResult | null {
  return runHandshake(myPrivateKey, theirExchange, initiatorNonce, isInitiator);
}

/**
 * TOFU pin store: maps client id → first-seen key id.
 *
 * Backed by the config file so pins survive restarts; entries expire after
 * `PEER_PIN_TTL_MS` from their last successful sighting.
 */
export class PeerPinStore {
  readonly #pins = new Map<string, { keyId: string; seenAt: number }>();

  /** Pre-seed from config (`pins` field: client id → { keyId, seenAt }). */
  seed(entries: unknown): void {
    if (typeof entries !== 'object' || entries === null) {
      return;
    }

    for (const [clientId, pin] of Object.entries(entries as Record<string, unknown>)) {
      if (clientId.length === 0 || clientId.length > 64) {
        continue;
      }

      if (typeof pin !== 'object' || pin === null) {
        continue;
      }

      const record = pin as Record<string, unknown>;
      if (typeof record['keyId'] === 'string' && typeof record['seenAt'] === 'number' && Number.isFinite(record['seenAt'])) {
        this.#pins.set(clientId, { keyId: record['keyId'], seenAt: record['seenAt'] });
      }
    }
  }

  /** Serialise back out for config persistence. */
  toConfig(): Record<string, { keyId: string; seenAt: number }> {
    return Object.fromEntries([...this.#pins.entries()].map(([id, pin]) => [id, { ...pin }]));
  }

  /**
   * Check a peer's key id against the pin store.
   *
   * Returns `'ok'` when the key matches a pin, `'new'` on first contact (and
   * records the pin), or `'mismatch'` — the dangerous case: this client id has
   * talked to us before with a *different* key, which is either a rebuilt
   * install or someone impersonating them.
   */
  check(clientId: string, keyId: string, now: number): 'ok' | 'new' | 'mismatch' {
    const pin = this.#pins.get(clientId);

    if (pin === undefined || now - pin.seenAt > PEER_PIN_TTL_MS) {
      // First contact, or a long-expired pin: record (or re-record) it rather
      // than wedging a legitimately rebuilt install forever.
      this.#pins.set(clientId, { keyId, seenAt: now });
      return 'new';
    }

    if (pin.keyId === keyId) {
      pin.seenAt = now; // refresh on every successful sighting
      return 'ok';
    }

    return 'mismatch';
  }
}

/**
 * Serialise a key-exchange payload into the HELLO `data` object (JSON-safe:
 * buffers become base64).
 */
export function encodeKeyExchangeForWire(exchange: HelloKeyExchange): Record<string, unknown> {
  return {
    pubKey: exchange.pubKey.toString('base64'),
    keyId: exchange.keyId,
    nonce: exchange.nonce.toString('base64'),
    identityKey: exchange.identityKey.toString('base64'),
    identityKeyId: exchange.identityKeyId,
    signature: exchange.signature.toString('base64'),
  };
}

/** Parse and validate a key-exchange payload from the wire. */
export function parseKeyExchangeFromWire(data: unknown): HelloKeyExchange | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const candidate = data as Record<string, unknown>;
  if (
    typeof candidate['pubKey'] !== 'string' ||
    typeof candidate['nonce'] !== 'string' ||
    typeof candidate['identityKey'] !== 'string' ||
    typeof candidate['signature'] !== 'string'
  ) {
    return null;
  }

  let pubKey: Buffer;
  let nonce: Buffer;
  let identityKey: Buffer;
  let signature: Buffer;
  try {
    pubKey = Buffer.from(candidate['pubKey'], 'base64');
    nonce = Buffer.from(candidate['nonce'], 'base64');
    identityKey = Buffer.from(candidate['identityKey'], 'base64');
    signature = Buffer.from(candidate['signature'], 'base64');
  } catch {
    return null;
  }

  const exchange: HelloKeyExchange = {
    pubKey,
    keyId: typeof candidate['keyId'] === 'string' ? candidate['keyId'] : '',
    nonce,
    identityKey,
    identityKeyId: typeof candidate['identityKeyId'] === 'string' ? candidate['identityKeyId'] : '',
    signature,
  };

  // Advertised fingerprints must match the keys they advertise, and the
  // signature must actually be over (ephemeral key || nonce) with the
  // advertised identity key.
  if (
    !isValidKeyExchange(exchange) ||
    publicKeyId(exchange.pubKey) !== exchange.keyId ||
    publicKeyId(exchange.identityKey) !== exchange.identityKeyId ||
    !verifyHandshake(exchange.identityKey, exchange.pubKey, exchange.nonce, exchange.signature)
  ) {
    return null;
  }

  return exchange;
}
