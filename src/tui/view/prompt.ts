/**
 * Prompt line rendering.
 *
 * The terminal's own cursor is not used: a block "cursor" is drawn as an inverse
 * cell, which survives Ink re-renders and never fights the renderer. Long input
 * scrolls horizontally so the caret stays visible on narrow terminals.
 */

import { displayWidth, graphemes, truncateStartToWidth, truncateToWidth } from './text.js';

export interface PromptRender {
  /** Text before the cursor. */
  before: string;
  /** The cell under the cursor (a space when the line is empty). */
  cursor: string;
  /** Text after the cursor. */
  after: string;
  /** True when the line is empty and `before`/`after` should be dimmed. */
  placeholder: boolean;
  /** True when the start of the line was scrolled off to keep the caret visible. */
  scrolled: boolean;
}

export interface PromptOptions {
  /** Width available for the whole input row (caret included). */
  maxWidth: number;
  /** Placeholder shown when the line is empty. */
  placeholder?: string;
  /** Hide the caret (not focused). */
  hideCursor?: boolean;
}

export function renderPrompt(
  text: string,
  cursor: number,
  options: PromptOptions,
): PromptRender {
  const maxWidth = Math.max(1, options.maxWidth);
  const parts = graphemes(text);
  const position = Math.min(Math.max(0, cursor), parts.length);

  if (text.length === 0) {
    const placeholder = truncateToWidth(options.placeholder ?? '', maxWidth);
    return {
      before: placeholder,
      cursor: options.hideCursor === true ? '' : ' ',
      after: '',
      placeholder: true,
      scrolled: false,
    };
  }

  let before = parts.slice(0, position).join('');
  const underCursor = parts[position] ?? ' ';
  let after = parts.slice(position + 1).join('');
  let scrolled = false;

  const cursorWidth = Math.max(1, displayWidth(underCursor));
  const total = displayWidth(before) + cursorWidth + displayWidth(after);

  if (total > maxWidth) {
    // Keep the caret on screen: drop cells from the start first, then the end.
    const roomForBefore = Math.max(0, maxWidth - cursorWidth);
    if (displayWidth(before) > roomForBefore) {
      before = truncateStartToWidth(before, roomForBefore);
      scrolled = true;
    }

    const remaining = Math.max(0, maxWidth - displayWidth(before) - cursorWidth);
    if (displayWidth(after) > remaining) {
      after = truncateToWidth(after, remaining, '');
    }
  }

  return {
    before,
    cursor: options.hideCursor === true ? '' : underCursor,
    after,
    placeholder: false,
    scrolled,
  };
}
