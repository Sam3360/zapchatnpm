/**
 * Secure TCP framing (protocol v2).
 *
 * Every v2 frame on the wire looks like this:
 *
 *   1 byte   MAGIC  (0xC2)   — a v1 peer never emits this byte
 *   8 bytes  big-endian sequence number
 *   4 bytes  big-endian payload length
 *   N bytes  payload
 *
 * Handshake frames (seq 0) carry the key exchange in plain JSON — every value
 * in them is public. Data frames (seq >= 1) carry
 * `AES-256-GCM(nonce || ciphertext || tag)` over the same JSON envelopes v1
 * used, with the 13-byte header bound in as AAD. Consequences:
 *
 * - a data frame cannot be tampered with, truncated or transplanted onto
 *   another connection without the GCM tag failing;
 * - frames must arrive exactly in sequence order: a repeat, a gap or a frame
 *   that does not decrypt drops the connection, closing replay and drop
   * attacks;
 * - the session keys come from a fresh ECDH per connection, so capturing one
 *   session reveals nothing about any other.
 *
 * Handshake payloads are public by design; peer authentication is TOFU key
 * pinning (see `handshake.ts`), which is what defends against an active MITM.
 */

import { HEADER_BYTES, MAGIC_BYTE, MAX_SECURE_PAYLOAD_BYTES, MAX_SEQ } from './constants.js';
import { NONCE_BYTES, TAG_BYTES, open, seal } from './crypto.js';

export const SEQ_HANDSHAKE = 0;

/** Per-connection send/receive bookkeeping for data frames. */
export interface SecureSession {
  sendKey: Buffer;
  recvKey: Buffer;
  sendSeq: number;
  recvSeq: number;
}

export function createSecureSession(sendKey: Buffer, recvKey: Buffer): SecureSession {
  // Both counters start at the handshake seq; the first *data* frame is seq 1
  // on the sending side and expected as `recvSeq + 1` on the receiving side.
  return { sendKey, recvKey, sendSeq: SEQ_HANDSHAKE, recvSeq: SEQ_HANDSHAKE };
}

/** Serialise the 13-byte frame header. */
export function frameHeader(seq: number, payloadLength: number): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt8(MAGIC_BYTE, 0);
  head.writeBigUInt64BE(BigInt(seq), 1);
  head.writeUInt32BE(payloadLength, 9);
  return head;
}

/** A plaintext handshake frame: header + raw payload (all contents public). */
export function encodeHandshakeFrame(payload: Buffer): Buffer {
  return Buffer.concat([frameHeader(SEQ_HANDSHAKE, payload.length), payload]);
}

/** Seal one data frame with the session's send key and the next sequence number. */
export function encodeSecureFrame(session: SecureSession, payload: Buffer): Buffer {
  const seq = session.sendSeq + 1;
  if (seq > MAX_SEQ) {
    throw new Error('sequence space exhausted');
  }

  // The GCM tag and nonce have fixed sizes, so the sealed length is known
  // before sealing — the header we bind as AAD must already carry it.
  const head = frameHeader(seq, payload.length + NONCE_BYTES + TAG_BYTES);
  const sealed = seal(session.sendKey, payload, head);
  session.sendSeq = seq;
  return Buffer.concat([head, sealed]);
}

/**
 * Open a frame whose 13-byte header has already been read.
 *
 * `seq === 0` is a plaintext handshake payload, returned as-is. Any other seq
 * must be exactly the next expected receive number and must decrypt under the
 * session key with the header as AAD. Returns the payload, or `null` for any
 * failure (replay, gap, tampering, no session yet) — never throws.
 */
export function decodeSecurePayload(
  session: SecureSession | null,
  seq: number,
  head: Buffer,
  payload: Buffer,
): Buffer | null {
  if (seq === SEQ_HANDSHAKE) {
    return payload;
  }

  if (session === null || seq !== session.recvSeq + 1) {
    return null;
  }

  const plain = open(session.recvKey, payload, head);
  if (plain === null) {
    return null;
  }

  session.recvSeq = seq;
  return plain;
}

/** One raw frame read off the wire, header already parsed. */
export interface RawSecureFrame {
  seq: number;
  head: Buffer;
  payload: Buffer;
}

/**
 * Incremental reader for the v2 binary frame stream.
 *
 * Feed socket chunks; it emits complete frames as they arrive. Returns `null`
 * for a protocol violation (wrong magic byte, oversized declared length) — the
 * caller must drop the connection, never try to resynchronise.
 */
export class SecureFrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): RawSecureFrame[] | null {
    if (this.#buffer.length === 0) {
      this.#buffer = Buffer.from(chunk);
    } else {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
    }

    const frames: RawSecureFrame[] = [];
    for (;;) {
      if (this.#buffer.length < HEADER_BYTES) {
        return frames;
      }

      if (this.#buffer.readUInt8(0) !== MAGIC_BYTE) {
        return null; // not a v2 stream (a v1 peer's JSON, or garbage)
      }

      const length = this.#buffer.readUInt32BE(9);
      if (length > MAX_SECURE_PAYLOAD_BYTES) {
        return null; // declared length is absurd: hostile or corrupt
      }

      if (this.#buffer.length < HEADER_BYTES + length) {
        return frames; // wait for the rest of the frame
      }

      const head = Buffer.from(this.#buffer.subarray(0, HEADER_BYTES));
      const payload = Buffer.from(this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length));
      frames.push({ seq: Number(head.readBigUInt64BE(1)), head, payload });
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
    }
  }
}
