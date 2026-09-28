/**
 * Lobby body composition.
 *
 * Rows are built in priority order — rooms first, then who is on the LAN, then
 * the activity log — and then trimmed to the exact body height. Keeping this
 * pure makes it trivial to verify the body always fits (a frame that is too tall
 * makes the terminal scroll, which is the one thing we never want).
 */

import type { Snapshot } from '../../core/client.js';
import { plural } from './status.js';

export interface LobbyRow {
  kind: 'label' | 'room' | 'peer' | 'log' | 'blank';
  text: string;
  right?: string;
  /** Highlighted as the current selection. */
  selected?: boolean;
  color?: string;
  dim?: boolean;
}

export interface LobbyView {
  rows: LobbyRow[];
  /** Index of the first room shown. */
  roomOffset: number;
  /** Total rooms available. */
  roomCount: number;
}

export interface LobbyViewInput {
  snapshot: Snapshot;
  /** Usable body height in rows. */
  height: number;
  /** Room selection, or -1 when there are no rooms. */
  selectedIndex: number;
  /** Activity log lines (command output), oldest first. */
  log: readonly string[];
  /** How many log lines to try to show. */
  logLines?: number;
}

/** Window of `size` slots that keeps `index` visible. */
export function windowAround(
  index: number,
  total: number,
  size: number,
): { offset: number; count: number } {
  const count = Math.max(1, Math.min(total, size));
  if (total <= count) {
    return { offset: 0, count: total };
  }

  const half = Math.floor(count / 2);
  const offset = Math.min(Math.max(0, index - half), total - count);
  return { offset, count };
}

export function buildLobbyView(input: LobbyViewInput): LobbyView {
  const { snapshot, height, selectedIndex, log } = input;
  const rooms = snapshot.rooms;
  const peers = snapshot.peers.filter(peer => peer.online);
  const logLines = Math.max(0, input.logLines ?? 3);

  const visibleLog = log.slice(-logLines);
  const visiblePeers = peers.slice(0, 2);

  // Tail rows drop from the end first when space runs out.
  const tail: LobbyRow[] = [];
  if (visiblePeers.length > 0) {
    tail.push({ kind: 'blank', text: '' });
    tail.push({
      kind: 'label',
      text: 'ON THE LAN',
      right: plural(peers.length, 'peer'),
    });
    for (const peer of visiblePeers) {
      tail.push({
        kind: 'peer',
        text: `  ${peer.username}`,
        right: peer.room === null ? 'no room' : `#${peer.room}`,
        color: peer.connected ? undefined : 'gray',
        dim: !peer.connected,
      });
    }
  }

  if (visibleLog.length > 0) {
    tail.push({ kind: 'blank', text: '' });
    for (const line of visibleLog) {
      tail.push({ kind: 'log', text: `  ${line}`, dim: true });
    }
  }

  const fixedRows = 1; // the ROOMS label
  const roomCapacity = Math.max(1, height - fixedRows - tail.length);
  const window = windowAround(
    Math.max(0, Math.min(selectedIndex, rooms.length - 1)),
    rooms.length,
    roomCapacity,
  );

  const roomRows: LobbyRow[] = [];
  if (rooms.length === 0) {
    roomRows.push({
      kind: 'log',
      text: '  searching the local network…',
      dim: true,
    });
  }

  rooms.slice(window.offset, window.offset + window.count).forEach((room, index) => {
    const absoluteIndex = window.offset + index;
    const selected = absoluteIndex === selectedIndex;
    roomRows.push({
      kind: 'room',
      text: `#${room.name}`,
      right: room.online === 0 ? 'empty' : plural(room.online, 'online', 'online'),
      selected,
      color: selected ? 'cyan' : undefined,
    });
  });

  const rows: LobbyRow[] = [
    {
      kind: 'label',
      text: 'ROOMS',
      right: rooms.length === 0 ? '' : plural(rooms.length, 'room'),
    },
    ...roomRows,
    ...tail,
  ];

  // The room window above already respects the height, so this is only a safety
  // net: drop from the end (log, then peers, then rooms) until it fits.
  while (rows.length > height && rows.length > 1) {
    rows.pop();
  }

  while (rows.length < height) {
    rows.push({ kind: 'blank', text: '' });
  }

  return { rows, roomOffset: window.offset, roomCount: rooms.length };
}
