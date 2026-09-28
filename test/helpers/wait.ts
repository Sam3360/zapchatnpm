/**
 * Test helpers: polling waits and free port selection.
 *
 * Nothing here is a mock — the integration tests run real sockets, so they need
 * to wait for the network rather than assume it is instant.
 */

import { randomInt } from 'node:crypto';

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Message used when the predicate never becomes true. */
  label?: string;
}

/** Poll `predicate` until it returns true, or throw with a useful message. */
export async function waitFor(
  predicate: () => boolean,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(intervalMs);
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? 'condition'}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * A random high port for a test run. Tests may run in parallel, so two test
 * files must never share a discovery port.
 */
export function uniquePort(): number {
  return randomInt(47000, 55000);
}

/** Collect text until the predicate matches, or time out. */
export async function waitForText(
  read: () => string,
  match: (text: string) => boolean,
  options: WaitOptions = {},
): Promise<string> {
  await waitFor(() => match(read()), options);
  return read();
}
