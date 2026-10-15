"""Wire protocol shared by discovery beacons and TCP messages.

An envelope is a JSON object with routing metadata and a type-specific
`data` payload. Everything that arrives from the network is untrusted:
`parse_envelope` returns None for anything that does not match the expected
shape, and callers simply drop it.
"""

import json
import re
import time
import uuid

# v6 speaks wire protocol v2 natively (encrypted TCP mesh, see crypto.py and
# secure_framing.py). v1 (plaintext newline-delimited JSON) is the legacy
# wire version of the pre-v6 Python client; it is accepted only behind the
# opt-in `--allow-plaintext` flag, exactly like the npm client.
PROTOCOL_VERSION = 2
LEGACY_WIRE_VERSION = 1
SUPPORTED_WIRE_VERSIONS = (LEGACY_WIRE_VERSION, PROTOCOL_VERSION)

# CTCP-style action framing (`/me waves` -> 0x01 ACTION waves 0x01), matching
# the npm client: no protocol change, v1-only peers render it as plain text.
ACTION_BYTE = "\x01"
_ACTION_PREFIX = ACTION_BYTE + "ACTION "
_ACTION_SUFFIX = ACTION_BYTE

# The npm client uses these limits; stay compatible.
MAX_MESSAGE_CHARS = 1000
MAX_USERNAME_LENGTH = 20
MAX_ROOM_NAME_LENGTH = 20
MAX_UDP_PACKET_BYTES = 1100
MAX_FRAME_BYTES = 8 * 1024
MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

# ------------------------------------------------------------- v8 additions
# Mirrors of src/protocol/constants.ts; keep the two stacks in sync or
# npm<->Py transfers and reactions silently misbehave.

# Longest reaction emoji/text accepted on the wire (characters).
MAX_REACTION_CHARS = 16

# Reactions must come from this set — no free-form text, no zero-width junk.
REACTION_SET = (
    "👍", "👎", "❤", "😂", "😮", "😢", "🎉", "🔥",
    "+1", "-1", "lol", "ok", "wow", "hm",
)

# Message ids may be given as a unique prefix of at least this length.
MIN_ID_PREFIX_CHARS = 4

# Largest file we will offer or accept, in bytes.
MAX_FILE_BYTES = 64 * 1024 * 1024

# Raw bytes per FILE_CHUNK payload (base64 must keep the frame under 8 KiB).
FILE_CHUNK_BYTES = 4096

# Upper bound on chunk indices we accept (derived from the size cap).
MAX_FILE_CHUNKS = -(-MAX_FILE_BYTES // FILE_CHUNK_BYTES)

# Longest received file name (after sanitisation), in characters.
MAX_FILE_NAME_CHARS = 120

# Simultaneous transfers (in + out) per client.
MAX_ACTIVE_TRANSFERS = 8

# An incoming transfer with no chunks for this long expires and is deleted.
TRANSFER_IDLE_TIMEOUT_MS = 60 * 1000

# Subdirectory of the OS temp dir where received files land.
RECEIVED_FILES_DIR = 'zapchat-received'

# How many messages the offline queue buffers per client while disconnected.
OFFLINE_QUEUE_LIMIT = 100

# Queued messages older than this are dropped (temporary by design).
OFFLINE_QUEUE_TTL_MS = 10 * 60 * 1000

MESSAGE_TYPES = {
    "HELLO", "ANNOUNCE", "ROOM_LIST", "PEER_LIST",
    "JOIN", "LEAVE", "MESSAGE", "PING", "PONG",
    # ---- v8: additive types. Older peers drop unknown types at parse time
    # ---- (parse_envelope returns None), exactly as v1 peers drop v2 frames:
    # ---- no crash, no misparse, full interop in both directions.
    "REPLY", "REACTION",
    "FILE_OFFER", "FILE_ACCEPT", "FILE_REJECT", "FILE_CHUNK",
    "FILE_COMPLETE", "FILE_CANCEL",
}

ENVELOPE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
CLIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_\-\. ]+$")
ROOM_PATTERN = re.compile(r"^[a-z0-9][a-z0-9\-_]*$")

