"""Durable per-room chat history (v8.1) — Python twin of src/config/history.ts.

One JSONL file per room in `<config dir>/history/<room>.jsonl`: one chat
message per line, oldest first. Only `kind == "chat"` lines are stored;
system notices ("pypeer joined #general", presence changes) describe a
*session*, not the conversation, so replaying them is noise.

Each file holds at most ` HISTORY_LIMIT` messages; crossing it rewrites the
file trimmed. A torn last line (crash mid-append) is skipped on load, never
fatal — history is best-effort and must never break the chat.
"""

import json
import os
import re

HISTORY_DIR_NAME = "history"
HISTORY_LIMIT = 400  # same cap the npm in-memory timeline uses

_SAFE_ROOM_NAME = re.compile(r"/|[A-Za-z]:|\\")


class HistoryStore:
    """Reads/writes `<config_dir>/history/<room>.jsonl`, one chat line each."""

    def __init__(self, config_dir, limit=HISTORY_LIMIT):
        self._dir = os.path.join(config_dir, HISTORY_DIR_NAME)
        # A hostile room name must not escape the history directory
        # (npm parity: paths are always joined as a single file name).
        self._limit = max(1, limit)
        self._counts = {}  # room -> lines currently on disk

    # ------------------------------------------------------------------ paths

    def _file(self, room):
        if not room or _SAFE_ROOM_NAME.search(room):
            raise ValueError(f"unsafe room name for history: {room!r}")
        return os.path.join(self._dir, f"{room}.jsonl")

    # ------------------------------------------------------------------- load

    def load(self, room):
        """Messages for `room`, oldest first, bounded to `limit`."""
        try:
            path = self._file(room)
        except ValueError:
            return []
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError:
            self._counts[room] = 0
            return []

        messages = []
        for line in raw.split("\n"):
            message = self._parse_line(line)
            if message is not None and message.get("room") == room:
                messages.append(message)

        bounded = messages[-self._limit :]
        self._counts[room] = len(bounded)
        if len(bounded) < len(messages):
            # The file grew past the cap (e.g. after a limit change): fold back.
            self._rewrite(room, bounded)
        return bounded

    def rooms(self):
        """Room names that have a history file on disk."""
        try:
            names = os.listdir(self._dir)
        except OSError:
            return []
        return [name[: -len(".jsonl")] for name in names if name.endswith(".jsonl")]

    # ------------------------------------------------------------------ write

    def append(self, message):
        """Append one chat message. No-op for system lines and replays."""
        if not isinstance(message, dict) or message.get("kind") != "chat":
            return
        room = message.get("room")
        record = {
            "id": str(message.get("id", "")),
            "room": str(room),
            "kind": "chat",
            "text": str(message.get("text", "")),
            "username": str(message.get("username", "")),
            "ts": message.get("ts"),
            "self": bool(message.get("self", False)),
        }
        try:
            path = self._file(room)
            os.makedirs(self._dir, exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        except (OSError, ValueError):
            # History is best-effort: a full disk must never break the chat.
            return

        next_count = self._counts.get(room, 0) + 1
        self._counts[room] = next_count
        if next_count > self._limit:
            self._trim(room)

    def clear_room(self, room):
        """Delete a room's history (`/clear`)."""
        self._counts.pop(room, None)
        try:
            os.remove(self._file(room))
        except (OSError, ValueError):
            pass  # Best-effort; the visible timeline is cleared either way.

    # ------------------------------------------------------------- internals

    @staticmethod
    def _parse_line(line):
        """Parse one JSONL line; a torn/garbage line is skipped, never fatal."""
        trimmed = line.strip()
        if not trimmed:
            return None
        try:
            message = json.loads(trimmed)
        except ValueError:
            return None
        if not isinstance(message, dict):
            return None
        if (
            not isinstance(message.get("id"), str)
            or not isinstance(message.get("room"), str)
            or not isinstance(message.get("text"), str)
            or not isinstance(message.get("ts"), (int, float))
            or message.get("kind") not in ("chat", "system")
        ):
            return None
        return message

    def _trim(self, room):
        try:
            messages = self.load(room)
            self._rewrite(room, messages[-self._limit :])
        except ValueError:
            pass

    def _rewrite(self, room, messages):
        try:
            path = self._file(room)
            os.makedirs(self._dir, exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                for message in messages:
                    handle.write(json.dumps(message, ensure_ascii=False) + "\n")
            self._counts[room] = len(messages)
        except (OSError, ValueError):
            pass
