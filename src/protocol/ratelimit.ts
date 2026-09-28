/**
 * Token-bucket rate limiting for incoming per-peer traffic.
 *
 * A hostile peer must not be able to drown a timeline or burn CPU by sending
 * thousands of MESSAGE frames per second. Each peer gets a bucket that refills
 * at a steady rate; frames that arrive when the bucket is empty are dropped and
 * counted. The limiter is pure: the caller injects the clock, so tests can run
 * it without waiting.
 *
 * Limits are deliberately generous (normal chat is nowhere near them) — this
 * only trips on abuse, not on excited humans.
 */

export interface RateLimitOptions {
  /** Bucket size (burst capacity). */
  capacity?: number;
  /** Tokens regained per second. */
  refillPerSecond?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

/** Defaults: a burst of 12 messages, sustained ~5 messages/second. */
export const MESSAGE_RATE_LIMIT: RateLimitConfig = { capacity: 12, refillPerSecond: 5 };

export class RateLimiter {
  readonly #capacity: number;
  readonly #refillPerSecond: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: RateLimitOptions = {}) {
    this.#capacity = options.capacity ?? MESSAGE_RATE_LIMIT.capacity;
    this.#refillPerSecond = options.refillPerSecond ?? MESSAGE_RATE_LIMIT.refillPerSecond;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Consume one token for `key`. Returns true when allowed, false when the
   * peer has exceeded its rate and the frame should be dropped.
   */
  allow(key: string): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key);

    if (bucket === undefined) {
      this.#buckets.set(key, { tokens: this.#capacity - 1, updatedAt: now });
      return true;
    }

    // Refill proportionally to elapsed time, capped at capacity.
    const elapsedSeconds = (now - bucket.updatedAt) / 1000;
    if (elapsedSeconds > 0) {
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsedSeconds * this.#refillPerSecond);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Forget one peer (called when a link goes away) so the map cannot grow. */
  forget(key: string): void {
    this.#buckets.delete(key);
  }

  /** Number of tracked peers (for tests and status displays). */
  get size(): number {
    return this.#buckets.size;
  }
}
