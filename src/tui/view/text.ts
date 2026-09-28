/**
 * Terminal text measurement.
 *
 * Widths must match what the terminal actually draws, which means grapheme
 * clusters (not code points) and double-width cells for CJK and emoji. We use
 * `string-width` — the same measurement Ink itself uses — over grapheme
 * segments, so our layout maths and Ink's renderer always agree.
 */

import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split into user-perceived characters (emoji, flags and combining marks stay whole). */
export function graphemes(text: string): string[] {
  const parts: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    parts.push(segment);
  }

  return parts;
}

/** Display width of a string in terminal cells. */
export function displayWidth(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return stringWidth(text);
}

/** Truncate to a maximum display width, appending an ellipsis when it does not fit. */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) {
    return '';
  }

  if (displayWidth(text) <= maxWidth) {
    return text;
  }

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = maxWidth - ellipsisWidth;
  if (budget <= 0) {
    // No room for the ellipsis: hard-truncate instead.
    let width = 0;
    let out = '';
    for (const grapheme of graphemes(text)) {
      const next = displayWidth(grapheme);
      if (width + next > maxWidth) {
        break;
      }

      out += grapheme;
      width += next;
    }

    return out;
  }

  let width = 0;
  let out = '';
  for (const grapheme of graphemes(text)) {
    const next = displayWidth(grapheme);
    if (width + next > budget) {
      break;
    }

    out += grapheme;
    width += next;
  }

  return `${out}${ellipsis}`;
}

/**
 * Wrap text to a maximum width. Words are never broken unless a single word is
 * wider than the available space, in which case it is split across lines.
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [];
  }

  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter(word => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    let currentWidth = 0;

    for (const word of words) {
      const wordWidth = displayWidth(word);

      if (wordWidth > maxWidth) {
        // Flush what we have, then hard-break the long word.
        if (current.length > 0) {
          lines.push(current);
          current = '';
          currentWidth = 0;
        }

        let chunk = '';
        let chunkWidth = 0;
        for (const grapheme of graphemes(word)) {
          const next = displayWidth(grapheme);
          if (chunkWidth + next > maxWidth) {
            lines.push(chunk);
            chunk = '';
            chunkWidth = 0;
          }

          chunk += grapheme;
          chunkWidth += next;
        }

        current = chunk;
        currentWidth = chunkWidth;
        continue;
      }

      if (current.length === 0) {
        current = word;
        currentWidth = wordWidth;
        continue;
      }

      if (currentWidth + 1 + wordWidth <= maxWidth) {
        current = `${current} ${word}`;
        currentWidth += 1 + wordWidth;
        continue;
      }

      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    }

    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines;
}

/** Keep the trailing part of a string that fits in `width` cells. */
export function truncateStartToWidth(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) {
    return '';
  }

  if (displayWidth(text) <= maxWidth) {
    return text;
  }

  const ellipsisWidth = displayWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);
  const parts = graphemes(text);

  let width = 0;
  let index = parts.length;
  while (index > 0) {
    const next = displayWidth(parts[index - 1] ?? '');
    if (width + next > budget) {
      break;
    }

    width += next;
    index -= 1;
  }

  return `${ellipsis}${parts.slice(index).join('')}`;
}

/** Pad on the right to exactly `width` cells (never truncates). */
export function padEndTo(text: string, width: number): string {
  const padding = width - displayWidth(text);
  return padding > 0 ? `${text}${' '.repeat(padding)}` : text;
}

/** Centre inside `width` cells, padding both sides. */
export function centerTo(text: string, width: number): string {
  const padding = width - displayWidth(text);
  if (padding <= 0) {
    return text;
  }

  const left = Math.floor(padding / 2);
  return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
}

/** Render a horizontal rule for the frame's inner width. */
export function divider(width: number, character = '─'): string {
  return width <= 0 ? '' : character.repeat(width);
}
