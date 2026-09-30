"""Command line entry point: `zapchat` starts a terminal chat session.

The chat loop is deliberately simple line-based I/O so it works everywhere
(Windows cmd, PowerShell, ssh, tmux): what you type is sent, what others say
is printed. Type /help to see the commands.
"""

import argparse
import base64
import os
import sys
import threading
import time
import uuid

from .client import ChatClient
from .discovery import DiscoveryService, DISCOVERY_PORT
from .identity import PeerPinStore, identity_key_id, new_identity_seed
from .protocol import (
    MAX_USERNAME_LENGTH,
    is_action_message,
    render_action,
    sanitize_room_name,
    sanitize_username,
)
from . import __version__

CONFIG_DIR_ENV = "ZAPCHAT_CONFIG_DIR"
DEFAULT_ROOM = "general"


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
    ):
        self.username = username
        self.room = room
        self.client_id = client_id
        self.no_discovery = no_discovery
        self.connect_to = connect_to
        self.tcp_port = tcp_port

        self.history = []  # rendered lines kept for /help-style local commands
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

    def _on_event(self, kind, **kwargs):
        if kind == "message":
            # Envelope timestamps are in milliseconds; localtime wants seconds.
            ts = kwargs.get("ts")
            seconds = (ts / 1000) if isinstance(ts, (int, float)) and ts > 10_000_000_000 else time.time()
            stamp = time.strftime("%H:%M", time.localtime(seconds))
            text = kwargs["text"]
            if is_action_message(text):
                # `/me waves` arrives framed; render it as `* sam waves`.
                self._print(f"{stamp} {render_action(kwargs['sender'], text)}")
            else:
                self._print(f"{stamp} {kwargs['sender']}: {text}")
        elif kind == "peer-connected":
            self._print(f"* {kwargs['username']} connected")
        elif kind == "peer-gone":
            self._print(f"* {kwargs['username']} left")
        elif kind == "warning":
            self._print(f"! {kwargs['text']}")

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

        if self.connect_to:
            address, _, port_text = self.connect_to.partition(":")
            self.chat.connect_to(address, int(port_text or 45913))

        threading.Thread(target=self._dial_loop, daemon=True).start()
        threading.Thread(target=self._heartbeat_loop, daemon=True).start()

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

        if not self.chat.peer_ids:
            self._print("! nobody is connected yet; waiting for the network...")
            return
        self.chat.send_chat(line)

    def run_command(self, line):
        parts = line[1:].split(maxsplit=1)
        command = parts[0].lower() if parts else ""
        argument = parts[1].strip() if len(parts) > 1 else ""

        if command in ("help", "h", "?"):
            self._print(
                "commands: /rooms /users /me <action> /join <room> /name <username> "
                "/connect <ip[:port]> /status /quit"
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
            for client_id in self.chat.peer_ids:
                self._print(f"  {client_id} (connected)")
        elif command == "join":
            room = sanitize_room_name(argument)
            if not room:
                self._print("! usage: /join <room>")
                return
            self.room = room
            if self.discovery is not None:
                self.discovery.set_state(self.username, room, self.chat.port)
            self._print(f"* joined #{room}")
        elif command == "name":
            name = sanitize_username(argument)
            if not name:
                self._print("! usage: /name <username>")
                return
            self.username = name
            if self.discovery is not None:
                self.discovery.set_state(name, self.room, self.chat.port)
            self._print(f"* you are now {name}")
        elif command == "connect":
            address, _, port_text = argument.partition(":")
            if not address:
                self._print("! usage: /connect <ip[:port]>")
                return
            threading.Thread(
                target=self.chat.connect_to,
                args=(address, int(port_text or 45913)),
                daemon=True,
            ).start()
        elif command == "me":
            if not argument:
                self._print("! usage: /me <action>")
                return
            if not self.chat.peer_ids:
                self._print("! nobody is connected yet; waiting for the network...")
                return
            self.chat.send_action(argument)
            self._print(f"* {self.username} {argument.strip()}")
        elif command == "status":
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
        elif command in ("quit", "q", "exit"):
            raise KeyboardInterrupt
        else:
            self._print(f"! unknown command /{command}; try /help")


def main(argv=None):
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
