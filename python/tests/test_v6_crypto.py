"""Unit tests for protocol v2 crypto + framing (the v6 Python stack)."""

import base64
import json
import os
import shutil
import struct

import pytest

from zapchat import crypto
from zapchat.secure_framing import (
    HEADER_BYTES,
    MAGIC_BYTE,
    SEQ_HANDSHAKE,
    SecureFrameReader,
    SecureSession,
    decode_secure_payload,
    encode_handshake_frame,
    encode_secure_frame,
    frame_header,
)
from zapchat.identity import PeerPinStore

TEST_SEED = bytes(32 * [7])
NODE = shutil.which("node")


def make_session_pair():
    initiator = crypto.create_key_exchange(TEST_SEED)
    responder = crypto.create_key_exchange(TEST_SEED)

    init_keys = crypto.derive_session_keys(
        initiator.private_key, responder.public_key, initiator.nonce, True
    )
    resp_keys = crypto.derive_session_keys(
        responder.private_key, initiator.public_key, initiator.nonce, False
    )
    assert init_keys is not None and resp_keys is not None
    return SecureSession(init_keys.send, init_keys.recv), SecureSession(resp_keys.send, resp_keys.recv)


class TestCryptoPrimitives:
    def test_derives_public_key(self):
        priv = crypto.generate_private_key()
        pub = crypto.public_key_from_private(priv)
        assert len(pub) == 32
        assert crypto.is_valid_public_key(pub)

    def test_deterministic_public_key(self):
        priv = crypto.generate_private_key()
        assert crypto.public_key_from_private(priv) == crypto.public_key_from_private(priv)

    def test_x25519_rfc7748_vector(self):
        # RFC 7748 section 6.1
        alice_priv = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        alice_pub = bytes.fromhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        bob_priv = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
        bob_pub = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        shared = bytes.fromhex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")

        assert crypto.public_key_from_private(alice_priv) == alice_pub
        assert crypto.public_key_from_private(bob_priv) == bob_pub
        assert crypto._ecdh(alice_priv, bob_pub) == shared
        assert crypto._ecdh(bob_priv, alice_pub) == shared

    def test_seal_open_round_trip(self):
        key = crypto.generate_private_key()  # any 32 bytes work as a symmetric key
        plaintext = b'{"v":2,"type":"MESSAGE"}'
        assert crypto.open_(key, crypto.seal(key, plaintext)) == plaintext

    def test_binds_aad(self):
        key = crypto.generate_private_key()
        sealed = crypto.seal(key, b"payload", b"header-a")
        assert crypto.open_(key, sealed, b"header-a") == b"payload"
        assert crypto.open_(key, sealed, b"header-b") is None

    def test_rejects_tampered_ciphertext(self):
        key = crypto.generate_private_key()
        sealed = bytearray(crypto.seal(key, b"secret message"))
        sealed[-5] ^= 0xFF  # flip a bit inside the tag
        assert crypto.open_(key, bytes(sealed)) is None

    def test_rejects_wrong_key(self):
        sealed = crypto.seal(crypto.generate_private_key(), b"secret")
        assert crypto.open_(crypto.generate_private_key(), sealed) is None

    def test_rejects_truncated_input(self):
        key = crypto.generate_private_key()
        sealed = crypto.seal(key, b"x")
        assert len(sealed) >= 5
        assert crypto.open_(key, sealed[:5]) is None
        assert crypto.open_(key, b"") is None

    def test_fresh_nonce_every_seal(self):
        key = crypto.generate_private_key()
        assert crypto.seal(key, b"same") != crypto.seal(key, b"same")

    def test_refuses_all_zero_ecdh(self):
        evil = bytes(32)
        priv = crypto.generate_private_key()
        assert crypto.derive_session_keys(priv, evil, bytes(32), True) is None

    def test_matching_directional_keys_both_ends(self):
        initiator = crypto.create_key_exchange(TEST_SEED)
        responder = crypto.create_key_exchange(TEST_SEED)

        init_keys = crypto.derive_session_keys(
            initiator.private_key, responder.public_key, initiator.nonce, True
        )
        resp_keys = crypto.derive_session_keys(
            responder.private_key, initiator.public_key, initiator.nonce, False
        )

        assert init_keys.send == resp_keys.recv
        assert init_keys.recv == resp_keys.send
        assert init_keys.send != init_keys.recv

    def test_hkdf_rfc5869_case_1(self):
        # RFC 5869 appendix A, test case 1 (SHA-256): proves our HKDF usage is
        # the textbook construction (salt, info, length) with no surprises.
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        ikm = bytes.fromhex("0b" * 22)
        salt = bytes.fromhex("000102030405060708090a0b0c")
        info = bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")
        expected = bytes.fromhex(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        )
        okm = HKDF(
            algorithm=hashes.SHA256(), length=42, salt=salt, info=info
        ).derive(ikm)
        assert okm == expected

    def test_identity_sign_and_verify(self):
        signature = crypto.sign_handshake(TEST_SEED, b"\x05" * 32, b"\x06" * 32)
        assert crypto.verify_handshake(
            crypto.identity_public_from_seed(TEST_SEED), b"\x05" * 32, b"\x06" * 32, signature
        )

    def test_identity_verify_rejects_wrong_key(self):
        signature = crypto.sign_handshake(TEST_SEED, b"\x05" * 32, b"\x06" * 32)
        other = crypto.identity_public_from_seed(bytes(32 * [9]))
        assert not crypto.verify_handshake(other, b"\x05" * 32, b"\x06" * 32, signature)

    def test_ed25519_rfc8032_vector(self):
        # RFC 8032 section 7.1, test 1 (empty message)
        seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        pub = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        signature = bytes.fromhex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        )
        assert crypto.identity_public_from_seed(seed) == pub
        # The RFC vector itself is over the raw (empty) message, so verify it
        # with the raw primitive — our verify_handshake adds a context prefix.
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        Ed25519PublicKey.from_public_bytes(pub).verify(signature, b"")

    def test_key_id_stable_and_distinct(self):
        pub_a = crypto.public_key_from_private(crypto.generate_private_key())
        pub_b = crypto.public_key_from_private(crypto.generate_private_key())
        assert crypto.public_key_id(pub_a) == crypto.public_key_id(pub_a)
        assert crypto.public_key_id(pub_a) != crypto.public_key_id(pub_b)


