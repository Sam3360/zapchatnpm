/**
 * Turning messages into styled lines, and slicing a viewport out of them.
 *
 * The UI never relies on Ink to wrap text: we compute every visual line here so
 * the number of rows on screen is exactly known. That is what makes scrolling,
 * multi-line messages, long words, emoji and CJK text behave predictably.
 */

import type { ChatMessage } from '../../rooms/registry.js';
import { theme, userColor } from '../theme.js';
import { displayWidth, padEndTo, wrapText } from './text.js';

export interface Span {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  inverse?: boolean;
}

export interface VisualLine {
  /** Stable React key. */
  key: string;
  spans: Span[];
}

export interface TimelineOptions {
  /** Name of the local user (their messages are styled differently). */
  selfName: string;
  /** Minimum width reserved for the username column. */
  minNameWidth?: number;
  /** Maximum width reserved for the username column. */
  maxNameWidth?: number;
  /** Show `HH:MM` in front of messages when the terminal is wide enough. */
  timestamps?: boolean;
  /** Show `── date ──` separators when the day changes. */
  dateSeparators?: boolean;
}

const DEFAULT_MIN_NAME = 3;
const DEFAULT_MAX_NAME = 12;
/** Below this, the message column would be too cramped to read. */
const MIN_MESSAGE_COLUMN = 16;

interface Columns {
  showTime: boolean;
  showDate: boolean;
  nameWidth: number;
  prefixWidth: number;
}

/**
 * Decide the column layout for a given width: timestamps and long usernames are
 * the first things to go when the terminal gets narrow.
 */
export function resolveColumns(
  width: number,
  measuredNameWidth: number,
  options: Partial<TimelineOptions> = {},
): Columns {
  const minName = options.minNameWidth ?? DEFAULT_MIN_NAME;
  const maxName = options.maxNameWidth ?? DEFAULT_MAX_NAME;

  let showTime = (options.timestamps ?? true) && width >= 56;
  let nameWidth = Math.min(Math.max(measuredNameWidth, minName), maxName);
  let prefixWidth = (showTime ? 6 : 0) + nameWidth + 2;

  while (width - prefixWidth < MIN_MESSAGE_COLUMN && nameWidth > minName) {
    nameWidth -= 1;
    prefixWidth -= 1;
  }

  while (width - prefixWidth < MIN_MESSAGE_COLUMN && showTime) {
    showTime = false;
    prefixWidth -= 6;
  }

  return {
    showTime,
    showDate: options.dateSeparators ?? true,
    nameWidth,
    prefixWidth: Math.max(0, Math.min(prefixWidth, Math.max(0, width - 1))),
  };
}