# Control characters and C1 range: never allowed in display text.
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# ANSI escape sequences (CSI etc.): strip the whole sequence, not just the
# ESC byte, so a hostile sender cannot repaint the receiver's terminal.
ANSI_SEQUENCES = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])")


def now_ms():
    return int(time.time() * 1000)


def new_message_id():
    return str(uuid.uuid4())


def sanitize_text(value, max_length):
    """Strip ANSI sequences and control characters, cap the length."""
    if not isinstance(value, str):
        return None
    cleaned = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", value)).strip()
    if not cleaned or len(cleaned) > max_length * 2:
        return None
    return cleaned[:max_length]


def sanitize_username(value):
    if not isinstance(value, str):
        return None
    cleaned = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", value)).strip()[:MAX_USERNAME_LENGTH]
    if cleaned and USERNAME_PATTERN.match(cleaned):
        return cleaned
    return None


def sanitize_room_name(value):
    if not isinstance(value, str):
        return None
    cleaned = CONTROL_CHARS.sub("", value).strip().lower()[:MAX_ROOM_NAME_LENGTH]
    if cleaned and ROOM_PATTERN.match(cleaned):
        return cleaned
    return None


def is_valid_port(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535


def is_valid_client_id(value):
    return isinstance(value, str) and CLIENT_ID_PATTERN.match(value) is not None


_IPV4_RE = re.compile(r"^(\d{1,3}\.){3}\d{1,3}$")
_ZONE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


def is_valid_ipv4(value):
    """True for a dotted quad whose octets are all 0-255."""
    if not isinstance(value, str) or not _IPV4_RE.match(value):
        return False
    return all(0 <= int(part) <= 255 for part in value.split("."))


def is_valid_ipv6(value):
    """True for an IPv6 literal, optionally with a zone id (`fe80::1%eth0`).

    The npm mirror of this lives in `src/protocol/sanitize.ts`. Up to eight
    groups of 1-4 hex digits, at most one `::` elision, and an optional
    trailing IPv4 quad (which counts as the last two groups).
    """
    if not isinstance(value, str) or not value or len(value) > 45:
        return False

    address = value
    zone_at = address.find("%")
    if zone_at != -1:
        zone = address[zone_at + 1:]
        address = address[:zone_at]
        if not _ZONE_RE.match(zone):
            return False

    if not address or ":" not in address:
        return False

    parts = address.split("::")
    if len(parts) > 2:
        return False

    head = parts[0].split(":") if parts[0] else []
    tail = parts[1].split(":") if len(parts) == 2 and parts[1] else []
    groups = 0
    all_groups = head + tail

    for index, group in enumerate(all_groups):
        if "." in group:
            # A trailing IPv4 quad stands in for the last two groups.
            if index != len(all_groups) - 1 or not is_valid_ipv4(group):
                return False
            groups += 2
            continue
        if not re.fullmatch(r"[0-9A-Fa-f]{1,4}", group):
            return False
        groups += 1

    return groups <= 8 if len(parts) == 2 else groups == 8


def is_valid_host(value):
    """True for a hostname, IPv4 literal or IPv6 literal (no port)."""
    if not isinstance(value, str) or not value or len(value) > 253:
        return False

    if ":" in value:
        return is_valid_ipv6(value)

    if " " in value or "/" in value:
        return False

    if re.fullmatch(r"\d+(?:\.\d+)*", value):
        return is_valid_ipv4(value)

    return re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?", value) is not None


def split_host_port(value):
    """Split `host`, `host:port` or `[ipv6]:port` into (host, port-or-None).

    An unbracketed value with more than one colon is a bare IPv6 literal: its
    last group is an address part, not a port.
    """
    trimmed = (value or "").strip()

    if trimmed.startswith("["):
        end = trimmed.find("]")
        if end != -1:
            host = trimmed[1:end]
            rest = trimmed[end + 1:]
            return (host, rest[1:] if rest.startswith(":") else None)
        return (trimmed, None)

    separator = trimmed.rfind(":")
    if separator == -1:
        return (trimmed, None)
    if trimmed.find(":") != separator:
        return (trimmed, None)

    return (trimmed[:separator], trimmed[separator + 1:])


def sanitize_address_list(value, max_addresses=8):
    """Keep well-formed IPv4/IPv6 strings, drop everything else."""
    if not isinstance(value, list):
        return []
    kept = []
    for entry in value[: max_addresses * 2]:
        if not isinstance(entry, str):
            if len(kept) >= max_addresses:
                break
            continue
        if is_valid_ipv4(entry):
            kept.append(entry)
        elif is_valid_ipv6(entry):
            # Never advertise a zone id: it is local to this machine.
            kept.append(entry.split("%")[0])
        if len(kept) >= max_addresses:
            break
    return kept


def create_envelope(msg_type, sender_id, username, room=None, data=None, env_id=None, ts=None, version=None):
    """Build an envelope to send. Senders always use this helper.

    `version` re-stamps the wire version (v1 for opt-in plaintext links to
    legacy peers); the default stamps our native PROTOCOL_VERSION.
    """
    return {
        "v": version if version is not None else PROTOCOL_VERSION,
        "id": env_id or new_message_id(),
        "type": msg_type,
        "ts": ts if ts is not None else now_ms(),
        "from": sender_id,
        "username": username,
        "room": room,
        "data": data if data is not None else None,
    }


def _coerce_username(value):
    """Usernames are display-only: repair rather than reject."""
    cleaned = sanitize_username(value)
    if cleaned:
        return cleaned
    if isinstance(value, str):
        stripped = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", value)).strip()[:20]
        if stripped:
            return stripped
    return "unnamed"


def _coerce_room(value):
    if value is None:
        return None
    if isinstance(value, str):
        return sanitize_room_name(value)
    return False  # invalid: reject the whole envelope


def parse_envelope(raw, clock_skew_check=True, allowed_versions=None):
    """Validate an untrusted value into an envelope dict, or None.

    `allowed_versions` limits the accepted wire versions (default: both v1
    and v2). The returned dict carries the envelope's own version in `"v"`.
    """
    if not isinstance(raw, dict):
        return None
    accepted = SUPPORTED_WIRE_VERSIONS if allowed_versions is None else tuple(allowed_versions)
    version = raw.get("v")
    if version not in accepted:
        return None

    env_id = raw.get("id")
    if not isinstance(env_id, str) or not ENVELOPE_ID_PATTERN.match(env_id):
        return None

    msg_type = raw.get("type")
    if msg_type not in MESSAGE_TYPES:
        return None

    sender = raw.get("from")
    if not is_valid_client_id(sender):
        return None

    ts = raw.get("ts")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool) or ts <= 0:
        return None
    if clock_skew_check and abs(now_ms() - ts) > MAX_CLOCK_SKEW_MS:
        return None

    room = _coerce_room(raw.get("room"))
    if room is False:
        return None

    return {
        "v": version,
        "id": env_id,
        "type": msg_type,
        "ts": ts,
        "from": sender,
        "username": _coerce_username(raw.get("username")),
        "room": room,
        "data": raw.get("data"),
    }


