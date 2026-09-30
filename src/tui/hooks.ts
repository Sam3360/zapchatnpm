/**
 * React hooks that adapt the client and the terminal to the UI.
 *
 * The client exposes an immutable snapshot plus a subscribe function, which is
 * exactly what `useSyncExternalStore` wants: the UI never polls, and there is no
 * chance of a stale render.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { Snapshot, ZapClient } from '../core/client.js';
import {
  EMPTY_EDITOR,
  applyKey,
  replaceText,
  type EditorAction,
  type EditorState,
  type KeyDescriptor,
} from './input/lineEditor.js';
import { completeInput, type CompletionContext, type CompletionState } from './completion.js';

/** Subscribe to the client's snapshot. Re-renders on every change. */
export function useZapSnapshot(client: ZapClient): Snapshot {
  const subscribe = useCallback(
    (listener: () => void) => client.subscribe(listener),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

export interface LineEditor {
  state: EditorState;
  /** Number of characters typed (used to decide scroll vs history on ↑/↓). */
  isEmpty: boolean;
  /**
   * Feed one keystroke. The returned action tells the screen what to do next
   * (submit, scroll, history navigation).
   */
  handleKey: (key: KeyDescriptor) => EditorAction;
  /**
   * Apply one Tab press against the completion candidates for the current
   * snapshot (members, rooms). Returns the completed text, or null when
   * nothing matched (the text is left alone). Repeated Tabs without an edit
   * rotate through the matches; any other edit restarts the rotation.
   */
  completeTab: (candidates: CompletionContext) => string | null;
  /**
   * Read the current text/cursor. Unlike `state` this is always fresh, even for
   * keystrokes handled earlier in the same tick (paste, Enter after typing).
   */
  read: () => EditorState;
  setText: (text: string) => void;
  reset: () => void;
  /** Remember a submitted line for ↑/↓ recall. */
  pushHistory: (entry: string) => void;
}

export function useLineEditor(): LineEditor {
  const stateRef = useRef<EditorState>(EMPTY_EDITOR);
  const [state, setState] = useState<EditorState>(EMPTY_EDITOR);
  const historyRef = useRef<string[]>([]);
  const indexRef = useRef<number | null>(null);
  // Tab rotation state: persists across Tab presses, resets on any edit.
  const completionRef = useRef<CompletionState>({ matchIndex: 0 });
  const completionTextRef = useRef<string>(EMPTY_EDITOR.text);

  const commit = useCallback((next: EditorState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const setText = useCallback(
    (text: string) => {
      indexRef.current = null;
      // A hand edit (not a Tab) restarts completion rotation.
      if (text !== completionTextRef.current) {
        completionRef.current = { matchIndex: 0 };
        completionTextRef.current = text;
      }
      commit(replaceText(text));
    },
    [commit],
  );

  const reset = useCallback(() => {
    indexRef.current = null;
    completionRef.current = { matchIndex: 0 };
    completionTextRef.current = EMPTY_EDITOR.text;
    commit(EMPTY_EDITOR);
  }, [commit]);

  const pushHistory = useCallback((entry: string) => {
    const trimmed = entry.trim();
    const history = historyRef.current;
    if (trimmed.length > 0 && history[history.length - 1] !== trimmed) {
      historyRef.current = [...history, trimmed].slice(-50);
    }

    indexRef.current = null;
  }, []);

  const handleKey = useCallback(
    (key: KeyDescriptor): EditorAction => {
      const result = applyKey(stateRef.current, key);

      if (result.action === 'previous') {
        const history = historyRef.current;
        if (history.length > 0) {
          const current = indexRef.current;
          const next = current === null ? history.length - 1 : Math.max(0, current - 1);
          indexRef.current = next;
          commit(replaceText(history[next] ?? ''));
        }

        return 'previous';
      }

      if (result.action === 'next') {
        const history = historyRef.current;
        const current = indexRef.current;
        if (current !== null) {
          const next = current + 1;
          if (next >= history.length) {
            indexRef.current = null;
            commit(EMPTY_EDITOR);
          } else {
            indexRef.current = next;
            commit(replaceText(history[next] ?? ''));
          }
        }

        return 'next';
      }

      if (result.action === 'submit' || result.action === 'cancel') {
        return result.action;
      }

      if (result.action === 'tab') {
        // The screen completes the word (it knows the candidates); the editor
        // just leaves the raw text alone here.
        return 'tab';
      }

      // Any real keystroke restarts Tab rotation.
      if (result.state.text !== completionTextRef.current) {
        completionRef.current = { matchIndex: 0 };
        completionTextRef.current = result.state.text;
      }

      commit(result.state);
      return 'none';
    },
    [commit],
  );

  const completeTab = useCallback(
    (candidates: CompletionContext): string | null => {
      const current = stateRef.current.text;
      const result = completeInput(current, candidates, completionRef.current);
      // Every press advances the rotation — including a press that produced
      // no visible change (an exact typed word is a no-op first, then cycles).
      completionRef.current.matchIndex += 1;
      if (result.matches.length === 0 || result.text === current) {
        return null;
      }

      completionTextRef.current = result.text;
      commit(replaceText(result.text));
      return result.text;
    },
    [commit],
  );

  const read = useCallback(() => stateRef.current, []);

  return {
    state,
    isEmpty: state.text.length === 0,
    handleKey,
    completeTab,
    read,
    setText,
    reset,
    pushHistory,
  };
}

export interface ActivityLog {
  lines: string[];
  push: (text: string) => void;
  clear: () => void;
}

/** Small rolling log used by the lobby for command output and notices. */
export function useActivityLog(limit = 6): ActivityLog {
  const [lines, setLines] = useState<string[]>([]);

  const push = useCallback(
    (text: string) => {
      setLines(previous => [...previous, ...text.split('\n')].slice(-limit));
    },
    [limit],
  );

  const clear = useCallback(() => setLines([]), []);

  return { lines, push, clear };
}

/**
 * Graceful shutdown: stop the client (announce departure, close sockets, save
 * config) and then unmount Ink, which restores the terminal. A second Ctrl+C
 * skips the wait.
 */
export function useGracefulExit(client: ZapClient, exit: () => void): () => void {
  const stoppingRef = useRef(false);
  const exitedRef = useRef(false);

  return useCallback(() => {
    const finish = (): void => {
      if (exitedRef.current) {
        return;
      }

      exitedRef.current = true;
      exit();
    };

    // Second Ctrl+C: stop waiting and unmount immediately.
    if (stoppingRef.current) {
      finish();
      return;
    }

    stoppingRef.current = true;

    // Never hang on shutdown because a socket refuses to close.
    const timer = setTimeout(finish, 1500);
    timer.unref?.();

    void client
      .stop()
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        finish();
      });
  }, [client, exit]);
}
