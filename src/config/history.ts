/**
 * Durable per-room chat history (v8.1).
 *
 * One JSONL file per room in `<config dir>/history/<room>.jsonl`: one chat
 * message per line, oldest first. Why JSONL and not a database:
 *  - append is a single atomic `writeFileSync` at chat rate (never lossy on
 *    a crash mid-write — a torn last line is skipped on load);
 *  - the file is human-readable and trivially inspectable/deletable;
 *  - there is no server, so there is nothing to migrate.
 *
 * Only `kind: 'chat'` lines are stored. System notices ("you joined #general",
 * presence changes) describe a *session*, not the conversation — replaying
 * yesterday's join notices would be noise, and keeping stores identical
 * across the npm and Python stacks is worth more than exactness.
 *
 * Each file holds at most `limit` messages (the same cap the in-memory
 * timeline uses); crossing it rewrites the file trimmed. `--no-history`
 * simply never constructs a store.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../rooms/registry.js';

export const HISTORY_DIR_NAME = 'history';

/** Parse one JSONL line; a torn/garbage line is skipped, never fatal. */
function parseLine(line: string): ChatMessage | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const message = JSON.parse(trimmed) as ChatMessage;
    if (
      typeof message.id !== 'string' ||
      typeof message.room !== 'string' ||
      typeof message.text !== 'string' ||
      typeof message.ts !== 'number' ||
      (message.kind !== 'chat' && message.kind !== 'system')
    ) {
      return null;
    }

    return message;
  } catch {
    return null;
  }
}

export class HistoryStore {
  readonly #dir: string;
  readonly #limit: number;
  /** room -> lines currently on disk (kept in memory to bound rewrites). */
  readonly #counts = new Map<string, number>();

  constructor(configDir: string, limit: number) {
    this.#dir = path.join(configDir, HISTORY_DIR_NAME);
    this.#limit = Math.max(1, limit);
  }

  /** All messages for a room, oldest first (bounded to `limit`). */
  load(room: string): ChatMessage[] {
    const file = this.#file(room);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      this.#counts.set(room, 0);
      return [];
    }

    const messages: ChatMessage[] = [];
    for (const line of raw.split('\n')) {
      const message = parseLine(line);
      if (message !== null && message.room === room) {
        messages.push(message);
      }
    }

    const bounded = messages.slice(-this.#limit);
    this.#counts.set(room, bounded.length);
    if (bounded.length < messages.length) {
      // The file grew past the cap (e.g. after a limit change): fold it back.
      this.#rewrite(room, bounded);
    }

    return bounded;
  }

  /** Rooms that have a history file on disk. */
  rooms(): string[] {
    try {
      return fs
        .readdirSync(this.#dir)
        .filter(name => name.endsWith('.jsonl'))
        .map(name => name.slice(0, -'.jsonl'.length));
    } catch {
      return [];
    }
  }

  /** Append one chat message. No-op for system lines and for replays. */
  append(message: ChatMessage): void {
    if (message.kind !== 'chat') {
      return;
    }

    const room = message.room;
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      fs.appendFileSync(this.#file(room), `${JSON.stringify(message)}\n`, 'utf8');
    } catch {
      // History is best-effort: a full disk must never break the chat.
      return;
    }

    const next = (this.#counts.get(room) ?? 0) + 1;
    this.#counts.set(room, next);
    if (next > this.#limit) {
      this.#trim(room);
    }
  }

  /** Delete a room's history (`/clear`). */
  clearRoom(room: string): void {
    this.#counts.delete(room);
    try {
      fs.rmSync(this.#file(room), { force: true });
    } catch {
      // Best-effort; the in-memory timeline is cleared either way.
    }
  }

  /** Drop the oldest messages so the file holds at most `limit`. */
  #trim(room: string): void {
    const messages = this.load(room);
    this.#rewrite(room, messages.slice(-this.#limit));
  }

  #rewrite(room: string, messages: ChatMessage[]): void {
    try {
      fs.mkdirSync(this.#dir, { recursive: true });
      const body = messages.map(message => JSON.stringify(message)).join('\n');
      fs.writeFileSync(this.#file(room), body.length > 0 ? `${body}\n` : '', 'utf8');
      this.#counts.set(room, messages.length);
    } catch {
      // Best-effort trim.
    }
  }

  #file(room: string): string {
    // Room names are already validated to [a-z0-9][a-z0-9-_]* by the
    // protocol layer, but never trust that here: path traversal would turn
    // a chat input into filesystem access.
    const safe = room.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'room';
    return path.join(this.#dir, `${safe}.jsonl`);
  }
}
