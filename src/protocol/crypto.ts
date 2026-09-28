/**
 * Long-term identity key (Ed25519, used to sign handshakes).
 *
 * X25519 key agreement alone is anonymous: anyone on the LAN can run it. The
 * identity key is what makes peers recognisable — every HELLO carries the
 * signer's public key and a signature over the ephemeral exchange, and clients
 * pin the identity key they first saw for a client id (TOFU). An active
 * man-in-the-middle is therefore detectable from the second connection on.
 */

/** DER (PKCS#8) prefix for an Ed25519 private key (the 32-byte seed). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** DER (SPKI) prefix for an Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface IdentityKeyPair {
  /** Ed25519 seed (32 bytes) — this is what the config file stores. */
  seed: Buffer;
  /** Raw Ed25519 public key (32 bytes). */
  publicKey: Buffer;
}

/** Generate a fresh long-term identity key pair. */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const seed = randomBytes(PRIVATE_KEY_BYTES);
  return { seed, publicKey: identityPublicFromSeed(seed) };
}

/** Derive the raw Ed25519 public key for an identity seed. */
export function identityPublicFromSeed(seed: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });

  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(ED25519_SPKI_PREFIX.length);
}

/** Context string bound into every handshake signature. */
const HANDSHAKE_SIGNATURE_CONTEXT = 'zapchat-hs-v2';

/**
 * Sign a handshake: proves we hold the identity key matching the ephemeral
 * exchange we offered, so a pinned identity cannot be impersonated by someone
 * running their own key exchange.
 */
export function signHandshake(
  identitySeed: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array,
): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, identitySeed]),
    format: 'der',
    type: 'pkcs8',
  });

  return edSign(
    null,
    Buffer.concat([Buffer.from(HANDSHAKE_SIGNATURE_CONTEXT, 'utf8'), ephemeralPublicKey, nonce]),
    key,
  );
}

/** Verify a handshake signature. False for any malformed input. */
export function verifyHandshake(
  identityPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  nonce: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!isValidPublicKey(identityPublicKey) || !isValidPublicKey(ephemeralPublicKey)) {
    return false;
  }

  if (nonce.length !== HANDSHAKE_NONCE_BYTES || signature.length === 0 || signature.length > 128) {
    return false;
  }

  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, identityPublicKey]),
      format: 'der',
      type: 'spki',
    });

    return edVerify(
      null,
      Buffer.concat([Buffer.from(HANDSHAKE_SIGNATURE_CONTEXT, 'utf8'), ephemeralPublicKey, nonce]),
      key,
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Cryptography for the encrypted TCP mesh (protocol v2).
 *
 * Deliberately built only on `node:crypto` so the package keeps zero runtime
 * dependencies. The design:
 *
 * - every install generates a long-term X25519 identity key (kept in the local
 *   config file, which is written with owner-only permissions);
 * - every TCP connection runs a fresh ephemeral ECDH, so session keys are
 *   per-connection and past sessions stay secret even if the identity key or a
 *   session key later leaks (forward secrecy);
 * - both direction-specific AES-256-GCM keys are derived with HKDF from the
 *   shared secret plus both public keys, so a MITM who relays but cannot
 *   decrypt produces keys the other side will not agree with, and tampering is
 *   caught by the GCM tag;
 * - frames are sealed with a monotonically increasing counter embedded in the
 *   AAD-checked plaintext, which makes replay, reordering and dropping
 *   detectable at the transport layer.
 *
 * Nothing here trusts its inputs: `open()` returns `null` for any failure
 * instead of throwing, matching the rest of the protocol layer.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from 'node:crypto';

/** X25519 private key length (and the derived session key length). */
export const PRIVATE_KEY_BYTES = 32;

/** Length of the fresh nonce the responder contributes to the handshake. */
export const HANDSHAKE_NONCE_BYTES = 32;

/** AES-GCM nonce length. */
export const NONCE_BYTES = 12;

/** AES-GCM authentication tag length. */
export const TAG_BYTES = 16;

/** Length of the public-key fingerprint used to identify keys on the wire. */
export const KEY_ID_BYTES = 8;

/** Domain separation string mixed into every key derivation. */
const HKDF_INFO_PREFIX = 'zapchat-tcp-v2';

/**
 * DER (PKCS#8) prefix for an X25519 private key, so a raw 32-byte key can be
 * handed to node:crypto. `0420` is the OCTET STRING header for 32 bytes.
 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** DER (SPKI) prefix for an X25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export interface SessionKeys {
  /** Key used to seal frames we send. */
  send: Buffer;
  /** Key used to open frames we receive. */
  recv: Buffer;
}

/** Generate a fresh X25519 private key (32 random bytes). */
export function generatePrivateKey(): Buffer {
  return randomBytes(PRIVATE_KEY_BYTES);
}

/** Derive the raw 32-byte X25519 public key for a private key. */
export function publicKeyFromPrivate(privateKey: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8',
  });

  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
}

/** True when `value` is a well-formed 32-byte X25519 public key. */
export function isValidPublicKey(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === PRIVATE_KEY_BYTES;
}

/** Short fingerprint of a public key, sent in handshakes and stored in pins. */
export function publicKeyId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest().subarray(0, KEY_ID_BYTES).toString('base64url');
}

/**
 * Derive the two directional session keys for one connection.
 *
 * `myPrivateKey` and `theirPublicKey` form the ECDH shared secret. The salt is
 * the *initiator's* nonce, and both public keys are bound into the derivation
 * so keys only match when both sides saw the same identities. `isInitiator`
 * picks which half of the OKM seals our sends (and must be consistent on both
 * ends, so keys are never used in the wrong direction).
 */
export function deriveSessionKeys(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array,
  initiatorNonce: Uint8Array,
  isInitiator: boolean,
): SessionKeys | null {
  if (!isValidPublicKey(theirPublicKey) || initiatorNonce.length !== HANDSHAKE_NONCE_BYTES) {
    return null;
  }

  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, myPrivateKey]), format: 'der', type: 'pkcs8' }),
      publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, theirPublicKey]), format: 'der', type: 'spki' }),
    });
  } catch {
    return null;
  }

  // An all-zero shared secret is the textbook X25519 small-subgroup result;
  // node:crypto already rejects it, but belt and braces: never derive keys
  // from a secret with no entropy.
  const sharedBytes = shared;
  if (sharedBytes.every(byte => byte === 0)) {
    return null;
  }

  const myPublic = publicKeyFromPrivate(myPrivateKey);
  const [ours, theirs] = isInitiator
    ? [myPublic, theirPublicKey]
    : [theirPublicKey, myPublic];

  const okm = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.from(initiatorNonce),
      Buffer.concat([Buffer.from(HKDF_INFO_PREFIX, 'utf8'), ours, theirs]),
      PRIVATE_KEY_BYTES * 2,
    ),
  );

  // Both ends derive the same 64 bytes; the initiator seals with the first
  // half and the responder with the second, so each direction has its own key.
  const first = okm.subarray(0, PRIVATE_KEY_BYTES);
  const second = okm.subarray(PRIVATE_KEY_BYTES);

  return isInitiator
    ? { send: first, recv: second }
    : { send: second, recv: first };
}

/**
 * Seal one frame: random 12-byte GCM nonce, then ciphertext + 16-byte tag.
 * The output layout is `nonce || ciphertext || tag`.
 */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }

  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/**
 * Open one sealed frame. Returns the plaintext, or `null` for any failure
 * (wrong key, corrupted or truncated input, wrong AAD) — never throws.
 */
export function open(key: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Buffer | null {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    return null;
  }

  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }

    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}
