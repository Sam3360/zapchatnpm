"""Cryptography for the encrypted TCP mesh (protocol v2).

Byte-compatible port of the npm client's `protocol/crypto.ts` +
`protocol/handshake.ts`. The design it mirrors:

- every install generates a long-term Ed25519 identity key (kept in the local
  config file); its signature over each handshake makes peers recognisable, so
  an active man-in-the-middle is detectable via TOFU pinning from the second
  connection on;
- every TCP connection runs a fresh ephemeral X25519 ECDH, so session keys are
  per-connection and past sessions stay secret even if a key later leaks;
- both direction-specific AES-256-GCM keys are derived with HKDF-SHA256 from
  the shared secret plus both public keys (salt: the *initiator's* nonce), so
  a relaying attacker cannot agree on keys with either end;
- frames are sealed with a per-frame random GCM nonce and the frame header
  bound in as AAD; the transport adds strict sequence numbers on top.

The single third-party dependency is `cryptography`; everything else here is
validation so that no malformed input can crash the caller.

On-the-wire JSON shape (identical to npm): key material is base64 in the
HELLO `data.keyExchange` object, key ids are base64url SHA-256 fingerprints.
"""

import base64
import hashlib
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Lengths shared with the npm protocol constants.
PRIVATE_KEY_BYTES = 32
PUBLIC_KEY_BYTES = 32
HANDSHAKE_NONCE_BYTES = 32
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_ID_BYTES = 8

# Domain separation strings — must match the npm client exactly.
HKDF_INFO_PREFIX = b"zapchat-tcp-v2"
HANDSHAKE_SIGNATURE_CONTEXT = b"zapchat-hs-v2"

_MAX_SIGNATURE_BYTES = 128


# --------------------------------------------------------------- base64 wire

def b64_encode(raw):
    """bytes -> base64 str (standard alphabet, padded), as npm emits."""
    return base64.b64encode(raw).decode("ascii")


def b64_decode(value):
    """base64 str -> bytes, or None for anything malformed.

    Tolerates missing padding (as Node's Buffer.from does) but rejects
    non-alphabet characters.
    """
    if not isinstance(value, str) or not value or len(value) > 4096:
        return None
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
    except Exception:
        return None


