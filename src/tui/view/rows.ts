/**
 * Composing one-row layouts out of styled spans.
 *
 * Ink's flexbox can reflow a row into two lines when the content does not fit,
 * which would break the fixed-height frame. So every row that mixes text on the
 * left and right is measured and truncated here first, and Ink is only asked to
 * draw spans that are already known to fit.
 */

import { displayWidth, truncateToWidth } from './text.js';

export interface RowSpan {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface ComposedRow {
  /** Left-aligned spans, truncated to fit. */
  left: RowSpan[];
  /** Spaces between left and right. */
  gap: string;
  /** Right-aligned text, truncated to fit (may be empty). */
  right: string;
}

export function spansWidth(parts: readonly RowSpan[]): number {
  return parts.reduce((total, part) => total + displayWidth(part.text), 0);
}

/** Truncate a span list to a maximum width, preserving span order. */
export function truncateSpans(parts: readonly RowSpan[], maxWidth: number): RowSpan[] {
  const result: RowSpan[] = [];
  let used = 0;

  for (const part of parts) {
    if (used >= maxWidth) {
      break;
    }

    const remaining = maxWidth - used;
    const width = displayWidth(part.text);
    if (width <= remaining) {
      result.push(part);
      used += width;
      continue;
    }

    const clipped = truncateToWidth(part.text, remaining);
    if (clipped.length > 0) {
      result.push({ ...part, text: clipped });
      used += displayWidth(clipped);
    }

    break;
  }

  return result;
}

/**
 * Lay out a left span list plus an optional right-aligned label inside `width`
 * cells. The right side is sacrificed first, then the left is truncated, and at
 * least one space is always kept between them.
 */
export function composeRow(
  parts: readonly RowSpan[],
  right: string,
  width: number,
): ComposedRow {
  if (width <= 0) {
    return { left: [], gap: '', right: '' };
  }

  let left = [...parts];
  let leftWidth = spansWidth(left);

  if (leftWidth > width) {
    left = truncateSpans(left, Math.max(0, width - 1));
    leftWidth = spansWidth(left);
  }

  let rightText = right;
  if (rightText.length > 0) {
    const roomForRight = width - leftWidth - 1;
    if (roomForRight < 3) {
      rightText = '';
    } else if (displayWidth(rightText) > roomForRight) {
      rightText = truncateToWidth(rightText, roomForRight);
    }
  }

  const gap = ' '.repeat(Math.max(1, width - leftWidth - displayWidth(rightText)));

  return { left, gap, right: rightText };
}