def is_action_message(text):
    """True when `text` is a framed action message (0x01 ACTION ... 0x01)."""
    return (
        isinstance(text, str)
        and text.startswith(_ACTION_PREFIX)
        and text.endswith(_ACTION_SUFFIX)
        and len(text) > len(_ACTION_PREFIX)
    )


def encode_action_message(text):
    """Frame a user's action text for the wire; None when empty after trimming."""
    if not isinstance(text, str):
        return None
    body = text.strip()
    if not body:
        return None
    return _ACTION_PREFIX + body + _ACTION_SUFFIX


def action_body(text):
    """Extract the action body (`waves hello`) from a framed message."""
    return text[len(_ACTION_PREFIX) : len(text) - len(_ACTION_SUFFIX)]


def render_action(username, text):
    """Render an action for display: the sender becomes the verb's subject."""
    return "* " + username + " " + action_body(text)


def parse_message_data(data):
    """Validate a MESSAGE payload; return the text or None."""
    if not isinstance(data, dict):
        return None
    text = data.get("text")
    if not isinstance(text, str):
        return None
    if len(text) > MAX_MESSAGE_CHARS * 4:
        return None

    # CTCP action framing must be checked BEFORE control-character stripping:
    # the 0x01 markers would otherwise be destroyed for legitimate actions.
    # The body between the markers is sanitised normally.
    if is_action_message(text):
        body = sanitize_text(action_body(text), MAX_MESSAGE_CHARS)
        if not body:
            return None
        return _ACTION_PREFIX + body + _ACTION_SUFFIX

    cleaned = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", text)).strip()[:MAX_MESSAGE_CHARS]
    return cleaned or None


