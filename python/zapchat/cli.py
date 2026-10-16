"""Command line entry point: `zapchat` starts a terminal chat session.

The chat loop is deliberately simple line-based I/O so it works everywhere
(Windows cmd, PowerShell, ssh, tmux): what you type is sent, what others say
is printed. Type /help to see the commands.
"""

import argparse
import base64
import os
import re
import sys
import threading
import time
import uuid

from .client import ChatClient
from .discovery import DiscoveryService, DISCOVERY_PORT
from .history import HISTORY_LIMIT, HistoryStore
from .identity import PeerPinStore, identity_key_id, new_identity_seed
from .protocol import (
    MAX_USERNAME_LENGTH,
    MIN_ID_PREFIX_CHARS,
    REACTION_SET,
    is_action_message,
    is_valid_host,
    render_action,
    sanitize_room_name,
    sanitize_username,
    split_host_port,
)
from .transfers import format_bytes as _format_bytes
from . import __version__

CONFIG_DIR_ENV = "ZAPCHAT_CONFIG_DIR"
DEFAULT_ROOM = "general"

# Message ids are url-safe, so an id (or prefix) is only these characters.
_REF_RE = re.compile(r"[A-Za-z0-9_-]+")


def default_username():
    """OS account name when it is usable, otherwise a random handle."""
    try:
        account = os.getlogin()
    except OSError:
        account = os.environ.get("USERNAME") or os.environ.get("USER") or ""
    username = sanitize_username(account)
    if username:
        return username
    return "zapper-" + uuid.uuid4().hex[:4]


def config_path():
    """Path of the tiny local config file (username + client id)."""
    override = os.environ.get(CONFIG_DIR_ENV)
    if override:
        directory = override
    elif sys.platform == "win32":
        directory = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "zapchat")
    elif sys.platform == "darwin":
        directory = os.path.join(os.path.expanduser("~"), "Library", "Application Support", "zapchat")
    else:
        directory = os.path.join(
            os.environ.get("XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")),
            "zapchat",
        )
    return os.path.join(directory, "config.json")


def _valid_identity_seed(value):
    """True when `value` is a usable base64 Ed25519 seed (32 bytes)."""
    if not isinstance(value, str) or not value or len(value) > 64:
        return False
    try:
        return len(base64.b64decode(value, validate=True)) == 32
    except (ValueError, TypeError):
        return False


def load_or_create_config(name_override=None):
    """Read the config file, creating it when missing. Never fatal.

    Since v6 the config also carries the long-term identity seed (our TOFU
    identity, base64) and the peer pin map. Missing or corrupt entries are
    regenerated, never fatal — matching the npm client's repair behaviour.
    """
    import json

    path = config_path()
    config = {
        "clientId": "zpy-" + uuid.uuid4().hex,
        "username": "",
        "lastRoom": DEFAULT_ROOM,
        "identitySeed": base64.b64encode(new_identity_seed()).decode("ascii"),
        "peerPins": {},
    }

    try:
        with open(path, "r", encoding="utf-8") as handle:
            stored = json.load(handle)
        if isinstance(stored, dict):
            if isinstance(stored.get("clientId"), str) and stored["clientId"]:
                config["clientId"] = stored["clientId"]
            if isinstance(stored.get("username"), str):
                config["username"] = stored["username"]
            if isinstance(stored.get("lastRoom"), str):
                config["lastRoom"] = stored["lastRoom"]
            if _valid_identity_seed(stored.get("identitySeed")):
                config["identitySeed"] = stored["identitySeed"]
            if isinstance(stored.get("peerPins"), dict):
                config["peerPins"] = stored["peerPins"]
    except (OSError, ValueError):
        pass

    if name_override:
        config["username"] = name_override

    if not sanitize_username(config["username"]):
        config["username"] = default_username()

    save_config(config, path)
    return config, path


def save_config(config, path):
    """Write the config back out. Best-effort, never fatal."""
    import json

    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
    except OSError:
        pass


