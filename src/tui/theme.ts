/**
 * Visual identity.
 *
 * Rules that keep this feeling terminal-native rather than decorative:
 *  - colour communicates state (connected / degraded / error), never decoration;
 *  - only the 16 standard ANSI colours are used, so every terminal theme and
 *    every colour depth (including 8-colour and monochrome) degrades sanely;
 *  - blue is avoided for text: it is unreadable on most dark backgrounds.
 *
 * Ink runs colour through chalk, which already honours NO_COLOR / FORCE_COLOR
 * and downgrades to plain text on terminals without colour support.
 */

export const theme = {
  /** Brand accent: our own identity in the UI. */
  accent: 'cyan',
  title: 'cyanBright',
  /** Structural chrome. */
  border: 'gray',
  divider: 'gray',
  /** Text hierarchy. */
  primary: undefined,
  muted: 'gray',
  subtle: 'gray',
  /** State colours. */
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  info: 'cyan',
  /** Message styling. */
  self: 'cyan',
  system: 'gray',
} as const;

/** Palette for peer usernames. Deterministic per client id, readable on dark and light. */
export const USER_COLORS = [
  'cyan',
  'green',
  'yellow',
  'magenta',
  'red',
  'cyanBright',
  'greenBright',
  'yellowBright',
  'magentaBright',
] as const;

/** FNV-1a: small, fast and stable across runs (unlike object iteration order). */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** Stable display colour for a peer, so the same person keeps the same colour. */
export function userColor(seed: string): string {
  const color = USER_COLORS[hashString(seed) % USER_COLORS.length];
  return color ?? theme.accent;
}

/** Glyphs that measure as a single cell in every monospace terminal. */
export const glyphs = {
  dot: '●',
  prompt: '›',
  pointer: '❯',
} as const;