# ------------------------------------------------------------ v8 payloads
# Wire keys are camelCase on both stacks so npm<->Py stays symmetric.


def parse_message_ref(value):
    """A message-id reference (reply/reaction target): full id or prefix."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not MIN_ID_PREFIX_CHARS <= len(trimmed) <= 64:
        return None
    if not re.match(r"^[A-Za-z0-9_-]+$", trimmed):
        return None
    return trimmed


def parse_reply_data(data):
    """Validate a REPLY payload; returns (text, reply_to) or (None, None)."""
    if not isinstance(data, dict):
        return None, None
    reply_to = parse_message_ref(data.get("replyTo"))
    if reply_to is None:
        return None, None
    text = data.get("text")
    if not isinstance(text, str) or len(text) > MAX_MESSAGE_CHARS * 4:
        return None, None
    if is_action_message(text):
        body = sanitize_text(action_body(text), MAX_MESSAGE_CHARS)
        if not body:
            return None, None
        return _ACTION_PREFIX + body + _ACTION_SUFFIX, reply_to
    cleaned = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", text)).strip()[:MAX_MESSAGE_CHARS]
    return (cleaned or None), reply_to


def parse_reaction_data(data):
    """Validate a REACTION payload; returns (target, reaction) or (None, None)."""
    if not isinstance(data, dict):
        return None, None
    target = parse_message_ref(data.get("target"))
    reaction = data.get("reaction")
    if target is None or not isinstance(reaction, str):
        return None, None
    if len(reaction) > MAX_REACTION_CHARS:
        return None, None
    return (target, reaction) if reaction in REACTION_SET else (None, None)


def _parse_transfer_id(value):
    if not isinstance(value, str):
        return None
    if 8 <= len(value) <= 64 and re.match(r"^[A-Za-z0-9_-]+$", value):
        return value
    return None


def parse_file_offer_data(data):
    """Validate a FILE_OFFER payload, or None.

    Names are display-only and must never carry path parts (path traversal):
    only the final bare component survives.
    """
    if not isinstance(data, dict):
        return None
    transfer_id = _parse_transfer_id(data.get("transferId"))
    size = data.get("size")
    if transfer_id is None:
        return None
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0 or size > MAX_FILE_BYTES:
        return None
    raw_name = data.get("name")
    raw_name = raw_name if isinstance(raw_name, str) else ""
    bare = raw_name.replace("\\", "/").split("/")[-1]
    name = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", bare)).strip()[:MAX_FILE_NAME_CHARS]
    if not name or name in (".", ".."):
        return None
    mime = data.get("mime")
    if not isinstance(mime, str) or not mime or len(mime) > 64:
        mime = None
    else:
        mime = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", mime)).strip()[:64] or None
    return {"transferId": transfer_id, "name": name, "size": size, "mime": mime}


def parse_file_chunk_data(data):
    """Validate a FILE_CHUNK payload, or None. Size-capped before decode."""
    if not isinstance(data, dict):
        return None
    transfer_id = _parse_transfer_id(data.get("transferId"))
    index = data.get("index")
    if transfer_id is None:
        return None
    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= MAX_FILE_CHUNKS:
        return None
    encoded = data.get("data")
    if not isinstance(encoded, str) or not encoded:
        return None
    if len(encoded) > (FILE_CHUNK_BYTES + 2) // 3 * 4 + 8:
        return None
    if not re.match(r"^[A-Za-z0-9+/]+={0,2}$", encoded):
        return None
    return {"transferId": transfer_id, "index": index, "data": encoded}


def parse_transfer_id_data(data):
    """Validate FILE_ACCEPT/REJECT/COMPLETE/CANCEL payloads (id only)."""
    if not isinstance(data, dict):
        return None
    transfer_id = _parse_transfer_id(data.get("transferId"))
    return None if transfer_id is None else {"transferId": transfer_id}


def parse_announce_data(data):
    """Validate an ANNOUNCE/HELLO payload: port, addresses, rooms."""
    if not isinstance(data, dict):
        return None
    port = data.get("port")
    if not is_valid_port(port):
        return None
    addresses = sanitize_address_list(data.get("addresses"))

    # Optional direct-reply port: where a unicast beacon can reach us
    # reliably, immune to multicast outages and to the sender having lost
    # the well-known port (ephemeral bind). Both stacks advertise it since
    # v8.0.
    reply_port = data.get("replyPort")
    if not is_valid_port(reply_port):
        reply_port = 0

    rooms = []
    raw_rooms = data.get("rooms")
    if isinstance(raw_rooms, list):
        for candidate in raw_rooms:
            room = sanitize_room_name(candidate) if isinstance(candidate, str) else None
            if room and room not in rooms:
                rooms.append(room)
    return {"port": port, "addresses": addresses, "rooms": rooms, "reply_port": reply_port}


def parse_room_list_data(data):
    """Validate a ROOM_LIST payload into a list of {name, online}."""
    if not isinstance(data, dict) or not isinstance(data.get("rooms"), list):
        return None
    rooms = []
    for entry in data["rooms"][:128]:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
            continue
        name = sanitize_room_name(entry["name"])
        if not name:
            continue
        online = entry.get("online")
        if isinstance(online, int) and not isinstance(online, bool) and 0 <= online <= 1000:
            rooms.append({"name": name, "online": online})
        else:
            rooms.append({"name": name, "online": 0})
    return {"rooms": rooms}


def parse_hello_data(data):
    """Validate a HELLO payload; returns (info, key_exchange) where either
    part can be None. `info` carries port/addresses/rooms/reply_port (the
    same shape `parse_announce_data` returns); `key_exchange` is a parsed
    crypto.KeyExchange when the HELLO carried one (protocol v2), else None.
    Returns (None, None) when the payload itself is invalid.
    """
    info = parse_announce_data(data)
    if info is None:
        return None, None

    exchange = None
    if isinstance(data, dict) and "keyExchange" in data:
        from .crypto import parse_key_exchange_from_wire

        exchange = parse_key_exchange_from_wire(data["keyExchange"])
        if exchange is None:
            # A malformed or badly-signed exchange is the same as none: the
            # caller decides whether that is fatal (secure mode) or ignorable
            # (plaintext mode, where npm v1 peers send no exchange at all).
            return info, None

    return info, exchange


def encode_envelope(envelope):
    """Serialise one envelope as a TCP frame (JSON plus newline)."""
    return (json.dumps(envelope, separators=(",", ":")) + "\n").encode("utf-8")


def decode_frames(chunk, buffer="", allowed_versions=None):
    """Split received bytes into envelopes.

    TCP gives us arbitrary chunks; JSON envelopes are newline-delimited.
    `allowed_versions` limits the accepted wire versions (see
    `parse_envelope`). Returns (envelopes, leftover_bytes_str). Invalid lines
    are dropped.
    """
    text = buffer + chunk.decode("utf-8", errors="replace")
    envelopes = []
    while "\n" in text:
        line, text = text.split("\n", 1)
        if not line.strip() or len(line) > MAX_FRAME_BYTES:
            continue
        try:
            raw = json.loads(line)
        except ValueError:
            continue
        envelope = parse_envelope(raw, allowed_versions=allowed_versions)
        if envelope is not None:
            envelopes.append(envelope)
    return envelopes, text
