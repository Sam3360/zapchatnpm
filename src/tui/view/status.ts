/**
 * Deriving human-readable status from a snapshot. Pure functions, so the header
 * and `/status` always agree and both are easy to test.
 */

import type { Snapshot } from '../../core/client.js';

export type StatusKind = 'connected' | 'lan' | 'searching' | 'degraded' | 'offline';

export interface StatusDescription {
  kind: StatusKind;
  /** Short label for the header badge. */
  label: string;
  /** Colour name understood by Ink/chalk. */
  color: string;
  /** Longer explanation for `/status` and warning banners. */
  detail: string;
}

export function describeStatus(snapshot: Snapshot): StatusDescription {
  const { status } = snapshot;

  if (status.discovery === 'unavailable') {
    return {
      kind: 'offline',
      label: 'discovery off',
      color: 'red',
      detail: status.discoveryDetail,
    };
  }

  if (status.peersConnected > 0) {
    return {
      kind: 'connected',
      label:
        status.peersConnected === 1
          ? '1 peer connected'
          : `${status.peersConnected} peers connected`,
      color: 'green',
      detail: `direct TCP links open on port ${status.tcpPort}`,
    };
  }

  if (status.discovery === 'degraded') {
    return {
      kind: 'degraded',
      label: 'limited discovery',
      color: 'yellow',
      detail: status.discoveryDetail,
    };
  }

  if (status.peersOnline > 0) {
    return {
      kind: 'lan',
      label: status.peersOnline === 1 ? '1 on LAN' : `${status.peersOnline} on LAN`,
      color: 'green',
      detail: 'peers found on the LAN, connecting…',
    };
  }

  return {
    kind: 'searching',
    label: 'searching',
    color: 'yellow',
    detail: 'no other zapchat clients found yet — they appear here as soon as they start',
  };
}

/** `3 online` / `1 online` / `nobody else yet` for room badges. */
export function onlineLabel(count: number): string {
  if (count <= 1) {
    return count === 1 ? '1 online' : 'nobody yet';
  }

  return `${count} online`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${pluralForm ?? `${singular}s`}`;
}

export interface FooterStatus {
  text: string;
  color?: string;
  dim: boolean;
}

/**
 * What the footer line should say: the newest notice wins, then a broken/degraded
 * discovery setup (which the user must know about), then the last warning, and
 * finally the keyboard hint.
 */
export function footerStatus(snapshot: Snapshot, fallbackHint: string): FooterStatus {
  const notice = snapshot.notice;
  if (notice !== null) {
    switch (notice.tone) {
      case 'error':
        return { text: notice.text, color: 'red', dim: false };
      case 'warn':
        return { text: notice.text, color: 'yellow', dim: false };
      case 'ok':
        return { text: notice.text, color: 'green', dim: false };
      default:
        return { text: notice.text, dim: true };
    }
  }

  if (snapshot.status.discovery !== 'ok') {
    return { text: snapshot.status.discoveryDetail, color: 'yellow', dim: false };
  }

  const warning = snapshot.status.warnings.at(-1);
  if (warning !== undefined) {
    return { text: warning, color: 'yellow', dim: false };
  }

  return { text: fallbackHint, dim: true };
}
