"""Tab completion for the Python chat prompt.

Same rules as the npm TUI's `src/tui/completion.ts`:

    /jo<Tab>            -> command names (first word only, "/" required)
    /me waves sa<Tab>   -> later words complete room-member usernames (@ optional)
    /join ge<Tab>       -> room names for /join and /create (# optional)

`completions_for` is pure and unit tested; `TabCompleter` adapts it to the
`readline` module (stdlib on POSIX, optional on Windows). Matching is
case-insensitive; completed candidates keep their original case.
"""

# The Python CLI's actual command set (run_command in cli.py). Deliberately
# not identical to the npm TUI: no /clear, /create or /leave here.
COMMANDS = (
    "help", "h", "?",
    "rooms",
    "users", "who",
    "join",
    "name",
    "connect",
    "me",
    "status",
    "quit", "q", "exit",
)

# Commands whose argument is a room name.
ROOM_ARG_COMMANDS = {"join"}

COMMAND_WORDS = tuple(sorted(set(COMMANDS)))


def completions_for(text, members=(), rooms=()):
    """All full-line candidates for the current input `text`.

    Pure: same inputs -> same outputs. The caller (or readline) picks how to
    rotate; we simply return every candidate that could replace the last
    word, already wrapped with its "/", "@" or "#" prefix.
    """
    stripped = text.lstrip()
    first_word = stripped.split(" ")[0] if stripped else ""
    is_first_word = " " not in stripped and stripped != "" and not stripped.endswith(" ")

    # First word that starts with "/": complete the command name.
    if is_first_word:
        if not first_word.startswith("/"):
            return []
        needle = first_word[1:].lower()
        if not needle:
            return []
        return ["/" + word for word in COMMAND_WORDS if word.startswith(needle)]

    command = first_word[1:].lower() if first_word.startswith("/") else None

    last_word = text.split(" ")[-1]

    if command in ROOM_ARG_COMMANDS:
        needle = last_word.lstrip("#").lower()
        if not needle:
            return []
        prefix = "#" if last_word.startswith("#") else ""
        return [prefix + room for room in rooms if room.lower().startswith(needle)]

    needle = last_word.lstrip("@").lower()
    if not needle:
        return []
    prefix = "@" if last_word.startswith("@") else ""
    return [prefix + member for member in members if member.lower().startswith(needle)]


class TabCompleter:
    """readline adapter: stateful rotation over `completions_for` results."""

    def __init__(self, get_candidates):
        """`get_candidates()` -> {"members": [...], "rooms": [...]} (fresh)."""
        self.get_candidates = get_candidates
        self._candidates = {"members": [], "rooms": []}
        self._matches = []
        self._index = 0

    def _reset(self, text):
        self._candidates = self.get_candidates()
        self._matches = completions_for(
            text, self._candidates["members"], self._candidates["rooms"]
        )
        self._index = 0

    def complete(self, text, state):
        """readline completer protocol: matches for `text`, one per state."""
        if state == 0:
            self._reset(text)
        if not self._matches:
            return None
        try:
            return self._matches[state]
        except IndexError:
            return None