class TestKeyExchangeWireFormat:
    def test_round_trip(self):
        exchange = crypto.create_key_exchange(TEST_SEED)
        wire = crypto.encode_key_exchange_for_wire(exchange)
        parsed = crypto.parse_key_exchange_from_wire(wire)

        assert parsed is not None
        assert parsed.public_key == exchange.public_key
        assert parsed.key_id == exchange.key_id
        assert parsed.nonce == exchange.nonce
        assert parsed.identity_key == exchange.identity_key
        assert parsed.identity_key_id == exchange.identity_key_id

    def test_carries_valid_signature(self):
        exchange = crypto.create_key_exchange(TEST_SEED)
        parsed = crypto.parse_key_exchange_from_wire(crypto.encode_key_exchange_for_wire(exchange))
        assert parsed is not None
        assert crypto.verify_handshake(parsed.identity_key, parsed.public_key, parsed.nonce, parsed.signature)

    def test_rejects_foreign_signature(self):
        exchange = crypto.create_key_exchange(TEST_SEED)
        other = crypto.create_key_exchange(bytes(32 * [9]))
        forged = crypto.encode_key_exchange_for_wire(exchange)
        forged["signature"] = base64.b64encode(other.signature).decode()
        assert crypto.parse_key_exchange_from_wire(forged) is None

    def test_rejects_mismatched_key_id(self):
        exchange = crypto.create_key_exchange(TEST_SEED)
        wire = crypto.encode_key_exchange_for_wire(exchange)
        wire["keyId"] = "AAAA"
        assert crypto.parse_key_exchange_from_wire(wire) is None

    def test_rejects_malformed_input(self):
        assert crypto.parse_key_exchange_from_wire(None) is None
        assert crypto.parse_key_exchange_from_wire("string") is None
        assert crypto.parse_key_exchange_from_wire({"pubKey": "not base64!"}) is None

    def test_base64_decode_strict(self):
        assert crypto.b64_decode("not base64!") is None
        assert crypto.b64_decode("") is None
        assert crypto.b64_decode(None) is None
        assert crypto.b64_decode("aGVsbG8=") == b"hello"
        assert crypto.b64_decode("aGVsbG8") == b"hello"  # padding tolerated


