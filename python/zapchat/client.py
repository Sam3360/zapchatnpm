"""The LAN chat client: a TCP mesh between discovered instances.

Wire-compatible with the npm client's protocol v1: newline-delimited JSON
envelopes over TCP, HELLO handshake, room-scoped MESSAGE frames with
duplicate suppression and a one-hop relay so a message still lands when two
peers are not directly connected to each other.
"""

import socket
import threading

from .protocol import (
    create_envelope,
    decode_frames,
    encode_action_message,
    encode_envelope,
    now_ms,
    parse_envelope,
    parse_message_data,
    sanitize_room_name,
)

MAX_PEERS = 64
DEDUP_CACHE_SIZE = 1024


class ChatClient:
    """Owns the listening TCP socket and every peer link."""

    def __init__(self, client_id, username, get_room, on_event=None):
        """`get_room` is read fresh for every HELLO (the room can change)."""
        self.client_id = client_id
        self.username = username
        self.get_room = get_room
        self.on_event = on_event or (lambda kind, **kwargs: None)

        self._server = None
        self._server_port = 0
        self._running = False
        self._lock = threading.RLock()

        # client_id -> {"socket": Socket, "username": str, "room": str|None}
        self._links = {}
        # message ids we have already seen (duplicate suppression)
        self._seen_ids = set()
        self._seen_order = []

    # ------------------------------------------------------------------ setup

    def start(self, port_base=45913, attempts=12):
        """Bind a listening socket, trying port_base and the next few ports.

        No SO_REUSEADDR: on Windows it would let two instances silently share
        the port and split incoming connections. A busy port just moves us to
        the next candidate, which is exactly what the npm client does.
        """
        import sys

        self._running = True
        for offset in range(attempts):
            try:
                self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                if sys.platform != "win32":
                    self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                self._server.bind(("0.0.0.0", port_base + offset))
                self._server.listen(16)
                self._server_port = port_base + offset
                break
            except OSError:
                self._server.close()
                self._server = None

        if self._server is None:
            # Ephemeral fallback so a fully busy range still works.
            self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._server.bind(("0.0.0.0", 0))
            self._server.listen(16)
            self._server_port = self._server.getsockname()[1]

        threading.Thread(target=self._accept_loop, daemon=True).start()
        return self._server_port

    def stop(self):
        self._running = False
        if self._server is not None:
            try:
                self._server.close()
            except OSError:
                pass
            self._server = None
        with self._lock:
            for link in list(self._links.values()):
                try:
                    link["socket"].close()
                except OSError:
                    pass
            self._links.clear()

    @property
    def port(self):
        return self._server_port

    @property
    def peer_ids(self):
        with self._lock:
            return list(self._links.keys())

    # ------------------------------------------------------------- connecting

    def connect_to(self, address, port, timeout=3.0):
        """Dial a peer and run the HELLO handshake. Returns True on success."""
        try:
            sock = socket.create_connection((address, port), timeout=timeout)
        except OSError as error:
            self.on_event("warning", text=f"could not connect to {address}:{port} ({error})")
            return False

        sock.settimeout(5.0)
        hello = self._build_hello()
        try:
            sock.sendall(encode_envelope(hello))
            reply = self._read_envelopes(sock)
        except OSError:
            sock.close()
            return False

        peer_envelope = next((e for e in reply if e["type"] == "HELLO"), None)
        if peer_envelope is None or peer_envelope["from"] == self.client_id:
            sock.close()
            return False

        with self._lock:
            if peer_envelope["from"] in self._links or len(self._links) >= MAX_PEERS:
                sock.close()
                return False

            self._links[peer_envelope["from"]] = {
                "socket": sock,
                "username": peer_envelope["username"],
                "room": peer_envelope["room"],
            }

        # The handshake timeout must not linger: an idle chat link is healthy,
        # and a leftover recv timeout would drop it every few seconds.
        sock.settimeout(None)

        threading.Thread(target=self._serve_link, args=(sock, peer_envelope["from"]), daemon=True).start()
        self.on_event("peer-connected", client_id=peer_envelope["from"], username=peer_envelope["username"])
        return True

    def connect_to_peer_object(self, peer):
        """Dial a discovery.Peer, trying its advertised addresses in turn."""
        candidates = list(peer.addresses)
        source = getattr(peer, "_source", None)
        if source and source not in candidates:
            candidates.append(source)
        for address in candidates:
            if self.connect_to(address, peer.port):
                return True
        return False

    # ---------------------------------------------------------------- sending

    def send_chat(self, text):
        """Send a message to every connected peer in the same room."""
        room = self.get_room()
        envelope = create_envelope("MESSAGE", self.client_id, self.username, room=room, data={"text": text})
        sent = self._broadcast(envelope, room)
        self.on_event("message-sent", envelope=envelope, peers=sent)
        return sent

    def send_action(self, text):
        """Send an action (`/me waves`) to every connected peer in the room."""
        framed = encode_action_message(text)
        if framed is None:
            return 0
        room = self.get_room()
        envelope = create_envelope("MESSAGE", self.client_id, self.username, room=room, data={"text": framed})
        sent = self._broadcast(envelope, room)
        self.on_event("message-sent", envelope=envelope, peers=sent)
        return sent

    def send_heartbeat(self):
        self._broadcast(create_envelope("PING", self.client_id, self.username), None)

    # ------------------------------------------------------------- internals

    def _build_hello(self):
        return create_envelope(
            "HELLO",
            self.client_id,
            self.username,
            room=self.get_room(),
            data={"port": self._server_port, "addresses": []},
        )

    def _read_envelopes(self, sock, initial=""):
        """Read from the socket until a newline-delimited envelope arrives."""
        buffer = initial
        envelopes = []
        try:
            while not envelopes:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                envelopes, buffer = decode_frames(chunk, buffer)
        except OSError:
            pass
        return envelopes

    def _accept_loop(self):
        while self._running:
            try:
                sock, address = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve_inbound, args=(sock, address), daemon=True).start()

    def _serve_inbound(self, sock, address):
        sock.settimeout(5.0)
        try:
            envelopes = self._read_envelopes(sock)
        except OSError:
            sock.close()
            return

        hello = next((e for e in envelopes if e["type"] == "HELLO"), None)
        if hello is None or hello["from"] == self.client_id:
            sock.close()
            return

        with self._lock:
            if hello["from"] in self._links or len(self._links) >= MAX_PEERS:
                sock.close()
                return
            self._links[hello["from"]] = {
                "socket": sock,
                "username": hello["username"],
                "room": hello["room"],
            }

        # Reply with our own HELLO so both ends are identified.
        try:
            sock.sendall(encode_envelope(self._build_hello()))
        except OSError:
            self._drop_link(hello["from"])
            return

        sock.settimeout(None)
        self.on_event("peer-connected", client_id=hello["from"], username=hello["username"])
        self._serve_link(sock, hello["from"])

    def _serve_link(self, sock, client_id):
        buffer = ""
        while self._running:
            try:
                chunk = sock.recv(8192)
            except (OSError, TimeoutError):
                break
            if not chunk:
                break
            envelopes, buffer = decode_frames(chunk, buffer)
            for envelope in envelopes:
                self._handle(envelope, client_id)

        self._drop_link(client_id)

    def _handle(self, envelope, client_id):
        if envelope["id"] in self._seen_ids:
            return
        self._remember_id(envelope["id"])

        msg_type = envelope["type"]
        if msg_type == "PONG":
            return
        if msg_type == "PING":
            self._send_to(client_id, create_envelope("PONG", self.client_id, self.username))
            return
        if msg_type == "HELLO":
            with self._lock:
                link = self._links.get(client_id)
                if link is not None:
                    link["username"] = envelope["username"]
                    link["room"] = envelope["room"]
            return

        if msg_type == "MESSAGE":
            # parse_message_data strips hostile control/ANSI bytes and keeps
            # CTCP action framing intact (it re-sanitises only the body).
            text = parse_message_data(envelope["data"]) if isinstance(envelope["data"], dict) else None
            if text:
                self.on_event(
                    "message",
                    sender=envelope["username"],
                    text=text,
                    room=envelope["room"],
                    client_id=envelope["from"],
                    ts=envelope["ts"],
                )
            # One-hop relay: forward to same-room peers that have not seen it.
            self._relay(envelope, from_client=client_id)
        elif msg_type in ("JOIN", "LEAVE", "ANNOUNCE"):
            self.on_event("presence", envelope=envelope)

    def _remember_id(self, message_id):
        self._seen_ids.add(message_id)
        self._seen_order.append(message_id)
        if len(self._seen_order) > DEDUP_CACHE_SIZE:
            for old in self._seen_order[:-DEDUP_CACHE_SIZE]:
                self._seen_ids.discard(old)
            del self._seen_order[:-DEDUP_CACHE_SIZE]

    def _relay(self, envelope, from_client):
        """Forward a room-scoped frame to other same-room peers (once)."""
        self._broadcast(envelope, envelope["room"], skip_client=from_client)

    def _broadcast(self, envelope, room, skip_client=None):
        """Send to every peer in `room` (all peers when room is None)."""
        sent = 0
        with self._lock:
            targets = [
                (cid, link["socket"])
                for cid, link in self._links.items()
                if cid != skip_client and (room is None or link["room"] == room)
            ]
        for client_id, sock in targets:
            if self._send_to(client_id, envelope, sock=sock):
                sent += 1
        return sent

    def _send_to(self, client_id, envelope, sock=None):
        with self._lock:
            link = self._links.get(client_id)
            sock = sock or (link["socket"] if link else None)
        if sock is None:
            return False
        try:
            sock.sendall(encode_envelope(envelope))
            return True
        except OSError:
            self._drop_link(client_id)
            return False

    def _drop_link(self, client_id):
        with self._lock:
            link = self._links.pop(client_id, None)
        if link is not None:
            try:
                link["socket"].close()
            except OSError:
                pass
            self.on_event("peer-gone", client_id=client_id, username=link["username"])