/** `HH:MM` in the machine's local time zone. */
export function formatTime(ts: number): string {
  const date = new Date(ts);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/** `27 Sep 2026` for date separators. */
export function formatDate(ts: number): string {
  const date = new Date(ts);
  const day = String(date.getDate()).padStart(2, '0');
  const month = date.toLocaleString('en', { month: 'short' });
  return `${day} ${month} ${date.getFullYear()}`;
}

export function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Build the full timeline for a room. Callers then slice a viewport out of it,
 * so scrolling is a pure array operation.
 */
export function buildTimeline(
  messages: readonly ChatMessage[],
  width: number,
  options: TimelineOptions,
): VisualLine[] {
  const lines: VisualLine[] = [];
  if (width <= 0) {
    return lines;
  }

  const measuredNameWidth = messages.reduce((widest, message) => {
    if (message.kind === 'system' || message.username.length === 0) {
      return widest;
    }

    return Math.max(widest, displayWidth(message.username));
  }, 0);

  const columns = resolveColumns(width, measuredNameWidth, options);
  const pad = ' '.repeat(columns.prefixWidth);

  let previousDay: string | null = null;

  messages.forEach((message, index) => {
    const day = dayKey(message.ts);
    if (columns.showDate && day !== previousDay && index > 0) {
      previousDay = day;
      lines.push({
        key: `date-${message.id}`,
        spans: [separatorLine(formatDate(message.ts), width)],
      });
    }

    previousDay = day;

    if (message.kind === 'system') {
      const tone = message.tone ?? 'info';
      lines.push({
        key: message.id,
        spans: [
          {
            text: ` ${glyphForTone(tone)} `,
            color: colorForTone(tone),
            dim: tone === 'info',
          },
          ...wrapSpans(message.text, width - 3, {
            color: colorForTone(tone),
            dim: tone === 'info',
          }),
        ],
      });
      return;
    }

    const isSelf = message.self || message.username === options.selfName;
    const nameColor = isSelf ? theme.self : userColor(message.from || message.username);
    const wrapped = wrapText(message.text, Math.max(1, width - columns.prefixWidth));

    wrapped.forEach((text, lineIndex) => {
      const spans: Span[] = [];

      if (lineIndex === 0) {
        if (columns.showTime) {
          spans.push({ text: `${formatTime(message.ts)} `, dim: true });
        }

        spans.push({
          text: `${truncateName(message.username, columns.nameWidth)}  `,
          color: nameColor,
          bold: isSelf,
        });
        spans.push({ text });
      } else {
        spans.push({ text: pad + text });
      }

      lines.push({ key: `${message.id}-${lineIndex}`, spans });
    });
  });

  return lines;
}

/** Truncate a username to the name column width (ellipsis when it does not fit). */
function truncateName(name: string, width: number): string {
  const clamped =
    displayWidth(name) > width ? `${cutToWidth(name, Math.max(1, width - 1))}…` : name;
  return padEndTo(clamped, width);
}

function cutToWidth(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const grapheme of Array.from(text)) {
    const next = displayWidth(grapheme);
    if (used + next > width) {
      break;
    }

    out += grapheme;
    used += next;
  }

  return out;
}

function separatorLine(label: string, width: number): Span {
  const text = `── ${label} `;
  const remaining = Math.max(0, width - displayWidth(text));
  return { text: `${text}${'─'.repeat(remaining)}`, dim: true };
}

function glyphForTone(tone: 'info' | 'warn' | 'error'): string {
  switch (tone) {
    case 'warn':
      return '!';
    case 'error':
      return '×';
    default:
      return '·';
  }
}

function colorForTone(tone: 'info' | 'warn' | 'error'): string {
  switch (tone) {
    case 'warn':
      return theme.warn;
    case 'error':
      return theme.error;
    default:
      return theme.system;
  }
}

/** Wrap a system notice into spans that all share one style. */
function wrapSpans(text: string, width: number, style: Omit<Span, 'text'>): Span[] {
  const wrapped = wrapText(text, Math.max(1, width));
  return wrapped.map((line, index) => ({
    text: index === 0 ? line : `${' '.repeat(3)}${line}`,
    ...style,
  }));
}

export interface Viewport {
  lines: VisualLine[];
  /** Clamped scroll offset: 0 means "pinned to the newest line". */
  offset: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * Keep the visible window still while new lines arrive.
 *
 * Offsets are measured from the bottom, so a line appended at the bottom would
 * otherwise push everything up while the user is reading. When the user has
 * scrolled up, grow the offset by however many lines were added — that pins the
 * window to the same content and lets the "new messages" counter do the talking.
 */
export function stabiliseScroll(
  offset: number,
  addedLines: number,
  totalLines: number,
  height: number,
): number {
  if (offset <= 0 || addedLines <= 0) {
    return offset;
  }

  const maxOffset = Math.max(0, totalLines - Math.max(1, Math.floor(height)));
  return Math.min(maxOffset, offset + addedLines);
}

/**
 * Slice `height` lines out of the timeline, `offset` lines up from the bottom.
 * Out-of-range offsets are clamped, so callers can keep scrolling without
 * bounds checks.
 */
export function sliceViewport(
  lines: readonly VisualLine[],
  height: number,
  offset: number,
): Viewport {
  const visibleHeight = Math.max(1, Math.floor(height));
  const maxOffset = Math.max(0, lines.length - visibleHeight);
  const clamped = Math.min(Math.max(0, Math.floor(offset)), maxOffset);

  const end = lines.length - clamped;
  const start = Math.max(0, end - visibleHeight);

  return {
    lines: lines.slice(start, end),
    offset: clamped,
    hiddenAbove: start,
    hiddenBelow: lines.length - end,
  };
}
