/**
 * Chat commands.
 *
 * Commands are handled entirely on the local client: nothing about them is sent
 * to peers, and they never appear as chat messages. Parsing is a pure function
 * so the UI and the headless mode can share it (and it is unit tested).
 */

export interface CommandSpec {
  /** Command name without the leading slash. */
  name: string;
  /** Argument placeholder, e.g. `<room>`. */
  args?: string;
  summary: string;
  aliases?: string[];
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', summary: 'show this list', aliases: ['h', '?'] },
  { name: 'rooms', summary: 'list rooms discovered on the LAN' },
  {
    name: 'users',
    summary: 'who is online on the LAN, and who is in this room',
    aliases: ['who'],
  },
  { name: 'join', args: '<room>', summary: 'join a room (creates it if nobody is in it)' },
  { name: 'create', args: '<room>', summary: 'create a room and join it' },
  { name: 'leave', summary: 'leave the current room, back to the lobby' },
  { name: 'clear', summary: 'clear the local message view for this room' },
  { name: 'me', args: '<action>', summary: 'do something, e.g. /me waves hello' },
  { name: 'name', args: '<username>', summary: 'change your display name', aliases: ['nick'] },
  {
    name: 'connect',
    args: '<host[:port]>',
    summary: 'connect directly to a peer when discovery is blocked',
  },
  { name: 'status', summary: 'discovery, ports and connection details' },
  { name: 'quit', summary: 'exit zapchat', aliases: ['q', 'exit'] },
] as const;

const COMMAND_LOOKUP = new Map<string, CommandSpec>();
for (const command of COMMANDS) {
  COMMAND_LOOKUP.set(command.name, command);
  for (const alias of command.aliases ?? []) {
    COMMAND_LOOKUP.set(alias, command);
  }
}

export interface ParsedCommand {
  /** Canonical command name (aliases resolved). */
  name: string;
  /** Raw, trimmed argument string (may be empty). */
  args: string;
  /** The line the user typed. */
  raw: string;
  /** False when the name is not a known command or alias. */
  known: boolean;
}

/**
 * Parse a `/command args` line. Returns `null` when the input is not a command,
 * so callers can treat it as a chat message instead.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(withoutSlash);
  const typed = (match?.[1] ?? '').toLowerCase();
  const args = match?.[2]?.trim() ?? '';

  const spec = COMMAND_LOOKUP.get(typed);
  return {
    name: spec?.name ?? typed,
    args,
    raw: trimmed,
    known: spec !== undefined,
  };
}

/** Look up a canonical command (accepts aliases). */
export function findCommand(nameOrAlias: string): CommandSpec | undefined {
  return COMMAND_LOOKUP.get(nameOrAlias.toLowerCase().replace(/^\//, ''));
}

/** `/help` output, one line per command, aligned for a monospace terminal. */
export function helpLines(): string[] {
  const usageWidth = Math.max(
    ...COMMANDS.map(command =>
      `${command.name}${command.args === undefined ? '' : ` ${command.args}`}`.length,
    ),
  );

  const lines = ['commands:'];
  for (const command of COMMANDS) {
    const usage = `${command.name}${command.args === undefined ? '' : ` ${command.args}`}`.padEnd(
      usageWidth + 2,
    );
    const aliases = command.aliases === undefined ? '' : `  (${command.aliases.map(a => `/${a}`).join(', ')})`;
    lines.push(`  /${usage} ${command.summary}${aliases}`);
  }

  lines.push('  anything else you type is sent to the room');
  return lines;
}

/** One-line hint used in the footer of the lobby and room screens. */
export function footerHint(context: 'lobby' | 'room'): string {
  return context === 'lobby'
    ? '↑↓ select · enter join · /help · ctrl+c quit'
    : 'enter send · ↑↓ scroll · pgup/pgdn page · esc leave · /help';
}
