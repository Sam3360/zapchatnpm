"""File transfer primitives — the Python mirror of src/files/transfers.ts.

Everything that arrives over the wire is untrusted: a file name could contain
`../` segments, control sequences or an absolute path. This module is the one
place that turns a wire name into a path we are willing to write to, and it
formats/chunks payloads so the same encoding is used on both stacks.

The transfer *state machine* lives in `client.py`; these helpers are pure so
they can be unit-tested without sockets or the filesystem.
"""

import os
import re
import tempfile

from .protocol import (
    CONTROL_CHARS,
    FILE_CHUNK_BYTES,
    MAX_FILE_BYTES,
    MAX_FILE_NAME_CHARS,
    RECEIVED_FILES_DIR,
)

_CONTROL = CONTROL_CHARS
# ANSI escape sequences (same shape as protocol.ANSI_SEQUENCES).
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])")


def is_transferable_size(size):
    """True when `size` is an int (not bool) in [0, MAX_FILE_BYTES]."""
    return isinstance(size, int) and not isinstance(size, bool) and 0 <= size <= MAX_FILE_BYTES


def sanitize_file_name(value):
    """Reduce an arbitrary wire/local string to a bare, safe file name.

    Strips directories (both separators), control/ANSI sequences and leading
    dots, then truncates. Returns `None` when nothing usable is left, so
    callers reject the offer instead of inventing a name.
    """
    if not isinstance(value, str):
        return None

    # Normalise both separators to `/`, then keep only the last component.
    # This alone defeats `../../etc/passwd` (and `/etc/passwd` on POSIX).
    slashed = value.replace("\\", "/")
    bare = slashed.rsplit("/", 1)[-1]

    # ANSI first: CONTROL_CHARS also swallows ESC (\x1b), so stripping control
    # bytes first would leave the bare remainder of an escape sequence ("[31m").
    cleaned = _CONTROL.sub("", _ANSI.sub("", bare))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = re.sub(r'[/\\:*?"<>|]', "_", cleaned)

    if not cleaned or re.fullmatch(r"\.+", cleaned):
        return None

    return cleaned[:MAX_FILE_NAME_CHARS]


def received_files_dir(tmp_dir=None):
    """Directory where accepted files land (`<tmp>/zapchat-received`)."""
    return os.path.join(tmp_dir or tempfile.gettempdir(), RECEIVED_FILES_DIR)


def received_file_path(directory, transfer_id, file_name):
    """Build the on-disk path for an incoming file inside `directory`.

    Transfers get a unique prefix so two peers sending `photo.png` cannot
    clobber each other. Returns `None` if the (already sanitised) name would
    escape `directory`, which must never happen but is cheaper to check than
    to trust.
    """
    safe_name = sanitize_file_name(file_name)
    if safe_name is None or not re.fullmatch(r"[A-Za-z0-9_-]+", transfer_id or ""):
        return None

    target = os.path.abspath(os.path.join(directory, f"{transfer_id}-{safe_name}"))
    root = os.path.abspath(directory)
    if target != root and not target.startswith(root + os.sep):
        return None

    return target


def chunk_count(size):
    """Number of chunks a file of `size` bytes is split into."""
    return -(-size // FILE_CHUNK_BYTES)


def format_bytes(byte_count):
    """Human-readable byte count, e.g. `1.4 MiB` (mirrors the npm helper)."""
    if byte_count < 1024:
        return f"{byte_count} B"

    units = ["KiB", "MiB", "GiB"]
    value = byte_count / 1024
    unit = 0
    while value >= 1024 and unit < len(units) - 1:
        value /= 1024
        unit += 1

    decimals = 0 if value >= 10 else 1
    return f"{value:.{decimals}f} {units[unit]}"
