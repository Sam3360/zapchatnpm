/**
 * File transfer primitives.
 *
 * Everything that arrives over the wire is untrusted: a file name could contain
 * `../` segments, control sequences or an absolute path. This module is the one
 * place that turns a wire name into a path we are willing to write to, and it
 * chunks/joins payloads so the same encoding is used on both ends.
 *
 * The state machine lives in `ZapClient`; these helpers are pure so they can be
 * unit-tested without sockets or the filesystem.
 */

import os from 'node:os';
import path from 'node:path';
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  RECEIVED_FILES_DIR,
} from '../protocol/constants.js';
import { stripControlSequences, truncateChars } from '../protocol/sanitize.js';

/** Anything above this many bytes is refused before a single chunk is read. */
export function isTransferableSize(size: unknown): size is number {
  return (
    typeof size === 'number' &&
    Number.isInteger(size) &&
    size >= 0 &&
    size <= MAX_FILE_BYTES
  );
}

/**
 * Reduce an arbitrary wire string to a bare, safe file name.
 *
 * Strips directories (both separators), control/ANSI sequences and leading
 * dots, then truncates. Returns `null` when nothing usable is left, so callers
 * reject the offer instead of inventing a name.
 */
export function sanitizeFileName(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  // Normalise both separators to `/`, then keep only the last component. This
  // alone defeats `../../etc/passwd` and (on POSIX) `/etc/passwd`.
  const slashed = input.replace(/\\/g, '/');
  const basename = slashed.slice(slashed.lastIndexOf('/') + 1);

  const cleaned = stripControlSequences(basename)
    // A file name is a single line: collapse anything whitespace-like.
    .replace(/\s+/g, ' ')
    .trim()
    // Remove any residual path or shell-significant characters.
    .replace(/[/\\:*?"<>|]/g, '_');

  // `.` and `..` (and dot-only names) have no basename meaning.
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) {
    return null;
  }

  return truncateChars(cleaned, MAX_FILE_NAME_CHARS);
}

/** Directory where accepted files land (`<tmp>/zapchat-received`). */
export function receivedFilesDir(tmpDir: string = os.tmpdir()): string {
  return path.join(tmpDir, RECEIVED_FILES_DIR);
}

/**
 * Build the on-disk path for an incoming file and prove it stays inside `dir`.
 *
 * Transfers get a unique prefix so two peers sending `photo.png` cannot clobber
 * each other. Returns `null` if the (already sanitised) name would escape `dir`,
 * which must never happen but is cheaper to check than to trust.
 */
export function receivedFilePath(
  dir: string,
  transferId: string,
  fileName: string,
): string | null {
  const safeName = sanitizeFileName(fileName);
  if (safeName === null || !/^[A-Za-z0-9_-]+$/.test(transferId)) {
    return null;
  }

  const target = path.resolve(dir, `${transferId}-${safeName}`);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }

  return target;
}

/** Number of chunks a file of `size` bytes is split into. */
export function chunkCount(size: number): number {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

/** Human-readable byte count, e.g. `1.4 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