def _valid_ref(value):
    """True when `value` looks like a message id or a prefix of one."""
    return bool(value) and len(value) >= MIN_ID_PREFIX_CHARS and _REF_RE.fullmatch(value) is not None


class ChatApp:
    """Wires discovery + the TCP client together and runs the chat loop."""

    def __init__(
        self,
        username,
        room,
        client_id,
        no_discovery=False,
        connect_to=None,
        tcp_port=45913,
        identity_seed=None,
        allow_plaintext=False,
        pin_seed=None,
        save_pins=None,
        history_store=None,
    ):
        self.username = username
        self.room = room
        self.client_id = client_id
        self.no_discovery = no_discovery
        self.connect_to = connect_to
        self.tcp_port = tcp_port

        self.history = []  # rendered lines kept for /help-style local commands
        # Durable chat history (v8.1): chat lines only, one file per room.
        # None when --no-history was passed.
        self._history = history_store
        self._restored_keys = set()  # "<id>" keys restored from disk
        # (id, room, who, preview) for recent messages, oldest first — this is
        # how users discover the ids /reply and /react take (npm parity: ids
        # are never rendered inline).
        self._recent = []
        self.lock = threading.Lock()
        self.connected_usernames = set()

        # TOFU pinning: refuse a peer whose identity key changed for a client
        # id we have talked to before (an impostor, or a rebuilt install).
        self.pin_store = PeerPinStore()
        self.pin_store.seed(pin_seed)
        self._save_pins = save_pins or (lambda pins: None)

        self.chat = ChatClient(
            client_id,
            username,
            get_room=lambda: self.room,
            on_event=self._on_event,
            identity_seed=identity_seed,
            allow_plaintext=allow_plaintext,
            check_peer_pin=self._check_peer_pin,
        )

        self.discovery = None
        if not no_discovery:
            self.discovery = DiscoveryService(
                client_id,
                username,
                room,
                tcp_port=0,  # set after the TCP port is bound
                on_warning=lambda message: self._print(f"! {message}"),
            )

    # ------------------------------------------------------------------ events

    def _check_peer_pin(self, client_id, identity_key_id):
        """TOFU verdict callback; persists new/refreshed pins immediately."""
        verdict = self.pin_store.check(client_id, identity_key_id)
        if verdict != "mismatch":
            self._save_pins(self.pin_store.to_config())
        return verdict

    def _remember(
        self, message_id, room, who, text, raw=False
    ):
        """Keep a recent message so `/ids` can name targets for /reply//react.

        `raw=True` means `text` is already a rendered preview (restored
        history): skip re-rendering, which would mangle stored action lines.
        """
        if not message_id:
            return
        if raw:
            preview = text
        else:
            preview = render_action(who, text) if is_action_message(text) else text
        preview = " ".join(str(preview).split())[:80]
        self._recent.append((message_id, room, who, preview))
        if len(self._recent) > 200:
            del self._recent[:-200]

    def _reset_recent(self, room):
        """Drop /ids entries for a room (`/clear`); ids of a cleared room
        would only reply into a timeline neither side can see."""
        self._recent = [entry for entry in self._recent if entry[1] != room]

    def _persist(self, message_id, room, who, text, ts, self_sent):
        """Store one chat line durably (v8.1). Rendered like it was shown,
        matching npm: a `/me` action is stored as `* sam waves`."""
        if self._history is None:
            return
        rendered = render_action(who, text) if is_action_message(text) else text
        self._history.append(
            {
                "id": message_id or "",
                "room": room or self.room or "",
                "kind": "chat",
                "text": rendered,
                "username": who,
                "ts": ts,
                "self": self_sent,
            }
        )

    def _on_event(self, kind, **kwargs):
        if kind == "message":
            stamp = self._stamp(kwargs.get("ts"))
            text = kwargs["text"]
            if is_action_message(text):
                # `/me waves` arrives framed; render it as `* sam waves`.
                self._print(f"{stamp} {render_action(kwargs['sender'], text)}")
            else:
                self._print(f"{stamp} {kwargs['sender']}: {text}")
            self._remember(kwargs.get("message_id"), kwargs.get("room"), kwargs["sender"], text)
            self._persist(
                kwargs.get("message_id"), kwargs.get("room"), kwargs["sender"], text, kwargs.get("ts"), False
            )
        elif kind == "message-sent":
            # Local echo: you always see your own line, peers or not (v7
            # printed nothing here, so a sent message seemed to vanish).
            envelope = kwargs.get("envelope") or {}
            stamp = self._stamp(envelope.get("ts"))
            text = (envelope.get("data") or {}).get("text") or ""
            sender = envelope.get("username") or self.username
            if is_action_message(text):
                self._print(f"{stamp} {render_action(sender, text)}")
            else:
                self._print(f"{stamp} {sender}: {text}")
            queued = kwargs.get("queued")
            if queued is True:
                self._print(
                    "! no peers are connected yet — your message is queued "
                    "and will send when one joins"
                )
            elif queued is False:
                self._print(
                    "! no peers are connected yet — the offline queue was full, "
                    "so the oldest queued message was dropped"
                )
            self._remember(envelope.get("id"), envelope.get("room"), sender, text)
            self._persist(
                envelope.get("id"),
                envelope.get("room"),
                sender,
                text,
                envelope.get("ts"),
                True,
            )
        elif kind == "presence":
            envelope = kwargs.get("envelope") or {}
            who = envelope.get("username", "a peer")
            where = envelope.get("room") or self.room
            if kwargs.get("action") == "LEAVE":
                self._print(f"* {who} left #{where}")
            else:
                self._print(f"* {who} joined #{where}")
        elif kind == "offline-flushed":
            count = kwargs.get("count", 0)
            self._print(
                f"* sent {count} queued {'message' if count == 1 else 'messages'} "
                "now that a peer is here"
            )
        elif kind == "peer-connected":
            self._print(f"* {kwargs['username']} connected")
        elif kind == "peer-gone":
            self._print(f"* {kwargs['username']} left")
        elif kind == "warning":
            self._print(f"! {kwargs['text']}")
        elif kind == "reply":
            self._print(
                f"{self._stamp(kwargs.get('ts'))} {kwargs['sender']} "
                f"↪ {kwargs['reply_to']}: {kwargs['text']}"
            )
            self._remember(
                kwargs.get("message_id"), kwargs.get("room"), kwargs["sender"], kwargs["text"]
            )
        elif kind == "reaction":
            self._print(f"* {kwargs['sender']} reacted {kwargs['reaction']} to {kwargs['target']}")
            self._remember(
                kwargs.get("message_id"),
                kwargs.get("room"),
                kwargs["sender"],
                f"{kwargs['reaction']} reacted",
            )
        elif kind == "reply-sent":
            self._print(f"* replied to {kwargs['reply_to']}")
            self._remember(
                kwargs.get("message_id"), kwargs.get("room"), self.username, kwargs["text"]
            )
        elif kind == "reaction-sent":
            self._print(f"* reacted {kwargs['reaction']} to {kwargs['target']}")
            self._remember(
                kwargs.get("message_id"),
                kwargs.get("room"),
                self.username,
                f"{kwargs['reaction']} reacted",
            )
        elif kind == "file-offer-out":
            self._print(
                f"* offering {kwargs['name']} ({_format_bytes(kwargs['size'])}) "
                f"— waiting for someone to accept"
            )
        elif kind == "file-receiving":
            self._print(
                f"* {kwargs['sender']} offers {kwargs['name']} "
                f"({_format_bytes(kwargs['size'])}) — receiving…"
            )
        elif kind == "file-progress":
            # Percentages would flood a line-based terminal; only milestones print.
            percent = int(kwargs["received"] * 100 / max(kwargs["size"], 1))
            if percent % 25 == 0:
                self._print(f"  … {kwargs['name']} {percent}%")
        elif kind == "file-sent":
            accepted = kwargs["accepted"]
            total = kwargs["total"]
            if accepted == 0:
                self._print(f"! nobody accepted {kwargs['name']}")
            else:
                self._print(
                    f"* sent {kwargs['name']} to {accepted} of {total} "
                    f"{'peer' if total == 1 else 'peers'}"
                )
        elif kind == "file-received":
            self._print(
                f"* received {kwargs['name']} ({_format_bytes(kwargs['size'])}) "
                f"from {kwargs['sender']} → {kwargs['target']}"
            )
        elif kind == "file-cancelled-out":
            self._print(f"* cancelled sending {kwargs['name']}")
        elif kind == "file-error":
            self._print(f"! {kwargs['text']}")

    @staticmethod
    def _stamp(ts):
        seconds = (ts / 1000) if isinstance(ts, (int, float)) and ts > 10_000_000_000 else time.time()
        return time.strftime("%H:%M", time.localtime(seconds))

    def _print(self, line):
        with self.lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    # ------------------------------------------------------------------- start

    def start(self):
        port = self.chat.start(port_base=self.tcp_port)
        if self.discovery is not None:
            self.discovery.tcp_port = port
            self.discovery.start()
            self.discovery.set_state(self.username, self.room, port)

        self._print(f"zapchat {__version__} — LAN chat, no accounts, no server")
        self._print(f"  you are {self.username} on #{self.room} (tcp:{port})")
        if self.no_discovery:
            self._print("  discovery off; use /connect <ip> to reach a peer")
        else:
            self._print("  waiting for people on this network... (ctrl+c to quit, /help)")

        self._restore_history()

        if self.connect_to:
            address, port_text = split_host_port(self.connect_to)
            self.chat.connect_to(address, int(port_text) if port_text else 45913)

        threading.Thread(target=self._dial_loop, daemon=True).start()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()

    def _restore_history(self):
        """Replay persisted chat lines from previous sessions (v8.1).

        Python's display is not room-filtered (it shows any room's traffic
        the moment it arrives), so the restore replays all rooms, oldest
        first. System notices were never persisted. Restored lines feed
        /ids too, so you can /reply to something said before the restart.
        """
        if self._history is None:
            return
        restored = []
        for room in sorted(self._history.rooms()):
            restored.extend(self._history.load(room))
        if not restored:
            return
        restored.sort(key=lambda message: message.get("ts") or 0)
        count = len(restored)
        self._print(
            f"* {count} chat {'message' if count == 1 else 'messages'} "
            "restored from history — context from the previous session"
        )
        for message in restored:
            text = message.get("text") or ""
            self._print(f"{self._stamp(message.get('ts'))} {text}")
            message_id = message.get("id")
            if not message_id or message_id in self._restored_keys:
                continue
            self._restored_keys.add(message_id)
            self._remember(
                message_id,
                message.get("room"),
                message.get("username") or "?",
                text,
                raw=True,
            )

    def _heartbeat_loop(self):
        """PING every peer periodically so half-open links get reaped."""
        while self.chat._running:
            time.sleep(5.0)
            try:
                self.chat.send_heartbeat()
            except Exception:  # never let the heartbeat die
                pass

    def _dial_loop(self):
        """Connect to discovered peers we are not already linked to.

        Only the instance with the lexicographically smaller client id dials,
        so two instances never dial each other at the same moment and the
        link never gets duplicated (same rule as the npm client).
        """
        while self.chat._running:
            if self.discovery is not None:
                for peer in self.discovery.live_peers():
                    should_dial = (
                        peer.client_id not in self.chat.peer_ids
                        and peer.client_id < self.client_id
                    )
                    if should_dial:
                        peer._source = self.discovery._beacon_sources.get(peer.client_id)
                        self.chat.connect_to_peer_object(peer)
            time.sleep(1.0)

    def stop(self):
        if self.discovery is not None:
            self.discovery.stop()
        self.chat.stop()

    # -------------------------------------------------------------- chat loop

    def handle_line(self, line):
        """Process one input line: a /command or chat to send."""
        if line.startswith("/"):
            self.run_command(line)
            return

        # Always send: when nobody is reachable the client queues the message
        # (and echoes it locally), instead of swallowing what the user typed.
        self.chat.send_chat(line)

    def _find_peer(self, ref):
        """Resolve a username (or client id) to a connected client id."""
        wanted = ref.lstrip("@").strip().lower()
        for client_id, username in self.chat.peer_name_map().items():
            if username.lower() == wanted or client_id.lower() == wanted:
                return client_id
        return None

    def run_command(self, line):
        parts = line[1:].split(maxsplit=1)
        command = parts[0].lower() if parts else ""
        argument = parts[1].strip() if len(parts) > 1 else ""

        if command in ("help", "h", "?"):
            self._print(
            "commands: /rooms /users /me <action> /join <room> /name <username> "
            "/connect <ip[:port]> /reply <id> <text> /react <id> <emoji> "
            "/ids /file <path> /file cancel [id] /identity /fingerprint <user> "
            "/trust <user> /untrust <user> /clear /status /quit"
            )
        elif command == "rooms":
            rooms = self.discovery.live_rooms() if self.discovery else {}
            if self.room:
                rooms.setdefault(self.room, {"online": 1, "seen": 0})
            for name, info in sorted(rooms.items()):
                self._print(f"  #{name}  {info['online']} online")
            if not rooms:
                self._print("  no rooms discovered yet")
        elif command in ("users", "who"):
            if self.discovery is not None:
                for peer in self.discovery.live_peers():
                    room = f"  #{peer.room}" if peer.room else ""
                    self._print(f"  {peer.username}{room}")
            names = self.chat.peer_name_map()
            rooms = self.chat.peer_rooms()
            for client_id in self.chat.peer_ids:
                name = names.get(client_id, "?")
                where = f" #{rooms[client_id]}" if rooms.get(client_id) else ""
                self._print(f"  {name}{where} (connected)")
        elif command == "join":
            room = sanitize_room_name(argument)
            if not room:
                self._print("! usage: /join <room>")
                return
            self.room = room
            if self.discovery is not None:
                self.discovery.set_state(self.username, room, self.chat.port)
            # Tell every live peer our room changed: their broadcast filter is
            # keyed off our last HELLO/JOIN frame, and without this every
            # later message in the new room black-holed on their side.
            self.chat.announce_identity()
            self._print(f"* joined #{room}")
        elif command == "name":
            name = sanitize_username(argument)
            if not name:
                self._print("! usage: /name <username>")
                return
            self.username = name
            # The wire client stamps its own username on every envelope (and
            # HELLO), so it must be updated too — otherwise /name changes the
            # local prompt only and peers keep seeing the old name.
            self.chat.username = name
            if self.discovery is not None:
                self.discovery.set_state(name, self.room, self.chat.port)
            self.chat.announce_identity()
            self._print(f"* you are now {name}")
        elif command == "connect":
            address, port_text = split_host_port(argument)
            if not address or not is_valid_host(address):
                self._print("! usage: /connect <host[:port]>  ·  IPv6 as [::1]:45913")
                return
            try:
                port = int(port_text) if port_text else 45913
            except ValueError:
                self._print("! the port must be a number, e.g. /connect 192.168.1.24:45913")
                return
            if not 1 <= port <= 65535:
                self._print("! the port must be between 1 and 65535")
                return
            threading.Thread(
                target=self.chat.connect_to,
                args=(address, port),
                daemon=True,
            ).start()
        elif command == "me":
            if not argument:
                self._print("! usage: /me <action>")
                return
            # The message-sent event echoes locally (and queues when nobody
            # is reachable), so there is no manual print here — it would
            # double up on the echo.
            self.chat.send_action(argument)
        elif command == "reply":
            target, _, body = argument.partition(" ")
            body = body.strip()
            if not _valid_ref(target) or not body:
                self._print("! usage: /reply <id|prefix> <text>")
                return
            if self.chat.send_reply(target, body) is None:
                self._print("! that reply could not be sent (invalid id or text)")
        elif command == "react":
            target, _, emoji = argument.partition(" ")
            emoji = emoji.strip()
            if not _valid_ref(target) or emoji not in REACTION_SET:
                self._print(
                    f"! usage: /react <id|prefix> <{'|'.join(REACTION_SET[:4])}|...>"
                )
                return
            if self.chat.send_reaction(target, emoji) is None:
                self._print("! that reaction could not be sent (invalid id or emoji)")
        elif command == "file":
            # `/file cancel [id]` aborts active transfers (all of them without an id).
            parts = argument.split()
            if not parts:
                self._print("! usage: /file <file-path>  ·  /file cancel [id]")
                return
            if parts[0] == "cancel":
                ok, error = self.chat.cancel_transfer(parts[1] if len(parts) > 1 else None)
            else:
                ok, error = self.chat.offer_file(argument)
            if not ok:
                self._print(f"! {error}")
        elif command == "identity":
            self._print(f"  your identity fingerprint: {identity_key_id(self.chat.identity_seed)}")
            self._print("  share it with a peer (or run /fingerprint on their side) to verify the link")
        elif command == "fingerprint":
            if not argument:
                self._print("! usage: /fingerprint <username>")
                return
            client_id = self._find_peer(argument)
            if client_id is None:
                self._print(f'! no peer named "{argument}"')
                return
            key_id = self.chat.peer_fingerprint(client_id)
            if key_id is None:
                username = self.chat.peer_name_map().get(client_id, argument)
                self._print(f"! {username} has not completed a handshake yet — no key to show")
                return
            username = self.chat.peer_name_map().get(client_id, argument)
            self._print(f"  {username}  {client_id}")
            self._print(f"    key {key_id}")
        elif command in ("trust", "untrust"):
            if not argument:
                self._print(f"! usage: /{command} <username>")
                return
            client_id = self._find_peer(argument)
            if client_id is None:
                self._print(f'! no peer named "{argument}"')
                return
            username = self.chat.peer_name_map().get(client_id, argument)
            if command == "trust":
                key_id = self.chat.peer_fingerprint(client_id)
                if key_id is None:
                    self._print(f"! {username} has not completed a handshake yet — no key to trust")
                    return
                self.pin_store.trust(client_id, key_id)
                self._save_pins(self.pin_store.to_config())
                self._print(f"  pinned {username}'s current key")
            else:
                if not self.pin_store.untrust(client_id):
                    self._print(f"! {username} had no pinned key")
                    return
                self._save_pins(self.pin_store.to_config())
                self._print(f"  forgot {username}'s pinned key")
        elif command == "ids":
            # Ids are never rendered inline; this is where /reply and /react
            # targets come from (same workflow as the npm TUI).
            entries = [entry for entry in self._recent if entry[1] == self.room]
            if not entries:
                self._print(
                    f"  no messages in #{self.room} yet — ids will list here "
                    "for /reply and /react"
                )
                return
            for message_id, _room, who, preview in reversed(entries[-20:]):
                self._print(f"  {message_id}  {who}: {preview}")
        elif command == "status":
            self._print(f"  you: {self.username} in #{self.room}")
            discovery = self.discovery
            if discovery is None:
                self._print("  discovery: off")
            else:
                self._print(
                    f"  discovery: {'multicast' if discovery.multicast_ok else 'broadcast'}"
                    f" on udp:{DISCOVERY_PORT}, {discovery.beacons_sent} sent,"
                    f" {discovery.beacons_received} received"
                )
            self._print(f"  tcp port: {self.chat.port}, peers: {len(self.chat.peer_ids)}")
            modes = self.chat.link_modes()
            unencrypted = [cid for cid, mode in modes.items() if mode != "secure"]
            if unencrypted:
                self._print(f"  WARNING: {len(unencrypted)} link(s) without encryption")
            queued = self.chat.offline_count()
            if queued:
                self._print(f"  queued: {queued} message{'s' if queued != 1 else ''} waiting for a peer")
            self._print(f"  identity: {self.chat.identity_fingerprint()}")
        elif command == "clear":
            # Wipe the screen AND the persisted copy of this room's history,
            # or the next restart would resurrect lines the user deleted.
            with self.lock:
                sys.stdout.write("\x1b[2J\x1b[H")
                sys.stdout.flush()
            self._reset_recent(self.room)
            if self._history is not None:
                self._history.clear_room(self.room)
                self._print(f"* cleared #{self.room} (history wiped too)")
            else:
                self._print(f"* cleared #{self.room}")
        elif command in ("quit", "q", "exit"):
            raise KeyboardInterrupt
        else:
            self._print(f"! unknown command /{command}; try /help")


