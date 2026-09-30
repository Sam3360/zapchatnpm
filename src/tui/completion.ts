/**
 * Tab completion for the message input.
 *
 * A pure function over the current editor text plus what the UI knows
 * (commands, members, rooms). It never touches the network and never sees
 * anything the local user has not already typed or received.
 *
 * Three completion contexts:
 *
 *   `/jo<Tab>`            → command names (first word only, `/` required)
 *   `/me waves @sa<Tab>`  → later words complete member usernames (@ optional)
 *   `/join #ge<Tab>`      → room names for /join and /create (# optional)
 *
 * Contract: the function is pure. The caller keeps one integer per edit box —
 * `state.matchIndex` — and passes it unchanged while the user keeps pressing
 * Tab, resetting it to 0 whenever the text is edited by hand. That lets
 * repeated Tabs rotate through the matches even though the first press
 * replaced the word (the rotation is by match position, not by the typed
 * needle).
 *
 * Matching is case-insensitive; completed candidates come back in the
 * candidate list's own order (deterministic: commands and rooms are sorted,
 * members arrive in snapshot order).
 */

import { COMMANDS } from '../commands/commands.js';

export interface CompletionContext {
  /** Usernames in the local user's room (excluding the local user). */
  members: readonly string[];
  /** Room names known from discovery (plus the current room). */
  rooms: readonly string[];
}

export interface CompletionState {
  /** How many Tabs have been pressed on the current word. Resets on edit. */
  matchIndex: number;
}

export interface CompletionResult {
  /** Full replacement text after applying the completion. */
  text: string;
  /** All candidates that match, in rotation order. */
  matches: string[];
}

/** Commands + aliases, sorted once — completion feels deterministic. */
const COMMAND_WORDS = (() => {
  const words = new Set<string>();
  for (const command of COMMANDS) {
    words.add(command.name);
    for (const alias of command.aliases ?? []) {
      words.add(alias);
    }
  }

  return [...words].sort();
})();

/** Commands whose argument is a room name. */
const ROOM_ARG_COMMANDS = new Set(['join', 'create']);

const WORD_DELIMITER = ' ';

/** The word the cursor sits in (or just left), and where it starts. */
function wordAt(text: string, cursor: number): { word: string; start: number } {
  const start = text.slice(0, cursor).lastIndexOf(WORD_DELIMITER) + 1;
  return { word: text.slice(start, cursor), start };
}

/**
 * Compute the completion for `text`.
 *
 * See the interface docs for `state.matchIndex` semantics: `N` means "the
 * user has Tabbed N times on this word", so the chosen match is the
 * `N % matches.length`-th — with `0` meaning the needle itself when it is
 * already an exact match (a single Tab on `/join` keeps `/join`).
 */
export function completeInput(
  text: string,
  context: CompletionContext,
  state: CompletionState,
): CompletionResult {
  const cursor = text.length; // the TUI cursor is always at the end
  const { word, start } = wordAt(text, cursor);
  const isFirstWord = text.slice(0, start).trim().length === 0;

  // The first word decides what the argument can be — but only a word that
  // already starts with "/" is a command (plain chat like "me too" must
  // never be completed into "/me").
  const firstWord = text.trimStart().split(WORD_DELIMITER)[0] ?? '';
  const command = firstWord.startsWith('/') ? firstWord.slice(1).toLowerCase() : null;

  let candidates: readonly string[];
  let needle: string;
  let prefixChar: string;

  if (isFirstWord) {
    if (!word.startsWith('/')) {
      return { text, matches: [] };
    }

    candidates = COMMAND_WORDS;
    needle = word.slice(1);
    prefixChar = '/';
  } else if (command !== null && ROOM_ARG_COMMANDS.has(command)) {
    candidates = context.rooms;
    needle = word.replace(/^#/, '');
    prefixChar = word.startsWith('#') ? '#' : '';
  } else {
    candidates = context.members;
    needle = word.replace(/^@/, '');
    prefixChar = word.startsWith('@') ? '@' : '';
  }

  if (needle.length === 0) {
    return { text, matches: [] };
  }

  const lower = needle.toLowerCase();
  const matches = candidates.filter(candidate => candidate.toLowerCase().startsWith(lower));

  if (matches.length === 0) {
    return { text, matches: [] };
  }

  // An exact typed match ("sam", "/join") is position 0 in the rotation, so
  // the first Tab is a no-op — only a *further* Tab cycles to the next name.
  const typedIndex = matches.findIndex(
    candidate => candidate.toLowerCase() === lower,
  );
  const position = typedIndex >= 0 ? typedIndex : matches.length;
  const chosen = matches[(position + state.matchIndex) % matches.length];

  return {
    text: text.slice(0, start) + prefixChar + chosen + text.slice(cursor),
    matches,
  };
}
