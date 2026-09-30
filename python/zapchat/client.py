"""The LAN chat client: a TCP mesh between discovered instances.

Wire-compatible with the npm client. Since v6 the native wire protocol is v2
(encrypted TCP mesh: ephemeral X25519 key exchange, Ed25519-signed handshakes,
AES-256-GCM frames — see `crypto.py` / `secure_framing.py`). Protocol v1
(plaintext newline-delimited JSON, the pre-v6 Python wire) is still spoken on
links to legacy peers, but only behind the opt-in `allow_plaintext` flag —
exactly the npm client's `--allow-plaintext` behaviour.

Messaging semantics are unchanged from v1: room-scoped MESSAGE frames with
duplicate suppression and a one-hop relay so a message still lands when two
peers are not directly connected to each other.
"""

import json
import socket
import threading

from .crypto import (
    create_key_exchange,
    derive_session_keys,
    open_ as open_frame,
    parse_key_exchange_from_wire,
    seal,
)
from .protocol import (
    LEGACY_WIRE_VERSION,
    PROTOCOL_VERSION,
    SUPPORTED_WIRE_VERSIONS,
    create_envelope,
    decode_frames,
    encode_action_message,
    encode_envelope,
    now_ms,
    parse_envelope,
    parse_hello_data,
    parse_message_data,
    sanitize_room_name,
)
from .secure_framing import (
    MAGIC_BYTE,
    SecureFrameReader,
    SecureSession,
    decode_secure_payload,
    encode_handshake_frame,
    encode_secure_frame,
)

MAX_PEERS = 64
DEDUP_CACHE_SIZE = 1024

# An inbound connection has this long to complete its handshake.
HELLO_TIMEOUT_SECONDS = 5.0


