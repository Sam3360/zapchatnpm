"""Secure TCP framing (protocol v2).

Byte-compatible port of the npm client's `protocol/secureFraming.ts`. Every
v2 frame on the wire looks like this:

  1 byte   MAGIC  (0xC2)   — a v1 peer never emits this byte
  8 bytes  big-endian sequence number
  4 bytes  big-endian payload length
  N bytes  payload

Handshake frames (seq 0) carry the key exchange in plain JSON — every value
in them is public. Data frames (seq >= 1) carry
`AES-256-GCM(nonce || ciphertext || tag)` over the same JSON envelopes v1
used, with the 13-byte header bound in as AAD. Consequences:

- a data frame cannot be tampered with, truncated or transplanted onto
  another connection without the GCM tag failing;
- frames must arrive exactly in sequence order: a repeat, a gap or a frame
  that does not decrypt drops the connection, closing replay and drop attacks;
- the session keys come from a fresh ECDH per connection, so capturing one
  session reveals nothing about any other.

Handshake payloads are public by design; peer authentication is TOFU key
pinning (see `identity.py`), which is what defends against an active MITM.
"""

import struct

MAGIC_BYTE = 0xC2
HEADER_BYTES = 13
SEQ_HANDSHAKE = 0
MAX_SECURE_PAYLOAD_BYTES = 16 * 1024
MAX_SEQ = 2**53 - 1

_HEADER = struct.Struct(">BQI")


class SecureSession:
    """Per-connection send/receive bookkeeping for data frames."""

    __slots__ = ("send_key", "recv_key", "send_seq", "recv_seq")

    def __init__(self, send_key, recv_key):
        self.send_key = send_key
        self.recv_key = recv_key
        # Both counters start at the handshake seq; the first *data* frame is
        # seq 1 on the sending side and expected as `recv_seq + 1` on receipt.
        self.send_seq = SEQ_HANDSHAKE
        self.recv_seq = SEQ_HANDSHAKE


def frame_header(seq, payload_length):
    """Serialise the 13-byte frame header."""
    return _HEADER.pack(MAGIC_BYTE, seq, payload_length)


def encode_handshake_frame(payload):
    """A plaintext handshake frame: header + raw payload (all contents public)."""
    return frame_header(SEQ_HANDSHAKE, len(payload)) + payload


def encode_secure_frame(session, payload, seal):
    """Seal one data frame with the session's send key and the next seq.

    `seal` is the AEAD callable (`crypto.seal`), injected to keep this module
    import-light. The GCM nonce and tag have fixed sizes, so the header bound
    as AAD already carries the final sealed length.
    """
    seq = session.send_seq + 1
    if seq > MAX_SEQ:
        raise ValueError("sequence space exhausted")

    head = frame_header(seq, len(payload) + 12 + 16)
    sealed = seal(session.send_key, payload, head)
    session.send_seq = seq
    return head + sealed


def decode_secure_payload(session, seq, head, payload, open_frame):
    """Open a frame whose 13-byte header has already been read.

    `seq == 0` is a plaintext handshake payload, returned as-is. Any other seq
    must be exactly the next expected receive number and must decrypt under
    the session key with the header as AAD. `open_frame` is the AEAD callable
    (`crypto.open_`). Returns the payload, or None for any failure (replay,
    gap, tampering, no session yet) — never throws.
    """
    if seq == SEQ_HANDSHAKE:
        return payload

    if session is None or seq != session.recv_seq + 1:
        return None

    plain = open_frame(session.recv_key, payload, head)
    if plain is None:
        return None

    session.recv_seq = seq
    return plain


class RawSecureFrame:
    """One raw frame read off the wire, header already parsed."""

    __slots__ = ("seq", "head", "payload")

    def __init__(self, seq, head, payload):
        self.seq = seq
        self.head = head
        self.payload = payload


class SecureFrameReader:
    """Incremental reader for the v2 binary frame stream.

    Feed socket chunks; `push` returns a list of RawSecureFrame as they
    complete, or None for a protocol violation (wrong magic byte, absurd
    declared length) — the caller must drop the connection, never try to
    resynchronise.
    """

    __slots__ = ("_buffer",)

    def __init__(self, buffer=b""):
        # `buffer` carries over bytes already consumed from the socket but not
        # yet part of a complete frame (used when a reader is handed over from
        # the handshake phase to the serve loop).
        self._buffer = bytes(buffer)

    def push(self, chunk):
        self._buffer += bytes(chunk)

        frames = []
        while True:
            if len(self._buffer) < HEADER_BYTES:
                return frames

            if self._buffer[0] != MAGIC_BYTE:
                return None  # not a v2 stream (a v1 peer's JSON, or garbage)

            length = _HEADER.unpack(self._buffer[:HEADER_BYTES])[2]
            if length > MAX_SECURE_PAYLOAD_BYTES:
                return None  # declared length is absurd: hostile or corrupt

            if len(self._buffer) < HEADER_BYTES + length:
                return frames  # wait for the rest of the frame

            head = self._buffer[:HEADER_BYTES]
            payload = self._buffer[HEADER_BYTES : HEADER_BYTES + length]
            seq = _HEADER.unpack(head)[1]
            frames.append(RawSecureFrame(seq, head, payload))
            self._buffer = self._buffer[HEADER_BYTES + length :]
