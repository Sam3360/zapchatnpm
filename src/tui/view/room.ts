/**
 * Room screen body helpers.
 */

import { centerTo, displayWidth, padEndTo, truncateToWidth } from './text.js';

/**
 * Placeholder shown when a room has no messages yet: a short, calm hint that
 * also explains how anyone else would find this room.
 */
export function emptyRoomRows(room: string, width: number, height: number): string[] {
  const lines = [
    `#${room} is quiet.`,
    '',
    'nothing on this LAN yet — invite someone on the same network,',
    'they will find this room automatically.',
  ];

  const rows: string[] = [];
  const topPadding = Math.max(0, Math.floor((height - lines.length) / 2));

  for (let index = 0; index < topPadding; index += 1) {
    rows.push('');
  }

  for (const line of lines) {
    // Truncate first so the placeholder never overflows a narrow terminal.
    rows.push(padEndTo(centerTo(truncateToWidth(line, width), width), width));
  }

  while (rows.length < height) {
    rows.push('');
  }

  return rows.slice(0, height);
}

/** Scrolling indicator shown in the footer while reading older messages. */
export function scrollLabel(hiddenAbove: number, hiddenBelow: number): string {
  const parts: string[] = [];
  if (hiddenAbove > 0) {
    parts.push(`↑ ${hiddenAbove} older`);
  }

  if (hiddenBelow > 0) {
    parts.push(`↓ ${hiddenBelow} new`);
  }

  return parts.join(' · ');
}

/** One-line summary of who is in the room (excluding the local user). */
export function membersLabel(names: readonly string[], width: number): string {
  if (names.length === 0) {
    return 'nobody else here';
  }

  const text = names.join(', ');
  if (displayWidth(text) <= width) {
    return text;
  }

  let taken = 0;
  const shown: string[] = [];
  for (const name of names) {
    const next = displayWidth(name) + (shown.length > 0 ? 2 : 0);
    if (taken + next > width - 6) {
      break;
    }

    shown.push(name);
    taken += next;
  }

  return `${shown.join(', ')} +${names.length - shown.length}`;
}