def b64url_encode(raw):
    """bytes -> base64url str, npm's publicKeyId shape."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


# ------------------------------------------------------------ asymmetric keys

def generate_private_key():
    """Fresh X25519 private key (32 raw bytes)."""
    return X25519PrivateKey.generate().private_bytes_raw()


def public_key_from_private(private_key):
    """Raw 32-byte X25519 public key for a 32-byte private key."""
    key = X25519PrivateKey.from_private_bytes(bytes(private_key))
    return key.public_key().public_bytes_raw()


def is_valid_public_key(value):
    return isinstance(value, (bytes, bytearray)) and len(value) == PUBLIC_KEY_BYTES


def public_key_id(public_key):
    """8-byte SHA-256 fingerprint, base64url — what gets pinned and compared."""
    digest = hashlib.sha256(bytes(public_key)).digest()
    return b64url_encode(digest[:KEY_ID_BYTES])


def generate_identity_seed():
    """Fresh Ed25519 seed (32 raw bytes) — the long-term identity."""
    return Ed25519PrivateKey.generate().private_bytes_raw()


def identity_public_from_seed(seed):
    """Raw 32-byte Ed25519 public key for a 32-byte seed."""
    key = Ed25519PrivateKey.from_private_bytes(bytes(seed))
    return key.public_key().public_bytes_raw()


def sign_handshake(identity_seed, ephemeral_public_key, nonce):
    """PureEdDSA signature over context || ephemeral pub || nonce."""
    message = HANDSHAKE_SIGNATURE_CONTEXT + bytes(ephemeral_public_key) + bytes(nonce)
    key = Ed25519PrivateKey.from_private_bytes(bytes(identity_seed))
    return key.sign(message)


def verify_handshake(identity_public_key, ephemeral_public_key, nonce, signature):
    """True when the signature checks out; False for any malformed input."""
    if not is_valid_public_key(identity_public_key) or not is_valid_public_key(ephemeral_public_key):
        return False
    if not isinstance(nonce, (bytes, bytearray)) or len(nonce) != HANDSHAKE_NONCE_BYTES:
        return False
    if not isinstance(signature, (bytes, bytearray)) or not signature or len(signature) > _MAX_SIGNATURE_BYTES:
        return False
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes(identity_public_key))
        key.verify(
            bytes(signature),
            HANDSHAKE_SIGNATURE_CONTEXT + bytes(ephemeral_public_key) + bytes(nonce),
        )
        return True
    except Exception:
        return False


# ------------------------------------------------------------ session keys

class SessionKeys:
    """Direction-specific AES-256-GCM keys for one connection."""

    __slots__ = ("send", "recv")

    def __init__(self, send, recv):
        self.send = send
        self.recv = recv


def _ecdh(private_key, peer_public_key):
    """X25519 shared secret, or None on a malformed/small-subgroup key."""
    try:
        ours = X25519PrivateKey.from_private_bytes(bytes(private_key))
        theirs = X25519PublicKey.from_public_bytes(bytes(peer_public_key))
        shared = ours.exchange(theirs)
    except Exception:
        return None

    # An all-zero shared secret is the textbook X25519 small-subgroup result;
    # never derive keys from a secret with no entropy.
    if not shared or all(byte == 0 for byte in shared):
        return None
    return shared


def derive_session_keys(my_private_key, their_public_key, initiator_nonce, is_initiator):
    """Derive the two directional session keys for one connection.

    `initiator_nonce` (the initiator's handshake nonce) is the HKDF salt and
    both public keys are bound into the info string, so keys only match when
    both sides saw the same identities. The initiator seals with the first
    32 OKM bytes and the responder with the second, so each direction has its
    own key. Returns None for malformed input — never throws.
    """
    if not is_valid_public_key(their_public_key):
        return None
    if not isinstance(initiator_nonce, (bytes, bytearray)) or len(initiator_nonce) != HANDSHAKE_NONCE_BYTES:
        return None

    shared = _ecdh(my_private_key, their_public_key)
    if shared is None:
        return None

    my_public = public_key_from_private(my_private_key)
    if is_initiator:
        ours, theirs = my_public, bytes(their_public_key)
    else:
        ours, theirs = bytes(their_public_key), my_public

    okm = HKDF(
        algorithm=hashes.SHA256(),
        length=PRIVATE_KEY_BYTES * 2,
        salt=bytes(initiator_nonce),
        info=HKDF_INFO_PREFIX + ours + theirs,
    ).derive(shared)

    first, second = okm[:PRIVATE_KEY_BYTES], okm[PRIVATE_KEY_BYTES:]
    if is_initiator:
        return SessionKeys(send=first, recv=second)
    return SessionKeys(send=second, recv=first)


# ----------------------------------------------------------------- AEAD

def seal(key, plaintext, aad=None):
    """AES-256-GCM seal: output layout is `nonce || ciphertext || tag`."""
    nonce = os.urandom(NONCE_BYTES)
    sealed = AESGCM(bytes(key)).encrypt(nonce, bytes(plaintext), bytes(aad) if aad is not None else None)
    return nonce + sealed


def open_(key, sealed, aad=None):
    """Open one sealed frame; None for any failure — never throws."""
    if not isinstance(sealed, (bytes, bytearray)) or len(sealed) < NONCE_BYTES + TAG_BYTES:
        return None
    sealed = bytes(sealed)
    nonce = sealed[:NONCE_BYTES]
    body = sealed[NONCE_BYTES:]
    try:
        return AESGCM(bytes(key)).decrypt(nonce, body, bytes(aad) if aad is not None else None)
    except Exception:
        return None


# --------------------------------------------------- key exchange (HELLO data)

class KeyExchange:
    """One side's signed ephemeral key exchange, as carried in a v2 HELLO."""

    __slots__ = ("private_key", "public_key", "key_id", "nonce", "identity_key", "identity_key_id", "signature")

    def __init__(self, private_key, public_key, key_id, nonce, identity_key, identity_key_id, signature):
        self.private_key = private_key
        self.public_key = public_key
        self.key_id = key_id
        self.nonce = nonce
        self.identity_key = identity_key
        self.identity_key_id = identity_key_id
        self.signature = signature


def create_key_exchange(identity_seed):
    """Build our half of the key exchange, signed with our identity key."""
    private_key = generate_private_key()
    public_key = public_key_from_private(private_key)
    nonce = os.urandom(HANDSHAKE_NONCE_BYTES)
    signature = sign_handshake(identity_seed, public_key, nonce)
    identity_key = identity_public_from_seed(identity_seed)

    return KeyExchange(
        private_key=private_key,
        public_key=public_key,
        key_id=public_key_id(public_key),
        nonce=nonce,
        identity_key=identity_key,
        identity_key_id=public_key_id(identity_key),
        signature=signature,
    )


def encode_key_exchange_for_wire(exchange):
    """Serialise a key exchange into the HELLO `data` object (JSON-safe)."""
    return {
        "pubKey": b64_encode(exchange.public_key),
        "keyId": exchange.key_id,
        "nonce": b64_encode(exchange.nonce),
        "identityKey": b64_encode(exchange.identity_key),
        "identityKeyId": exchange.identity_key_id,
        "signature": b64_encode(exchange.signature),
    }


def parse_key_exchange_from_wire(data):
    """Validate an untrusted key-exchange object. Returns KeyExchange or None.

    Advertised fingerprints must match the keys they advertise, and the
    signature must actually verify over (ephemeral key || nonce) with the
    advertised identity key — the same checks as the npm client.
    """
    if not isinstance(data, dict):
        return None

    public_key = b64_decode(data.get("pubKey"))
    nonce = b64_decode(data.get("nonce"))
    identity_key = b64_decode(data.get("identityKey"))
    signature = b64_decode(data.get("signature"))

    if public_key is None or nonce is None or identity_key is None or signature is None:
        return None
    if not is_valid_public_key(public_key) or not is_valid_public_key(identity_key):
        return None
    if len(nonce) != HANDSHAKE_NONCE_BYTES or not signature or len(signature) > _MAX_SIGNATURE_BYTES:
        return None

    key_id = data.get("keyId")
    identity_key_id = data.get("identityKeyId")
    if not isinstance(key_id, str) or not 0 < len(key_id) <= 64:
        return None
    if not isinstance(identity_key_id, str) or not 0 < len(identity_key_id) <= 64:
        return None

    if public_key_id(public_key) != key_id or public_key_id(identity_key) != identity_key_id:
        return None
    if not verify_handshake(identity_key, public_key, nonce, signature):
        return None

    return KeyExchange(
        private_key=None,
        public_key=bytes(public_key),
        key_id=key_id,
        nonce=bytes(nonce),
        identity_key=bytes(identity_key),
        identity_key_id=identity_key_id,
        signature=bytes(signature),
    )
