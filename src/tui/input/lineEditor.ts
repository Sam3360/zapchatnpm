/**
 * A tiny, dependency-free single-line editor.
 *
 * All the behaviour lives in a pure reducer so it can be unit tested without a
 * terminal; the Ink hook is a thin wrapper that feeds keystrokes in and renders
 * the result. Cursor positions are grapheme indexes, so emoji and CJK text never
 * get cut in half while editing.
 */

import { graphemes } from '../view/text.js';

export interface EditorState {
  text: string;
  /** Cursor position in grapheme clusters (0 = before the first cluster). */
  cursor: number;
}

export const EMPTY_EDITOR: EditorState = { text: '', cursor: 0 };

/** The subset of Ink's key descriptor this editor cares about. */
export interface KeyDescriptor {
  input: string;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export type EditorAction =
  | 'none'
  /** Enter: the caller should consume `state.text`. */
  | 'submit'
  /** Escape: the caller should cancel the current mode. */
  | 'cancel'
  /** Up arrow: command history when editing, otherwise scroll the timeline. */
  | 'previous'
  /** Down arrow. */
  | 'next'
  | 'page-up'
  | 'page-down'
  /** Tab: completion is the caller's business. */
  | 'tab';

export interface EditResult {
  state: EditorState;
  action: EditorAction;
}

const CONTROL_ONLY = /^[\u0000-\u001F\u007F]+$/;

function toGraphemes(text: string): string[] {
  return graphemes(text);
}

function fromGraphemes(parts: string[]): string {
  return parts.join('');
}

export function clampCursor(state: EditorState): EditorState {
  const length = toGraphemes(state.text).length;
  const cursor = Math.min(Math.max(0, state.cursor), length);
  return cursor === state.cursor ? state : { ...state, cursor };
}

export function insertText(state: EditorState, text: string): EditorState {
  if (text.length === 0) {
    return state;
  }

  const parts = toGraphemes(state.text);
  const cursor = Math.min(Math.max(0, state.cursor), parts.length);
  const insert = toGraphemes(text);
  parts.splice(cursor, 0, ...insert);

  return { text: fromGraphemes(parts), cursor: cursor + insert.length };
}

export function backspace(state: EditorState): EditorState {
  const parts = toGraphemes(state.text);
  const cursor = Math.min(Math.max(0, state.cursor), parts.length);
  if (cursor === 0) {
    return state;
  }

  parts.splice(cursor - 1, 1);
  return { text: fromGraphemes(parts), cursor: cursor - 1 };
}

export function deleteForward(state: EditorState): EditorState {
  const parts = toGraphemes(state.text);
  const cursor = Math.min(Math.max(0, state.cursor), parts.length);
  if (cursor >= parts.length) {
    return state;
  }

  parts.splice(cursor, 1);
  return { text: fromGraphemes(parts), cursor };
}

/** Ctrl+W: delete the word (and any spaces) before the cursor. */
export function deleteWordBefore(state: EditorState): EditorState {
  const parts = toGraphemes(state.text);
  let cursor = Math.min(Math.max(0, state.cursor), parts.length);
  if (cursor === 0) {
    return state;
  }

  let index = cursor;
  while (index > 0 && parts[index - 1] === ' ') {
    index -= 1;
  }

  while (index > 0 && parts[index - 1] !== ' ') {
    index -= 1;
  }

  parts.splice(index, cursor - index);
  cursor = index;
  return { text: fromGraphemes(parts), cursor };
}

/** Ctrl+U: delete everything before the cursor. */
export function deleteBeforeCursor(state: EditorState): EditorState {
  const parts = toGraphemes(state.text);
  const cursor = Math.min(Math.max(0, state.cursor), parts.length);
  parts.splice(0, cursor);
  return { text: fromGraphemes(parts), cursor: 0 };
}

/** Ctrl+K: delete everything after the cursor. */
export function deleteAfterCursor(state: EditorState): EditorState {
  const parts = toGraphemes(state.text);
  const cursor = Math.min(Math.max(0, state.cursor), parts.length);
  parts.splice(cursor);
  return { text: fromGraphemes(parts), cursor };
}

export function moveCursor(state: EditorState, delta: number): EditorState {
  const length = toGraphemes(state.text).length;
  const cursor = Math.min(Math.max(0, state.cursor + delta), length);
  return { text: state.text, cursor };
}

export function setCursor(state: EditorState, cursor: number): EditorState {
  const length = toGraphemes(state.text).length;
  return { text: state.text, cursor: Math.min(Math.max(0, cursor), length) };
}

export function replaceText(text: string): EditorState {
  const parts = toGraphemes(text);
  return { text, cursor: parts.length };
}

/** Replace the whole line with a history entry, cursor at the end. */
export function setFromHistory(text: string): EditorState {
  return replaceText(text);
}

/**
 * Apply one keystroke. Returns the next editor state plus an action the caller
 * may want to handle (submit, history navigation, scrolling).
 */
export function applyKey(state: EditorState, key: KeyDescriptor): EditResult {
  if (key.return === true) {
    return { state, action: 'submit' };
  }

  if (key.escape === true) {
    return { state, action: 'cancel' };
  }

  if (key.upArrow === true) {
    return { state, action: 'previous' };
  }

  if (key.downArrow === true) {
    return { state, action: 'next' };
  }

  if (key.pageUp === true) {
    return { state, action: 'page-up' };
  }

  if (key.pageDown === true) {
    return { state, action: 'page-down' };
  }

  if (key.tab === true) {
    return { state, action: 'tab' };
  }

  if (key.backspace === true) {
    return { state: backspace(state), action: 'none' };
  }

  if (key.delete === true) {
    return { state: deleteForward(state), action: 'none' };
  }

  if (key.leftArrow === true) {
    return { state: moveCursor(state, -1), action: 'none' };
  }

  if (key.rightArrow === true) {
    return { state: moveCursor(state, 1), action: 'none' };
  }

  if (key.home === true) {
    return { state: setCursor(state, 0), action: 'none' };
  }

  if (key.end === true) {
    return { state: setCursor(state, toGraphemes(state.text).length), action: 'none' };
  }

  if (key.ctrl === true) {
    switch (key.input.toLowerCase()) {
      // Ctrl+P / Ctrl+N are the history bindings; the arrow keys scroll the
      // timeline instead, so every key has exactly one job.
      case 'p':
        return { state, action: 'previous' };
      case 'n':
        return { state, action: 'next' };
      case 'a':
        return { state: setCursor(state, 0), action: 'none' };
      case 'e':
        return { state: setCursor(state, toGraphemes(state.text).length), action: 'none' };
      case 'u':
        return { state: deleteBeforeCursor(state), action: 'none' };
      case 'k':
        return { state: deleteAfterCursor(state), action: 'none' };
      case 'w':
        return { state: deleteWordBefore(state), action: 'none' };
      case 'l':
        return { state, action: 'none' };
      default:
        return { state, action: 'none' };
    }
  }

  if (key.meta === true) {
    return { state, action: 'none' };
  }

  // Ignore bare control characters (Ink reports some shortcuts this way).
  if (key.input.length === 0 || CONTROL_ONLY.test(key.input)) {
    return { state, action: 'none' };
  }

  // Ink delivers pasted multi-character text in one call.
  return { state: insertText(state, key.input), action: 'none' };
}
