/**
 * TCP framing: one JSON envelope per line, terminated by `\n`.
 *
 * JSON.stringify escapes newlines inside strings, so a single newline is an
 * unambiguous frame delimiter. The decoder tolerates arbitrary chunk splitting
 * (including mid-UTF-8 sequences), rejects oversized frames, counts everything
 * it drops, and never throws on bad input.
 */

import { StringDecoder } from 'node:string_decoder';
import { MAX_FRAME_BYTES } from './constants.js';
import { parseEnvelope, type Envelope, type ParseEnvelopeOptions } from './messages.js';

export const FRAME_DELIMITER = '\n';

/** Serialise an envelope into a single wire frame (trailing newline included). */
export function encodeFrame(envelope: Envelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}${FRAME_DELIMITER}`, 'utf8');
}

export interface FrameDecoderOptions {
  maxFrameBytes?: number;
  /** Forwarded to envelope validation (tests inject a fixed clock). */
  envelopeOptions?: ParseEnvelopeOptions;
}

export interface FrameDecoderStats {
  /** Frames dropped because they were oversized, not JSON or not valid envelopes. */
  dropped: number;
  /** Bytes discarded because a peer never sent a delimiter. */
  discardedBytes: number;
}

export class FrameDecoder {
  readonly #maxFrameBytes: number;
  readonly #envelopeOptions: ParseEnvelopeOptions;
  readonly #decoder = new StringDecoder('utf8');
  #buffer = '';
  #dropped = 0;
  #discardedBytes = 0;
  /** True while discarding an oversized line until the next delimiter. */
  #discarding = false;

  constructor(options: FrameDecoderOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.#envelopeOptions = options.envelopeOptions ?? {};
  }

  get stats(): FrameDecoderStats {
    return { dropped: this.#dropped, discardedBytes: this.#discardedBytes };
  }

  /**
   * Feed raw bytes in and get back the valid envelopes they contained.
   * Malformed frames are counted and skipped rather than thrown.
   */
  push(chunk: Buffer | Uint8Array | string): Envelope[] {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk));

    const envelopes: Envelope[] = [];
    let newlineIndex = this.#buffer.indexOf(FRAME_DELIMITER);

    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);

      if (this.#discarding) {
        // Tail of an oversized frame: throw the remains away.
        this.#discarding = false;
      } else if (Buffer.byteLength(line, 'utf8') > this.#maxFrameBytes) {
        this.#dropped += 1;
      } else if (line.trim().length > 0) {
        const parsed = this.#parseLine(line);
        if (parsed !== null) {
          envelopes.push(parsed);
        }
      }

      newlineIndex = this.#buffer.indexOf(FRAME_DELIMITER);
    }

    // A peer that streams bytes without ever sending a delimiter cannot make us
    // grow without bound: drop what we have and wait for the next delimiter.
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.#maxFrameBytes) {
      this.#discardedBytes += Buffer.byteLength(this.#buffer, 'utf8');
      this.#buffer = '';
      this.#discarding = true;
      this.#dropped += 1;
    }

    return envelopes;
  }

  #parseLine(line: string): Envelope | null {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#dropped += 1;
      return null;
    }

    const envelope = parseEnvelope(raw, this.#envelopeOptions);
    if (envelope === null) {
      this.#dropped += 1;
      return null;
    }

    return envelope;
  }

  /** Flush any bytes held back by the UTF-8 decoder (call when the socket ends). */
  flush(): Envelope[] {
    const remainder = this.#decoder.end();
    return remainder.length > 0 ? this.push(remainder) : [];
  }
}