class ChatClient:
    """Owns the listening TCP socket and every peer link."""

    def __init__(
        self,
        client_id,
        username,
        get_room,
        on_event=None,
        identity_seed=None,
        allow_plaintext=False,
        check_peer_pin=None,
    ):
        """`get_room` is read fresh for every HELLO (the room can change).

        `identity_seed` is our long-term Ed25519 seed (32 bytes); a fresh
        ephemeral one is generated when omitted (callers that want stable
        TOFU pins pass the seed persisted in their config).

        `allow_plaintext` opts in to unencrypted protocol v1 links to legacy
        peers; off by default, matching the npm client.

        `check_peer_pin(client_id, identity_key_id)` returns 'ok', 'new' or
        'mismatch' (TOFU); 'mismatch' refuses the link.
        """
        import os

        self.client_id = client_id
        self.username = username
        self.get_room = get_room
        self.on_event = on_event or (lambda kind, **kwargs: None)
        self.identity_seed = bytes(identity_seed) if identity_seed is not None else os.urandom(32)
        self.allow_plaintext = allow_plaintext
        self.check_peer_pin = check_peer_pin

        self._server = None
        self._server_port = 0
        self._running = False
        self._lock = threading.RLock()

        # client_id -> link dict:
        #   {"socket", "username", "room", "mode", "session", "reader"}
        # `mode` is "secure" (v2) or "plain" (legacy v1); `session`/`reader`
        # are set only on secure links.
        self._links = {}
        # message ids we have already seen (duplicate suppression)
        self._seen_ids = set()
        self._seen_order = []
        # legacy peers we already warned about (once per client id)
        self._legacy_warned = set()

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
                # The OS picks the real port (relevant for the ephemeral fallback).
                self._server_port = self._server.getsockname()[1]
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

    def link_modes(self):
        """client_id -> 'secure' | 'plain' for every live link."""
        with self._lock:
            return {client_id: link["mode"] for client_id, link in self._links.items()}

    # ------------------------------------------------------------- connecting

    def connect_to(self, address, port, timeout=3.0, plaintext="auto"):
        """Dial a peer and run the HELLO handshake. Returns True on success.

        `plaintext` picks the wire mode: False forces protocol v2 (encrypted),
        True forces legacy v1 (refused unless allow_plaintext was set), and
        "auto" tries v2 first, then — only when plaintext links are allowed —
        one plaintext retry if the peer did not speak v2 (the npm client's
        manual-connect behaviour).
        """
        if plaintext is True and not self.allow_plaintext:
            self._warn_legacy_once("manual", "plaintext links are disabled (use --allow-plaintext)")
            return False

        if plaintext is True:
            return self._connect_plain(address, port, timeout=timeout)

        ok, spoke_v2 = self._connect_secure(address, port, timeout=timeout)
        if ok or not self.allow_plaintext or plaintext is False:
            return ok

        if spoke_v2:
            return ok  # the peer spoke v2 and the handshake still failed: do not retry

        return self._connect_plain(address, port, timeout=timeout)

    def connect_to_peer_object(self, peer):
        """Dial a discovery.Peer, trying its advertised addresses in turn.

        The beacon's wire version picks the mode: v2 peers are dialled
        encrypted, legacy v1 peers only when plaintext links are allowed.
        """
        wire_version = getattr(peer, "wire_version", PROTOCOL_VERSION)
        if wire_version == LEGACY_WIRE_VERSION and not self.allow_plaintext:
            self._warn_legacy_once(
                peer.client_id,
                f"{peer.username} speaks the legacy protocol; encryption unavailable "
                "(use --allow-plaintext to link anyway)",
            )
            return False

        candidates = list(peer.addresses)
        source = getattr(peer, "_source", None)
        if source and source not in candidates:
            candidates.append(source)
        for address in candidates:
            if self.connect_to(address, peer.port, plaintext=(wire_version == LEGACY_WIRE_VERSION)):
                return True
        return False

    def _warn_legacy_once(self, key, message):
        if key in self._legacy_warned:
            return
        self._legacy_warned.add(key)
        self.on_event("warning", text=message)

    # ------------------------------------------------- secure (v2) dialling

    def _connect_secure(self, address, port, timeout=3.0):
        """Run the v2 handshake as initiator. Returns (ok, peer_spoke_v2)."""
        try:
            sock = socket.create_connection((address, port), timeout=timeout)
        except OSError as error:
            self.on_event("warning", text=f"could not connect to {address}:{port} ({error})")
            return False, True  # transport-level failure: not a protocol verdict

        sock.settimeout(HELLO_TIMEOUT_SECONDS)
        try:
            mine = create_key_exchange(self.identity_seed)
            hello = self._build_hello(key_exchange=mine)
            sock.sendall(encode_handshake_frame(encode_envelope(hello)))

            reader = SecureFrameReader()
            reply = None
            while reply is None:
                chunk = sock.recv(4096)
                if not chunk:
                    sock.close()
                    return False, False  # peer never spoke v2: maybe legacy
                frames = reader.push(chunk)
                if frames is None:
                    sock.close()
                    return False, False
                for frame in frames:
                    if frame.seq != 0:
                        sock.close()
                        return False, True  # data before the handshake: broken v2
                    reply = frame.payload

            spoke_v2 = True
            envelope = self._parse_handshake_hello(reply)
            if envelope is None:
                sock.close()
                return False, spoke_v2

            exchange = parse_key_exchange_from_wire((envelope.get("data") or {}).get("keyExchange"))
            if exchange is None:
                sock.close()
                return False, spoke_v2

            if not self._pin_ok(envelope["from"], exchange.identity_key_id):
                sock.close()
                return False, spoke_v2

            keys = derive_session_keys(mine.private_key, exchange.public_key, mine.nonce, is_initiator=True)
            if keys is None:
                sock.close()
                return False, spoke_v2

            if not self._register_link(
                sock,
                envelope,
                mode="secure",
                session=SecureSession(keys.send, keys.recv),
                reader=SecureFrameReader(reader._buffer),
            ):
                return False, spoke_v2

            sock.settimeout(None)
            threading.Thread(
                target=self._serve_link, args=(sock, envelope["from"]), daemon=True
            ).start()
            self.on_event("peer-connected", client_id=envelope["from"], username=envelope["username"])
            return True, spoke_v2
        except (OSError, ValueError):
            self._quiet_close(sock)
            return False, True

    # ------------------------------------------------- plaintext (v1) dialling

    def _connect_plain(self, address, port, timeout=3.0):
        """Legacy v1 handshake (newline-delimited JSON), as before v6."""
        try:
            sock = socket.create_connection((address, port), timeout=timeout)
        except OSError as error:
            self.on_event("warning", text=f"could not connect to {address}:{port} ({error})")
            return False

        sock.settimeout(HELLO_TIMEOUT_SECONDS)
        hello = self._build_hello(version=LEGACY_WIRE_VERSION)
        try:
            sock.sendall(encode_envelope(hello))
            reply = self._read_plain_envelopes(sock)
        except OSError:
            sock.close()
            return False

        peer_envelope = next((e for e in reply if e["type"] == "HELLO"), None)
        if peer_envelope is None or peer_envelope["from"] == self.client_id:
            sock.close()
            return False

        if not self._register_link(sock, peer_envelope, mode="plain"):
            return False

        # The handshake timeout must not linger: an idle chat link is healthy,
        # and a leftover recv timeout would drop it every few seconds.
        sock.settimeout(None)

        threading.Thread(
            target=self._serve_link, args=(sock, peer_envelope["from"]), daemon=True
        ).start()
        self.on_event(
            "peer-connected", client_id=peer_envelope["from"], username=peer_envelope["username"]
        )
        return True

    def _read_plain_envelopes(self, sock):
        """Read from the socket until a newline-delimited envelope arrives."""
        buffer = ""
        envelopes = []
        try:
            while not envelopes:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                envelopes, buffer = decode_frames(
                    chunk, buffer, allowed_versions=SUPPORTED_WIRE_VERSIONS
                )
        except OSError:
            pass
        return envelopes

    # ---------------------------------------------------------------- sending

    def send_chat(self, text):
        """Send a message to every connected peer in the same room."""
        room = self.get_room()
        envelope = create_envelope(
            "MESSAGE", self.client_id, self.username, room=room, data={"text": text}
        )
        sent = self._broadcast(envelope, room)
        self.on_event("message-sent", envelope=envelope, peers=sent)
        return sent

    def send_action(self, text):
        """Send an action (`/me waves`) to every connected peer in the room."""
        framed = encode_action_message(text)
        if framed is None:
            return 0
        room = self.get_room()
        envelope = create_envelope(
            "MESSAGE", self.client_id, self.username, room=room, data={"text": framed}
        )
        sent = self._broadcast(envelope, room)
        self.on_event("message-sent", envelope=envelope, peers=sent)
        return sent

    def send_heartbeat(self):
        self._broadcast(create_envelope("PING", self.client_id, self.username), None)

    # ------------------------------------------------------------- internals

    def _build_hello(self, key_exchange=None, version=None):
        from .crypto import encode_key_exchange_for_wire

        data = {"port": self._server_port, "addresses": []}
        if key_exchange is not None:
            data["keyExchange"] = encode_key_exchange_for_wire(key_exchange)
        return create_envelope(
            "HELLO",
            self.client_id,
            self.username,
            room=self.get_room(),
            data=data,
            version=version,
        )

    def _parse_handshake_hello(self, payload):
        """Validate a seq-0 handshake payload into a HELLO envelope, or None."""
        try:
            raw = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None
        envelope = parse_envelope(raw, allowed_versions=(PROTOCOL_VERSION,))
        if envelope is None or envelope["type"] != "HELLO":
            return None
        return envelope

    def _pin_ok(self, client_id, identity_key_id):
        """TOFU verdict for a peer's identity key; warns on mismatch."""
        if self.check_peer_pin is None:
            return True
        verdict = self.check_peer_pin(client_id, identity_key_id)
        if verdict == "mismatch":
            self.on_event(
                "warning",
                text="a peer presented a different identity key; refusing the link",
            )
            return False
        return True

    def _register_link(self, sock, envelope, mode, session=None, reader=None):
        """Record a completed handshake. Returns False when refused."""
        with self._lock:
            if envelope["from"] in self._links or len(self._links) >= MAX_PEERS:
                self._quiet_close(sock)
                return False

            self._links[envelope["from"]] = {
                "socket": sock,
                "username": envelope["username"],
                "room": envelope["room"],
                "mode": mode,
                "session": session,
                "reader": reader,
            }
        return True

    @staticmethod
    def _quiet_close(sock):
        try:
            sock.close()
        except OSError:
            pass

    def _accept_loop(self):
        while self._running:
            try:
                sock, address = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._serve_inbound, args=(sock, address), daemon=True).start()

    def _serve_inbound(self, sock, address):
        """Acceptor side: sniff the first byte, then complete the handshake.

        A v2 stream starts with MAGIC_BYTE; anything else is a legacy v1
        stream, which is refused unless plaintext links are allowed.
        """
        sock.settimeout(HELLO_TIMEOUT_SECONDS)
        try:
            first = sock.recv(4096)
        except OSError:
            self._quiet_close(sock)
            return
        if not first:
            self._quiet_close(sock)
            return

        if first[0] == MAGIC_BYTE:
            self._serve_inbound_secure(sock, first)
        elif self.allow_plaintext:
            self._serve_inbound_plain(sock, first)
        else:
            # A legacy peer (or an impostor) without the opt-in: same
            # treatment as any other protocol violation.
            self._quiet_close(sock)

    def _serve_inbound_secure(self, sock, first_chunk):
        """Accept a v2 link: verify their signed HELLO, reply, derive keys."""
        reader = SecureFrameReader()
        frames = reader.push(first_chunk)
        if frames is None:
            self._quiet_close(sock)
            return

        deadline_frame = next((f for f in frames if f.seq == 0), None)
        try:
            while deadline_frame is None:
                chunk = sock.recv(4096)
                if not chunk:
                    self._quiet_close(sock)
                    return
                frames = reader.push(chunk)
                if frames is None:
                    self._quiet_close(sock)
                    return
                deadline_frame = next((f for f in frames if f.seq == 0), None)
        except OSError:
            self._quiet_close(sock)
            return

        envelope = self._parse_handshake_hello(deadline_frame.payload)
        if envelope is None or envelope["from"] == self.client_id:
            self._quiet_close(sock)
            return

        exchange = parse_key_exchange_from_wire((envelope.get("data") or {}).get("keyExchange"))
        if exchange is None:
            self._quiet_close(sock)
            return

        if not self._pin_ok(envelope["from"], exchange.identity_key_id):
            self._quiet_close(sock)
            return

        with self._lock:
            if envelope["from"] in self._links or len(self._links) >= MAX_PEERS:
                self._quiet_close(sock)
                return

        # We are the acceptor: our reply HELLO carries our signed exchange as
        # a plaintext seq-0 frame; the HKDF salt is the initiator's nonce.
        ours = create_key_exchange(self.identity_seed)
        keys = derive_session_keys(ours.private_key, exchange.public_key, exchange.nonce, is_initiator=False)
        if keys is None:
            self._quiet_close(sock)
            return

        try:
            reply = self._build_hello(key_exchange=ours)
            sock.sendall(encode_handshake_frame(encode_envelope(reply)))
        except OSError:
            self._quiet_close(sock)
            return

        if not self._register_link(
            sock,
            envelope,
            mode="secure",
            session=SecureSession(keys.send, keys.recv),
            reader=SecureFrameReader(reader._buffer),
        ):
            return

        sock.settimeout(None)
        self.on_event("peer-connected", client_id=envelope["from"], username=envelope["username"])
        self._serve_link(sock, envelope["from"])

    def _serve_inbound_plain(self, sock, first_chunk):
        """Accept a legacy v1 link (newline-delimited JSON), as before v6."""
        buffer = ""
        envelopes, buffer = decode_frames(
            first_chunk, buffer, allowed_versions=SUPPORTED_WIRE_VERSIONS
        )
        try:
            while not any(e["type"] == "HELLO" for e in envelopes):
                chunk = sock.recv(4096)
                if not chunk:
                    break
                envelopes, buffer = decode_frames(
                    chunk, buffer, allowed_versions=SUPPORTED_WIRE_VERSIONS
                )
        except OSError:
            self._quiet_close(sock)
            return

        hello = next((e for e in envelopes if e["type"] == "HELLO"), None)
        if hello is None or hello["from"] == self.client_id:
            self._quiet_close(sock)
            return

        with self._lock:
            if hello["from"] in self._links or len(self._links) >= MAX_PEERS:
                self._quiet_close(sock)
                return

        if not self._register_link(sock, hello, mode="plain"):
            return

        # Reply with our own HELLO so both ends are identified (v1-stamped:
        # a legacy peer cannot parse our v2 envelopes).
        try:
            sock.sendall(encode_envelope(self._build_hello(version=LEGACY_WIRE_VERSION)))
        except OSError:
            self._drop_link(hello["from"])
            return

        sock.settimeout(None)
        self.on_event("peer-connected", client_id=hello["from"], username=hello["username"])
        self._serve_link(sock, hello["from"])

    def _serve_link(self, sock, client_id):
        with self._lock:
            link = self._links.get(client_id)
            mode = link["mode"] if link else "plain"

        if mode == "secure":
            self._serve_link_secure(sock, client_id)
        else:
            self._serve_link_plain(sock, client_id)

    def _serve_link_secure(self, sock, client_id):
        """Read sealed v2 frames; any violation drops the connection."""
        with self._lock:
            link = self._links.get(client_id)
            reader = link["reader"] if link else None
            session = link["session"] if link else None
        if reader is None or session is None:
            return

        buffer = ""
        while self._running:
            try:
                chunk = sock.recv(8192)
            except (OSError, TimeoutError):
                break
            if not chunk:
                break

            frames = reader.push(chunk)
            if frames is None:
                break  # not a v2 stream: hostile or corrupt

            violation = False
            for frame in frames:
                if frame.seq == 0:
                    violation = True  # handshake frames after the session: nonsense
                    break

                plain = decode_secure_payload(session, frame.seq, frame.head, frame.payload, open_frame)
                if plain is None:
                    violation = True  # replay, gap, tampering or wrong key
                    break

                envelopes, buffer = decode_frames(plain, buffer, allowed_versions=(PROTOCOL_VERSION,))
                for envelope in envelopes:
                    self._handle(envelope, client_id)

            if violation:
                break

        self._drop_link(client_id)

    def _serve_link_plain(self, sock, client_id):
        buffer = ""
        while self._running:
            try:
                chunk = sock.recv(8192)
            except (OSError, TimeoutError):
                break
            if not chunk:
                break
            envelopes, buffer = decode_frames(chunk, buffer, allowed_versions=SUPPORTED_WIRE_VERSIONS)
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
                (cid, self._wire_bytes(link, envelope))
                for cid, link in self._links.items()
                if cid != skip_client and (room is None or link["room"] == room)
            ]
        for client_id, wire in targets:
            if self._send_wire(client_id, wire):
                sent += 1
        return sent

    def _wire_bytes(self, link, envelope):
        """Serialise an envelope for one link's wire mode.

        Secure links seal the JSON frame with the session's send key; plain
        links re-stamp the envelope to v1 (a legacy peer cannot parse v2).
        """
        if link["mode"] == "plain":
            restamped = dict(envelope)
            restamped["v"] = LEGACY_WIRE_VERSION
            return encode_envelope(restamped)
        return encode_secure_frame(link["session"], encode_envelope(envelope), seal)

    def _send_to(self, client_id, envelope, sock=None):
        with self._lock:
            link = self._links.get(client_id)
            if link is None:
                return False
            try:
                wire = self._wire_bytes(link, envelope)
            except ValueError:
                self._drop_link(client_id)
                return False
        return self._send_wire(client_id, wire)

    def _send_wire(self, client_id, wire):
        with self._lock:
            link = self._links.get(client_id)
            sock = link["socket"] if link else None
        if sock is None:
            return False
        try:
            sock.sendall(wire)
            return True
        except OSError:
            self._drop_link(client_id)
            return False

    def _drop_link(self, client_id):
        with self._lock:
            link = self._links.pop(client_id, None)
        if link is not None:
            self._quiet_close(link["socket"])
            self.on_event("peer-gone", client_id=client_id, username=link["username"])