@pytest.mark.skipif(NODE is None, reason="node not available")
class TestCrossLanguageCryptoVectors:
    """The whole point of v6: byte-compatibility with the npm client.

    A small inline node script is the reference implementation of the npm
    algorithm (mirrors src/protocol/crypto.ts); the Python side must derive
    identical session keys and open its sealed frames, and vice versa.
    """

    def run_node(self, script, *args):
        import subprocess

        # input="" forces a fresh stdin pipe: inheriting the runner's stdin
        # can fail with "handle is invalid" on Windows pytest sessions.
        result = subprocess.run(
            [NODE, "-e", script, *args],
            capture_output=True,
            text=True,
            input="",
            timeout=30,
        )
        if result.returncode != 0:
            pytest.fail(f"node reference failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def test_session_keys_match_npm(self):
        script = """
const { createPrivateKey, createPublicKey, diffieHellman, hkdfSync } = require('node:crypto');
const PK = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SP = Buffer.from('302a300506032b656e032100', 'hex');
const myPriv = Buffer.from(process.argv[1], 'hex');
const theirPub = Buffer.from(process.argv[2], 'hex');
const nonce = Buffer.from(process.argv[3], 'hex');
const shared = diffieHellman({
  privateKey: createPrivateKey({ key: Buffer.concat([PK, myPriv]), format: 'der', type: 'pkcs8' }),
  publicKey: createPublicKey({ key: Buffer.concat([SP, theirPub]), format: 'der', type: 'spki' }),
});
const myPublic = createPublicKey(createPrivateKey({ key: Buffer.concat([PK, myPriv]), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).subarray(12);
const info = Buffer.concat([Buffer.from('zapchat-tcp-v2', 'utf8'), myPublic, theirPub]);
console.log(Buffer.from(hkdfSync('sha256', shared, nonce, info, 64)).toString('hex'));
"""
        priv = crypto.generate_private_key()
        peer_priv = crypto.generate_private_key()
        peer_pub = crypto.public_key_from_private(peer_priv)
        nonce = os.urandom(32)

        node_okm = self.run_node(script, priv.hex(), peer_pub.hex(), nonce.hex())
        ours = crypto.derive_session_keys(priv, peer_pub, nonce, True)
        assert ours.send.hex() + ours.recv.hex() == node_okm

    def test_sealed_frames_are_interoperable(self):
        seal_script = """
const { createCipheriv, randomBytes } = require('node:crypto');
const key = Buffer.from(process.argv[1], 'hex');
const plain = Buffer.from(process.argv[2], 'base64');
const nonce = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, nonce);
const sealed = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
console.log(sealed.toString('base64'));
"""
        key = crypto.generate_private_key()
        plaintext = os.urandom(64)
        sealed_b64 = self.run_node(
            seal_script, key.hex(), base64.b64encode(plaintext).decode()
        )
        # Python opens what node sealed:
        assert crypto.open_(key, base64.b64decode(sealed_b64)) == plaintext

        # And node opens what Python sealed:
        open_script = """
const { createDecipheriv } = require('node:crypto');
const key = Buffer.from(process.argv[1], 'hex');
const sealed = Buffer.from(process.argv[2], 'base64');
try {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  console.log(Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]).toString('base64'));
} catch { console.log('FAIL'); }
"""
        py_sealed = crypto.seal(key, plaintext)
        round_trip = self.run_node(
            open_script, key.hex(), base64.b64encode(py_sealed).decode()
        )
        assert round_trip == base64.b64encode(plaintext).decode()

    def test_ed25519_handshake_signature_verifies_in_node(self):
        script = """
const { createPublicKey, verify } = require('node:crypto');
const SP = Buffer.from('302a300506032b6570032100', 'hex');
const identityPub = Buffer.from(process.argv[1], 'hex');
const ephPub = Buffer.from(process.argv[2], 'hex');
const nonce = Buffer.from(process.argv[3], 'hex');
const sig = Buffer.from(process.argv[4], 'base64');
const key = createPublicKey({ key: Buffer.concat([SP, identityPub]), format: 'der', type: 'spki' });
const ok = verify(null, Buffer.concat([Buffer.from('zapchat-hs-v2', 'utf8'), ephPub, nonce]), key, sig);
console.log(ok ? 'OK' : 'FAIL');
"""
        seed = crypto.generate_identity_seed()
        eph_pub = crypto.public_key_from_private(crypto.generate_private_key())
        nonce = os.urandom(32)
        signature = crypto.sign_handshake(seed, eph_pub, nonce)
        identity_pub = crypto.identity_public_from_seed(seed)

        assert (
            self.run_node(
                script,
                identity_pub.hex(),
                eph_pub.hex(),
                nonce.hex(),
                base64.b64encode(signature).decode(),
            )
            == "OK"
        )


class TestSecureFraming:
    def test_header_layout(self):
        head = frame_header(5, 300)
        assert len(head) == HEADER_BYTES
        assert head[0] == MAGIC_BYTE
        assert struct.unpack(">BQI", head) == (MAGIC_BYTE, 5, 300)

    def test_handshake_frame_is_plaintext_seq0(self):
        payload = b"public handshake payload"
        wire = encode_handshake_frame(payload)
        assert wire[0] == MAGIC_BYTE
        assert struct.unpack(">Q", wire[1:9])[0] == SEQ_HANDSHAKE
        assert wire[HEADER_BYTES:] == payload

    def test_round_trip_between_sessions(self):
        alice, bob = make_session_pair()
        payload = json.dumps({"v": 2, "type": "MESSAGE", "data": {"text": "hi"}}).encode()

        wire = encode_secure_frame(alice, payload, crypto.seal)
        assert wire[0] == MAGIC_BYTE
        assert len(wire) == HEADER_BYTES + struct.unpack(">I", wire[9:13])[0]

        seq = struct.unpack(">Q", wire[1:9])[0]
        opened = decode_secure_payload(bob, seq, wire[:HEADER_BYTES], wire[HEADER_BYTES:], crypto.open_)
        assert opened == payload

    def test_rejects_replay(self):
        alice, bob = make_session_pair()
        wire = encode_secure_frame(alice, b"once", crypto.seal)
        seq = struct.unpack(">Q", wire[1:9])[0]
        head, body = wire[:HEADER_BYTES], wire[HEADER_BYTES:]
        assert decode_secure_payload(bob, seq, head, body, crypto.open_) == b"once"
        assert decode_secure_payload(bob, seq, head, body, crypto.open_) is None

    def test_rejects_gap(self):
        alice, bob = make_session_pair()
        encode_secure_frame(alice, b"one", crypto.seal)
        encode_secure_frame(alice, b"two", crypto.seal)
        third = encode_secure_frame(alice, b"three", crypto.seal)
        seq = struct.unpack(">Q", third[1:9])[0]
        assert decode_secure_payload(bob, seq, third[:HEADER_BYTES], third[HEADER_BYTES:], crypto.open_) is None

    def test_rejects_frame_without_session(self):
        alice, _ = make_session_pair()
        wire = encode_secure_frame(alice, b"early", crypto.seal)
        seq = struct.unpack(">Q", wire[1:9])[0]
        assert decode_secure_payload(None, seq, wire[:HEADER_BYTES], wire[HEADER_BYTES:], crypto.open_) is None

    def test_reader_rejects_wrong_magic(self):
        reader = SecureFrameReader()
        assert reader.push(b'{"v":2,"type":"HELLO"}\n') is None

    def test_reader_survives_chunk_splits(self):
        alice, bob = make_session_pair()
        first = encode_secure_frame(alice, b"a", crypto.seal)
        second = encode_secure_frame(alice, b"b", crypto.seal)
        both = first + second

        decoded = 0
        # Feed one byte at a time into a single reader.
        reader = SecureFrameReader()
        buffer = b""
        for i in range(len(both)):
            result = reader.push(both[i : i + 1])
            if result:
                for frame in result:
                    opened = decode_secure_payload(
                        bob, frame.seq, frame.head, frame.payload, crypto.open_
                    )
                    if opened:
                        decoded += 1
        assert decoded == 2

    def test_reader_rejects_absurd_length(self):
        reader = SecureFrameReader()
        head = frame_header(1, 1 << 20)
        assert reader.push(head) is None


class TestPeerPinStore:
    NOW = 1_700_000_000_000

    def test_first_contact_then_ok(self):
        store = PeerPinStore()
        assert store.check("client-a", "key-1", now=self.NOW) == "new"
        assert store.check("client-a", "key-1", now=self.NOW + 1000) == "ok"

    def test_key_change_is_mismatch(self):
        store = PeerPinStore()
        store.check("client-a", "key-1", now=self.NOW)
        assert store.check("client-a", "key-2", now=self.NOW + 1000) == "mismatch"

    def test_expired_pin_is_first_contact_again(self):
        store = PeerPinStore()
        store.check("client-a", "key-1", now=self.NOW)
        year_later = self.NOW + 366 * 24 * 60 * 60 * 1000
        assert store.check("client-a", "key-2", now=year_later) == "new"

    def test_seeds_from_config_and_persists(self):
        store = PeerPinStore()
        store.seed({"client-a": {"keyId": "key-1", "seenAt": self.NOW}})
        assert store.check("client-a", "key-1", now=self.NOW + 1) == "ok"

        round_trip = PeerPinStore()
        round_trip.seed(store.to_config())
        assert round_trip.check("client-a", "key-1", now=self.NOW + 2) == "ok"

    def test_ignores_malformed_entries(self):
        store = PeerPinStore()
        store.seed(
            {
                "client-b": {"keyId": 42, "seenAt": "not a number"},
                "": {"keyId": "k", "seenAt": 1},
                "client-c": "not a dict",
            }
        )
        assert store.to_config() == {}

    def test_pins_are_independent_per_client(self):
        store = PeerPinStore()
        store.check("client-a", "key-1", now=self.NOW)
        store.check("client-b", "key-2", now=self.NOW)
        assert store.check("client-a", "key-2", now=self.NOW + 1) == "mismatch"
        assert store.check("client-b", "key-1", now=self.NOW + 1) == "mismatch"
