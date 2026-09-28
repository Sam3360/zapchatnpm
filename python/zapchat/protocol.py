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

PROTOCOL_VERSION = 1

# The npm client uses these limits; stay compatible.
MAX_MESSAGE_CHARS = 1000
MAX_USERNAME_LENGTH = 20
MAX_ROOM_NAME_LENGTH = 20
MAX_UDP_PACKET_BYTES = 1100
MAX_FRAME_BYTES = 8 * 1024
MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

MESSAGE_TYPES = {
    "HELLO", "ANNOUNCE", "ROOM_LIST", "PEER_LIST",
    "JOIN", "LEAVE", "MESSAGE", "PING", "PONG",
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


def sanitize_address_list(value, max_addresses=8):
    """Keep well-formed IPv4 strings, drop everything else."""
    if not isinstance(value, list):
        return []
    kept = []
    for entry in value[: max_addresses * 2]:
        if isinstance(entry, str) and re.match(r"^(\d{1,3}\.){3}\d{1,3}$", entry):
            kept.append(entry)
        if len(kept) >= max_addresses:
            break
    return kept


def create_envelope(msg_type, sender_id, username, room=None, data=None, env_id=None, ts=None):
    """Build an envelope to send. Senders always use this helper."""
    return {
        "v": PROTOCOL_VERSION,
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


def parse_envelope(raw, clock_skew_check=True):
    """Validate an untrusted value into an envelope dict, or None."""
    if not isinstance(raw, dict):
        return None
    if raw.get("v") != PROTOCOL_VERSION:
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
        "v": PROTOCOL_VERSION,
        "id": env_id,
        "type": msg_type,
        "ts": ts,
        "from": sender,
        "username": _coerce_username(raw.get("username")),
        "room": room,
        "data": raw.get("data"),
    }


def parse_message_data(data):
    """Validate a MESSAGE payload; return the text or None."""
    if not isinstance(data, dict):
        return None
    text = data.get("text")
    if not isinstance(text, str):
        return None
    if len(text) > MAX_MESSAGE_CHARS * 4:
        return None
    cleaned = CONTROL_CHARS.sub("", ANSI_SEQUENCES.sub("", text)).strip()[:MAX_MESSAGE_CHARS]
    return cleaned or None


def parse_announce_data(data):
    """Validate an ANNOUNCE/HELLO payload: port, addresses, rooms."""
    if not isinstance(data, dict):
        return None
    port = data.get("port")
    if not is_valid_port(port):
        return None
    addresses = sanitize_address_list(data.get("addresses"))

    # Optional direct-reply port (Python clients): where a unicast beacon can
    # reach us reliably, immune to multicast outages. The npm client ignores
    # this extra field.
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


def encode_envelope(envelope):
    """Serialise one envelope as a TCP frame (JSON plus newline)."""
    return (json.dumps(envelope, separators=(",", ":")) + "\n").encode("utf-8")


def decode_frames(chunk, buffer=""):
    """Split received bytes into envelopes.

    TCP gives us arbitrary chunks; JSON envelopes are newline-delimited.
    Returns (envelopes, leftover_bytes_str). Invalid lines are dropped.
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
        envelope = parse_envelope(raw)
        if envelope is not None:
            envelopes.append(envelope)
    return envelopes, text