def main(argv=None):
    # Windows consoles default to a legacy code page (cp1252); printing a
    # status arrow from a reader thread then raises UnicodeEncodeError and
    # kills that thread, silently blackholing every later frame. Force UTF-8
    # with lossy replacement instead: ugly output never beats a dead link.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass
    parser = argparse.ArgumentParser(
        prog="zapchat",
        description="Terminal-native LAN chat. No accounts, no cloud, no servers.",
    )
    parser.add_argument("-n", "--name", help="display name (remembered between runs)")
    parser.add_argument("-r", "--room", help="room to join on start")
    parser.add_argument("-c", "--connect", metavar="HOST[:PORT]", help="connect straight to a peer")
    parser.add_argument("--discovery-port", type=int, default=DISCOVERY_PORT, help="UDP discovery port")
    parser.add_argument("--tcp-port", type=int, default=45913, help="first TCP port to try")
    parser.add_argument("--no-discovery", action="store_true", help="manual connections only")
    parser.add_argument(
        "--allow-plaintext",
        action="store_true",
        help="accept and dial unencrypted legacy (v1) peer links",
    )
    parser.add_argument(
        "--no-history",
        action="store_true",
        help="do not persist or restore chat history (chat lines live only in the session)",
    )
    parser.add_argument("-v", "--version", action="version", version=f"zapchat {__version__}")
    args = parser.parse_args(argv)

    config, config_path_used = load_or_create_config(name_override=args.name)
    room = sanitize_room_name(args.room) if args.room else None
    if room is None and args.room:
        parser.error("room names may only contain letters, digits, - and _")
    if room is None:
        room = sanitize_room_name(config.get("lastRoom")) or DEFAULT_ROOM

    app = ChatApp(
        username=config["username"],
        room=room,
        client_id=config["clientId"],
        no_discovery=args.no_discovery,
        connect_to=args.connect,
        tcp_port=args.tcp_port,
        identity_seed=base64.b64decode(config["identitySeed"]),
        allow_plaintext=args.allow_plaintext,
        pin_seed=config["peerPins"],
        save_pins=lambda pins: save_config({**config, "peerPins": pins}, config_path_used),
        history_store=None
        if args.no_history
        else HistoryStore(os.path.dirname(config_path_used), HISTORY_LIMIT),
    )

    app.start()

    # Tab completion wherever readline exists (POSIX; optional on Windows).
    try:
        import readline
    except ImportError:
        readline = None

    if readline is not None:
        from .completion import TabCompleter

        def _completion_candidates():
            rooms = list(app.discovery.live_rooms().keys()) if app.discovery else []
            if app.room and app.room not in rooms:
                rooms.append(app.room)
            return {"members": app.chat.peer_usernames(), "rooms": rooms}

        completer = TabCompleter(_completion_candidates)
        readline.set_completer(completer.complete)
        # Only whitespace separates words: "/", "@" and "#" stay part of the
        # word so the completer can see (and preserve) them.
        readline.set_completer_delims(" \t\n")
        readline.parse_and_bind("tab: complete")

    # Standard input is line-buffered; ctrl+c raises KeyboardInterrupt.
    # input() (not `for line in sys.stdin`) is what activates the readline
    # hook above in interactive terminals; non-interactive stdin (pipes,
    # tests) behaves exactly as before.
    try:
        while True:
            try:
                line = input()
            except EOFError:
                break
            line = line.strip()
            if line:
                try:
                    app.handle_line(line)
                except KeyboardInterrupt:
                    break
    except KeyboardInterrupt:
        pass

    app.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
