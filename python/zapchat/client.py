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

import base64
import json
import os
import socket
import threading
import time
from collections import deque

from .crypto import (
    create_key_exchange,
    derive_session_keys,
    open_ as open_frame,
    parse_key_exchange_from_wire,
    seal,
)
from .identity import identity_key_id
from .protocol import (
    FILE_CHUNK_BYTES,
    LEGACY_WIRE_VERSION,
    MAX_ACTIVE_TRANSFERS,
    MAX_FILE_BYTES,
    MAX_MESSAGE_CHARS,
    OFFLINE_QUEUE_LIMIT,
    OFFLINE_QUEUE_TTL_MS,
    PROTOCOL_VERSION,
    REACTION_SET,
    SUPPORTED_WIRE_VERSIONS,
    TRANSFER_IDLE_TIMEOUT_MS,
    create_envelope,
    decode_frames,
    encode_action_message,
    encode_envelope,
    new_message_id,
    now_ms,
    parse_envelope,
    parse_file_chunk_data,
    parse_file_offer_data,
    parse_hello_data,
    parse_message_data,
    parse_reaction_data,
    parse_reply_data,
    parse_transfer_id_data,
    sanitize_room_name,
    sanitize_text,
)
from .transfers import (
    chunk_count,
    format_bytes,
    is_transferable_size,
    received_file_path,
    received_files_dir,
    sanitize_file_name,
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
        # (address, port) -> threading.Event for handshakes in flight. The CLI
        # dial loop retries every second, so without this guard several
        # concurrent dials race their handshakes against the same peer; the
        # acceptor's duplicate-check is not atomic, and both sides can end up
        # registered on different sockets — which then fail AEAD integrity and
        # flap connected/left forever (the v6.0.0 stall).
        self._pending_dials = {}
        # (address, port) -> client_id of the peer a successful dial added,
        # so followers of a concurrent dial can report the same outcome.
        self._dial_targets = {}

        # ---- v8 file transfers ------------------------------------------
        # Offers we published: file path, room and per-peer send progress.
        self._outgoing = {}
        # Files peers are streaming to us, keyed by transfer id.
        self._incoming = {}
        # Ids whose target file is being opened (dedup + capacity guard).
        self._pending_incoming = set()

        # ---- v8 offline queue + identity --------------------------------
        # (queued_at_ms, envelope) pairs that reached nobody, replayed once
        # their room gains a member. Capped and TTL'd so the buffer can
        # neither grow without bound nor surprise a peer much later.
        self._offline = deque()
        # client_id -> identity key id seen at handshake (for /fingerprint).
        self._peer_key_ids = {}

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
        threading.Thread(target=self._sweep_loop, daemon=True).start()
        return self._server_port

    def _sweep_loop(self):
        """Reap stalled transfers and drain the offline queue once a second
        (same cadence as the npm sweep)."""
        while self._running:
            time.sleep(1.0)
            try:
                self.sweep_transfers()
                self.flush_offline()
            except Exception:  # never let the sweep die
                pass

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

        # Abort transfers: peers on still-open links get FILE_CANCEL, and every
        # partial download is closed and deleted so nothing half-written lives.
        with self._lock:
            outgoing = list(self._outgoing.values())
            incoming = list(self._incoming.values())
            self._outgoing.clear()
            self._incoming.clear()
        for transfer in outgoing:
            transfer["cancelled"] = True
            self._send_transfer_control(
                "FILE_CANCEL", transfer["id"], transfer["room"], list(transfer["peers"])
            )
        for transfer in incoming:
            self._discard_incoming(transfer)

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

    def peer_usernames(self):
        """Usernames of every connected peer (for tab completion)."""
        with self._lock:
            return [link["username"] for link in self._links.values()]

    def peer_name_map(self):
        """client_id -> username for every live link (peer commands)."""
        with self._lock:
            return {client_id: link["username"] for client_id, link in self._links.items()}

    def peer_rooms(self):
        """client_id -> room each peer last announced (for /users).

        A mismatch here against our own room is exactly why messages go
        nowhere while everything looks "connected", so it must be visible.
        """
        with self._lock:
            return {client_id: link["room"] for client_id, link in self._links.items()}

    def identity_fingerprint(self):
        """Fingerprint of our long-term identity key (`/identity`)."""
        return identity_key_id(self.identity_seed)

    def peer_fingerprint(self, client_id):
        """Identity key id presented by a peer at handshake, or None."""
        with self._lock:
            return self._peer_key_ids.get(client_id)

    def offline_count(self):
        """Messages waiting in the offline queue (for /status)."""
        with self._lock:
            return len(self._offline)

    def announce_identity(self):
        """Re-send HELLO on every live link so peers see room/name changes.

        Both stacks key a peer's room off its latest HELLO/JOIN frame; without
        this, a `/join` (or `/name`) on one side silently black-holed every
        later room-scoped message on the other — each side's broadcast filter
        disagreed about which room the other was in.
        """
        hello = self._build_hello()
        with self._lock:
            targets = list(self._links.keys())
        for client_id in targets:
            self._send_to(client_id, hello)

    # ------------------------------------------------------------- connecting

    def connect_to(self, address, port, timeout=3.0, plaintext="auto"):
        """Dial a peer and run the HELLO handshake. Returns True on success.

        `plaintext` picks the wire mode: False forces protocol v2 (encrypted),
        True forces legacy v1 (refused unless allow_plaintext was set), and
        "auto" tries v2 first, then — only when plaintext links are allowed —
        one plaintext retry if the peer did not speak v2 (the npm client's
        manual-connect behaviour).

        Concurrent dials to the same destination are collapsed: followers
        wait for the in-flight handshake and adopt its outcome, instead of
        racing a second one (the acceptor's duplicate-check is not atomic, so
        two racing handshakes could register mismatched sessions on the two
        sides — links then fail AEAD integrity and flap forever).
        """
        if plaintext is True and not self.allow_plaintext:
            self._warn_legacy_once("manual", "plaintext links are disabled (use --allow-plaintext)")
            return False

        key = (address, port)
        pending = self._pending_dials.get(key)
        if pending is not None:
            pending.wait(timeout + HELLO_TIMEOUT_SECONDS + 1.0)
            with self._lock:
                client_id = self._dial_targets.get(key, "")
                return bool(client_id) and client_id in self._links

        done = threading.Event()
        self._pending_dials[key] = done
        try:
            return self._connect_inner(address, port, timeout, plaintext, key, done)
        finally:
            done.set()
            self._pending_dials.pop(key, None)
            self._dial_targets.pop(key, None)

    def _connect_inner(self, address, port, timeout, plaintext, key, done):
        if plaintext is True:
            ok = self._connect_plain(address, port, timeout=timeout, dial_key=key)
        else:
            ok, spoke_v2 = self._connect_secure(address, port, timeout=timeout, dial_key=key)
            if not ok and self.allow_plaintext and plaintext == "auto" and not spoke_v2:
                # The peer never spoke a byte of v2: almost certainly a
                # zapchat <= 5 legacy peer. Retry in plaintext, when allowed.
                ok = self._connect_plain(address, port, timeout=timeout, dial_key=key)

        if ok:
            # Remember who answered at this destination so followers of a
            # collapsed dial report the same outcome.
            with self._lock:
                for client_id, link in self._links.items():
                    if link.get("dial_key") == key:
                        self._dial_targets[key] = client_id
                        break
        return ok

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

    def _connect_secure(self, address, port, timeout=3.0, dial_key=None):
        """Run the v2 handshake as initiator. Returns (ok, peer_spoke_v2)."""
        try:
            sock = socket.create_connection((address, port), timeout=timeout)
        except OSError as error:
            self.on_event("warning", text=f"could not connect to {address}:{port} ({error})")
            return False, True  # transport-level failure: not a protocol verdict

        sock.settimeout(HELLO_TIMEOUT_SECONDS)
        spoke_v2 = False  # any v2 byte from the peer flips this
        try:
            mine = create_key_exchange(self.identity_seed)
            hello = self._build_hello(key_exchange=mine)
            sock.sendall(encode_handshake_frame(encode_envelope(hello)))

            reader = SecureFrameReader()
            reply = None
            while reply is None:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    # No v2 byte ever came back: on a LAN this is almost always
                    # a zapchat <= 5 peer that cannot speak v2 at all.
                    return False, spoke_v2
                if not chunk:
                    sock.close()
                    return False, spoke_v2  # peer never spoke v2: maybe legacy
                frames = reader.push(chunk)
                if frames is None:
                    sock.close()
                    return False, spoke_v2
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
                dial_key=dial_key,
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
            return False, spoke_v2

    # ------------------------------------------------- plaintext (v1) dialling

    def _connect_plain(self, address, port, timeout=3.0, dial_key=None):
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

        if not self._register_link(sock, peer_envelope, mode="plain", dial_key=dial_key):
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
        """Send a message to every connected peer in the same room.

        Nobody reachable? The message is queued (and flagged on the
        `message-sent` event) instead of vanishing — either way the sender
        gets a local echo, so what you type always appears on screen.
        """
        room = self.get_room()
        # Sanitise before the wire so peers see exactly what we echo locally
        # (npm parity: strip ANSI/controls, cap the length).
        clean = sanitize_text(text, MAX_MESSAGE_CHARS)
        if clean is None:
            self.on_event("warning", text="message is empty or too long")
            return 0
        envelope = create_envelope(
            "MESSAGE", self.client_id, self.username, room=room, data={"text": clean}
        )
        sent = self._broadcast(envelope, room)
        queued = None
        if sent == 0:
            # Buffer it and replay when a peer in this room shows up, rather
            # than silently dropping what the user just wrote.
            queued = self._queue_offline(envelope)
        self.on_event("message-sent", envelope=envelope, peers=sent, queued=queued)
        return sent

    def send_action(self, text):
        """Send an action (`/me waves`) to every connected peer in the room."""
        framed = encode_action_message(text)
        if framed is None:
            self.on_event("warning", text="action is empty")
            return 0
        room = self.get_room()
        envelope = create_envelope(
            "MESSAGE", self.client_id, self.username, room=room, data={"text": framed}
        )
        sent = self._broadcast(envelope, room)
        queued = None
        if sent == 0:
            queued = self._queue_offline(envelope)
        self.on_event("message-sent", envelope=envelope, peers=sent, queued=queued)
        return sent

    def send_heartbeat(self):
        self._broadcast(create_envelope("PING", self.client_id, self.username), None)

    def send_reply(self, reply_to, text):
        """Reply to a message id. Returns the peer count, or None if invalid."""
        body, target = parse_reply_data({"text": text, "replyTo": reply_to})
        if body is None:
            return None
        room = self.get_room()
        envelope = create_envelope(
            "REPLY",
            self.client_id,
            self.username,
            room=room,
            data={"text": body, "replyTo": target},
        )
        sent = self._broadcast(envelope, room)
        self.on_event(
            "reply-sent",
            text=body,
            reply_to=target,
            peers=sent,
            room=room,
            message_id=envelope["id"],
        )
        if sent == 0:
            self.on_event("warning", text="no peers are connected yet — your reaction is only local for now")
        return sent

    def send_reaction(self, target, reaction):
        """React to a message id. Returns the peer count, or None if invalid."""
        goal, emoji = parse_reaction_data({"target": target, "reaction": reaction})
        if emoji is None:
            return None
        room = self.get_room()
        envelope = create_envelope(
            "REACTION",
            self.client_id,
            self.username,
            room=room,
            data={"target": goal, "reaction": emoji},
        )
        sent = self._broadcast(envelope, room)
        self.on_event(
            "reaction-sent",
            reaction=emoji,
            target=goal,
            peers=sent,
            room=room,
            message_id=envelope["id"],
        )
        if sent == 0:
            self.on_event("warning", text="no peers are connected yet — your reaction is only local for now")
        return sent

    # ---------------------------------------------------- offline queue (v8)

    def _queue_offline(self, envelope):
        """Buffer a message that reached nobody.

        Returns False when the queue was full (the oldest entry was dropped
        so the message the user just wrote survives) — the caller tells them.
        """
        with self._lock:
            had_room = len(self._offline) < OFFLINE_QUEUE_LIMIT
            if not had_room:
                self._offline.popleft()
            self._offline.append((now_ms(), envelope))
        return had_room

    def _count_room(self, room):
        with self._lock:
            return sum(1 for link in self._links.values() if link["room"] == room)

    def flush_offline(self):
        """Replay queued messages whose room now has somebody. Returns count.

        Per-envelope rather than per-room so one busy room cannot hold up (or
        leak) another room's backlog; expired entries are pruned here too.
        """
        with self._lock:
            items = list(self._offline)
        if not items:
            return 0

        now = now_ms()
        sent_ids = set()
        for queued_at, envelope in items:
            if now - queued_at > OFFLINE_QUEUE_TTL_MS:
                continue  # expired: drop it (pruned below)
            room = envelope["room"]
            if not room or self._count_room(room) == 0:
                continue  # still nobody in that room
            if self._broadcast(envelope, room) > 0:
                sent_ids.add(envelope["id"])

        with self._lock:
            if sent_ids:
                self._offline = deque(
                    (t, e) for t, e in self._offline if e["id"] not in sent_ids
                )
            else:
                # Nothing delivered — still prune expired entries so TTL holds
                # even when no peer ever shows up.
                self._offline = deque(
                    (t, e) for t, e in self._offline if now - t <= OFFLINE_QUEUE_TTL_MS
                )

        if sent_ids:
            self.on_event("offline-flushed", count=len(sent_ids))
        return len(sent_ids)

    # ------------------------------------------------------------- internals

    def offer_file(self, file_path):
        """Offer a local file to everyone in the current room.

        Returns (True, None) on success or (False, reason) — the CLI turns the
        reason into a one-line error, so no translation layer is needed.
        """
        room = self.get_room()
        if not room:
            return False, "join a room first (/join general)"

        trimmed = (file_path or "").strip()
        if not trimmed:
            return False, "usage: /file <file-path>"

        try:
            stats = os.stat(trimmed)
        except OSError:
            return False, f"cannot read {trimmed} (no such file)"

        if not os.path.isfile(trimmed):
            return False, f"{trimmed} is not a regular file"

        size = stats.st_size
        if size == 0 or not is_transferable_size(size):
            return False, f"file is empty or larger than {format_bytes(MAX_FILE_BYTES)}"

        name = sanitize_file_name(os.path.basename(trimmed))
        if name is None:
            return False, "file name is not usable"

        if self._slot_count() >= MAX_ACTIVE_TRANSFERS:
            return False, f"too many active transfers (max {MAX_ACTIVE_TRANSFERS})"

        with self._lock:
            targets = [
                cid
                for cid, link in self._links.items()
                if cid != self.client_id and link["room"] == room
            ]
        if not targets:
            return False, "no peers are connected in this room yet — nobody can accept the offer"

        now = now_ms()
        transfer = {
            "id": new_message_id(),
            "room": room,
            "path": trimmed,
            "name": name,
            "size": size,
            "lastActivity": now,
            "cancelled": False,
            "peers": {cid: {"phase": "offered", "sent": 0} for cid in targets},
        }
        with self._lock:
            self._outgoing[transfer["id"]] = transfer

        envelope = create_envelope(
            "FILE_OFFER",
            self.client_id,
            self.username,
            room=room,
            data={"transferId": transfer["id"], "name": name, "size": size},
            ts=now,
        )
        sent = 0
        for peer_id in targets:
            if self._send_to(peer_id, envelope):
                sent += 1

        self.on_event(
            "file-offer-out",
            transfer_id=transfer["id"],
            name=name,
            size=size,
            peers=sent,
            chunk_count=chunk_count(size),
        )
        return True, None

    def cancel_transfer(self, transfer_id=None):
        """Abort transfers. With no argument every active transfer is cancelled."""
        wanted = (transfer_id or "").strip()
        cancelled = 0

        with self._lock:
            outgoing = list(self._outgoing.items())
            incoming = list(self._incoming.items())
            for tid in list(self._outgoing):
                if not wanted or tid.startswith(wanted):
                    del self._outgoing[tid]
            for tid in list(self._incoming):
                if not wanted or tid.startswith(wanted):
                    del self._incoming[tid]

        for tid, transfer in outgoing:
            if wanted and not tid.startswith(wanted):
                continue
            transfer["cancelled"] = True
            self._send_transfer_control("FILE_CANCEL", tid, transfer["room"], transfer["peers"])
            self.on_event(
                "file-cancelled-out", name=transfer["name"], transfer_id=tid
            )
            cancelled += 1

        for tid, transfer in incoming:
            if wanted and not tid.startswith(wanted):
                continue
            self._discard_incoming(transfer)
            # Tell the sender to stop: a cancelled download must never count as
            # received, and the sender must retire its offer instead of
            # streaming chunks into the void until the whole file is pushed.
            self._send_transfer_control(
                "FILE_CANCEL", tid, transfer["room"], [transfer["from"]]
            )
            cancelled += 1

        if cancelled == 0:
            return False, f'no transfer matching "{wanted}"' if wanted else "no active transfers"

        return True, None

    def _slot_count(self):
        with self._lock:
            return len(self._outgoing) + len(self._incoming) + len(self._pending_incoming)

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
            self._peer_key_ids[client_id] = identity_key_id
            return True
        verdict = self.check_peer_pin(client_id, identity_key_id)
        if verdict == "mismatch":
            self.on_event(
                "warning",
                text="a peer presented a different identity key; refusing the link",
            )
            return False
        self._peer_key_ids[client_id] = identity_key_id
        return True

    def _register_link(self, sock, envelope, mode, session=None, reader=None, dial_key=None):
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
                "dial_key": dial_key,
                # One writer at a time per socket: the heartbeat, PONG replies
                # and transfer streaming all share this link, and interleaved
                # sendall() calls would corrupt the frame stream.
                "send_lock": threading.Lock(),
            }
        # A new link may be exactly who the queued backlog was waiting for.
        self.flush_offline()
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
            room_changed = False
            with self._lock:
                link = self._links.get(client_id)
                if link is not None:
                    room_changed = link["room"] != envelope["room"]
                    link["username"] = envelope["username"]
                    link["room"] = envelope["room"]
            # A mid-session HELLO means the peer changed room/name: tell the
            # UI (a room change with no visible trace looks like a frozen
            # chat), then check whether our backlog was waiting for them.
            # NB: kwarg must not be named `kind` — callbacks use that name for
            # the event itself, and a duplicate raises inside the reader
            # thread, killing the link's receive loop.
            if room_changed:
                self.on_event("presence", action="JOIN", envelope=envelope)
            self.flush_offline()
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
                    message_id=envelope["id"],
                )
            # One-hop relay: forward to same-room peers that have not seen it.
            self._relay(envelope, from_client=client_id)
        elif msg_type == "REPLY":
            text, reply_to = parse_reply_data(envelope["data"])
            if text:
                self.on_event(
                    "reply",
                    sender=envelope["username"],
                    text=text,
                    reply_to=reply_to,
                    room=envelope["room"],
                    client_id=envelope["from"],
                    ts=envelope["ts"],
                    message_id=envelope["id"],
                )
        elif msg_type == "REACTION":
            target, reaction = parse_reaction_data(envelope["data"])
            if reaction:
                self.on_event(
                    "reaction",
                    sender=envelope["username"],
                    reaction=reaction,
                    target=target,
                    client_id=envelope["from"],
                    room=envelope["room"],
                    message_id=envelope["id"],
                )
        elif msg_type == "FILE_OFFER":
            offer = parse_file_offer_data(envelope["data"])
            if offer and envelope["room"] and envelope["room"] == self.get_room():
                self._accept_offer(envelope, offer["transferId"], offer["name"], offer["size"])
        elif msg_type == "FILE_ACCEPT":
            self._on_file_accept(envelope)
        elif msg_type == "FILE_REJECT":
            self._on_file_reject(envelope)
        elif msg_type == "FILE_CHUNK":
            self._on_file_chunk(envelope)
        elif msg_type == "FILE_COMPLETE":
            self._on_file_complete(envelope)
        elif msg_type == "FILE_CANCEL":
            self._on_file_cancel(envelope)
        elif msg_type in ("JOIN", "LEAVE", "ANNOUNCE"):
            with self._lock:
                link = self._links.get(client_id)
                if link is not None:
                    link["username"] = envelope["username"]
                    # A LEAVE names the room being left; everything else names
                    # the room the peer is in now. Keeping this in sync is what
                    # stops our room-scoped broadcasts from black-holing.
                    link["room"] = None if msg_type == "LEAVE" else envelope["room"]
            self.on_event("presence", action=msg_type, envelope=envelope)
            self.flush_offline()

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
            send_lock = link["send_lock"] if link else None
        if sock is None or send_lock is None:
            return False
        try:
            # Held across sendall (not just the call) so two writers cannot
            # interleave halves of a frame on the same socket.
            with send_lock:
                sock.sendall(wire)
            return True
        except OSError:
            self._drop_link(client_id)
            return False

    def _on_file_accept(self, envelope):
        parsed = parse_transfer_id_data(envelope["data"])
        if parsed is None:
            return
        transfer_id = parsed["transferId"]
        with self._lock:
            transfer = self._outgoing.get(transfer_id)
            if transfer is None or transfer["cancelled"]:
                room = transfer["room"] if transfer else envelope["room"]
                entry = None
            else:
                entry = transfer["peers"].get(envelope["from"])
                if entry is None or entry["phase"] != "offered":
                    return
                entry["phase"] = "sending"
                transfer["lastActivity"] = now_ms()

        if entry is None:
            # We are no longer offering it (cancelled/expired): tell the peer to
            # stop waiting for chunks.
            self._send_to(envelope["from"], create_envelope(
                "FILE_CANCEL", self.client_id, self.username,
                room=room, data={"transferId": transfer_id}))
            return

        threading.Thread(
            target=self._stream_to_peer, args=(transfer, envelope["from"]), daemon=True
        ).start()

    def _on_file_reject(self, envelope):
        parsed = parse_transfer_id_data(envelope["data"])
        if parsed is None:
            return
        with self._lock:
            transfer = self._outgoing.get(parsed["transferId"])
            entry = transfer["peers"].get(envelope["from"]) if transfer else None
            if transfer is not None and entry is not None and entry["phase"] == "offered":
                entry["phase"] = "rejected"
        if transfer is not None and entry is not None:
            self._maybe_retire_outgoing(transfer)

    def _on_file_chunk(self, envelope):
        chunk = parse_file_chunk_data(envelope["data"])
        if chunk is None:
            return
        with self._lock:
            transfer = self._incoming.get(chunk["transferId"])
        # Chunks only ever come from the peer whose offer we accepted, only in
        # order, and only up to the advertised size — anything else is dropped.
        if transfer is None or transfer["from"] != envelope["from"]:
            return
        if chunk["index"] != transfer["nextIndex"]:
            return

        try:
            payload = base64.b64decode(chunk["data"], validate=True)
        except (ValueError, TypeError):
            return
        if not payload or len(payload) > FILE_CHUNK_BYTES:
            return

        if transfer["received"] + len(payload) > transfer["size"]:
            # Sender overshot its own advertised size: abort, delete the partial.
            self._abort_incoming(
                transfer,
                f"{transfer['fromUsername']} sent more data than promised for "
                f"{transfer['name']} — discarded",
            )
            return

        transfer["nextIndex"] += 1
        transfer["lastActivity"] = now_ms()
        self._queue_chunk_write(transfer, payload)

    def _on_file_complete(self, envelope):
        parsed = parse_transfer_id_data(envelope["data"])
        if parsed is None:
            return
        with self._lock:
            transfer = self._incoming.pop(parsed["transferId"], None)
        if transfer is None or transfer["from"] != envelope["from"]:
            if transfer is not None:
                with self._lock:
                    self._incoming[transfer["id"]] = transfer
            return

        # Drain the queued write, then confirm the size actually matches what the
        # sender advertised before we announce success.
        with transfer["writeLock"]:
            try:
                transfer["handle"].close()
            except (OSError, ValueError):
                pass
        try:
            written = os.path.getsize(transfer["target"])
        except OSError:
            written = -1

        if written != transfer["size"]:
            try:
                os.remove(transfer["target"])
            except OSError:
                pass
            self.on_event(
                "file-error",
                transfer_id=transfer["id"],
                text=(
                    f"received {transfer['name']} from {transfer['fromUsername']} was "
                    f"incomplete ({written} of {transfer['size']} bytes) — discarded"
                ),
            )
            return

        self.on_event(
            "file-received",
            transfer_id=transfer["id"],
            name=transfer["name"],
            size=transfer["size"],
            sender=transfer["fromUsername"],
            target=transfer["target"],
        )

    def _on_file_cancel(self, envelope):
        parsed = parse_transfer_id_data(envelope["data"])
        if parsed is None:
            return
        transfer_id = parsed["transferId"]

        with self._lock:
            outgoing = self._outgoing.get(transfer_id)
            if outgoing is not None:
                entry = outgoing["peers"].get(envelope["from"])
                if entry is not None and entry["phase"] == "sending":
                    entry["phase"] = "cancelled"
                    outgoing["cancelled"] = self._all_peers_settled(outgoing)
                else:
                    outgoing = None
            else:
                incoming = self._incoming.get(transfer_id)
                if incoming is not None and incoming["from"] == envelope["from"]:
                    self._incoming.pop(transfer_id, None)
                else:
                    incoming = None

        if outgoing is not None:
            self._maybe_retire_outgoing(outgoing)
            return
        if incoming is not None:
            self._discard_incoming(incoming)
            self.on_event(
                "file-error",
                transfer_id=transfer_id,
                text=f"{incoming['fromUsername']} cancelled the transfer of {incoming['name']}",
            )

    def _drop_link(self, client_id):
        with self._lock:
            link = self._links.pop(client_id, None)
        if link is not None:
            self._quiet_close(link["socket"])
            self.on_event("peer-gone", client_id=client_id, username=link["username"])
        self._abort_transfers_for(client_id)

    # ------------------------------------------------------------- transfers

    def _send_transfer_control(self, msg_type, transfer_id, room, peer_ids):
        """Broadcast one FILE_ACCEPT/REJECT/COMPLETE/CANCEL control frame."""
        envelope = create_envelope(
            msg_type,
            self.client_id,
            self.username,
            room=room,
            data={"transferId": transfer_id},
        )
        for peer_id in peer_ids:
            self._send_to(peer_id, envelope)

    def _accept_offer(self, envelope, transfer_id, name, size):
        """A peer offered us a file: open it and accept, or reject with a reason."""
        room = envelope["room"]
        with self._lock:
            duplicate = transfer_id in self._incoming or transfer_id in self._pending_incoming
            busy = len(self._outgoing) + len(self._incoming) + len(self._pending_incoming)
        if duplicate or busy >= MAX_ACTIVE_TRANSFERS:
            self._send_to(envelope["from"], create_envelope(
                "FILE_REJECT", self.client_id, self.username,
                room=room, data={"transferId": transfer_id}))
            return

        with self._lock:
            self._pending_incoming.add(transfer_id)
        try:
            directory = received_files_dir()
            os.makedirs(directory, exist_ok=True)
            target = received_file_path(directory, transfer_id, name)
            if target is None:
                self._send_to(envelope["from"], create_envelope(
                    "FILE_REJECT", self.client_id, self.username,
                    room=room, data={"transferId": transfer_id}))
                return

            # "wb" creates-or-truncates; the unique "<transferId>-" prefix means
            # we never clobber an earlier download of the same name.
            handle = open(target, "wb")
            transfer = {
                "id": transfer_id,
                "from": envelope["from"],
                "fromUsername": envelope["username"],
                "room": room,
                "name": name,
                "size": size,
                "target": target,
                "received": 0,
                "nextIndex": 0,
                "lastActivity": now_ms(),
                "handle": handle,
                # Serialises disk writes so chunks land on disk in wire order.
                "writeLock": threading.Lock(),
            }
            with self._lock:
                self._incoming[transfer_id] = transfer

            self._send_to(envelope["from"], create_envelope(
                "FILE_ACCEPT", self.client_id, self.username,
                room=room, data={"transferId": transfer_id}))
            self.on_event(
                "file-receiving",
                transfer_id=transfer_id,
                name=name,
                size=size,
                sender=envelope["username"],
                target=target,
            )
        except OSError:
            self._send_to(envelope["from"], create_envelope(
                "FILE_REJECT", self.client_id, self.username,
                room=room, data={"transferId": transfer_id}))
        finally:
            with self._lock:
                self._pending_incoming.discard(transfer_id)

    def _queue_chunk_write(self, transfer, payload):
        """Append one decoded chunk; writes are serialised so order is kept."""
        failure = None
        with transfer["writeLock"]:
            # A cancel or a peer disconnect can retire the transfer while this
            # chunk waits for the lock; never write to a closed handle.
            with self._lock:
                if self._incoming.get(transfer["id"]) is not transfer:
                    return

            try:
                transfer["handle"].write(payload)
            except (OSError, ValueError) as error:
                failure = error

        if failure is not None:
            # Abort outside the write lock: _discard_incoming takes it too.
            self._abort_incoming(
                transfer, f"could not write {transfer['name']} to disk ({failure})"
            )
            return

        transfer["received"] += len(payload)
        self.on_event(
            "file-progress",
            transfer_id=transfer["id"],
            name=transfer["name"],
            received=transfer["received"],
            size=transfer["size"],
        )

    def _discard_incoming(self, transfer):
        """Close and delete a partial download. Tolerant: never raises."""
        with transfer["writeLock"]:
            try:
                transfer["handle"].close()
            except (OSError, ValueError):
                pass
        try:
            os.remove(transfer["target"])
        except OSError:
            pass

    def _abort_incoming(self, transfer, reason):
        """Drop an in-flight download and tell the sender to stop."""
        with self._lock:
            if self._incoming.pop(transfer["id"], None) is None:
                return
        self._discard_incoming(transfer)
        self._send_transfer_control(
            "FILE_CANCEL", transfer["id"], transfer["room"], [transfer["from"]]
        )
        self.on_event("file-error", transfer_id=transfer["id"], text=reason)

    def _stream_to_peer(self, transfer, peer_id):
        """Stream one offered file to one accepting peer, chunk by chunk.

        Runs on its own thread. `socket.sendall` applies real backpressure, so
        there is nothing to pace here (the npm client has to poll its write
        buffer instead). Any of — local cancel, shutdown, peer disconnect,
        write refusal — stops the stream cleanly.
        """
        with self._lock:
            entry = transfer["peers"].get(peer_id)
        if entry is None or transfer["cancelled"]:
            return

        completed = False
        try:
            with open(transfer["path"], "rb") as handle:
                index = 0
                while True:
                    if transfer["cancelled"] or not self._running:
                        break
                    with self._lock:
                        if peer_id not in self._links:
                            break

                    payload = handle.read(FILE_CHUNK_BYTES)
                    if not payload:
                        completed = True
                        break

                    envelope = create_envelope(
                        "FILE_CHUNK",
                        self.client_id,
                        self.username,
                        room=transfer["room"],
                        data={
                            "transferId": transfer["id"],
                            "index": index,
                            "data": base64.b64encode(payload).decode("ascii"),
                        },
                    )
                    if not self._send_to(peer_id, envelope):
                        break

                    index += 1
                    entry["sent"] += len(payload)
                    transfer["lastActivity"] = now_ms()
                    self.on_event(
                        "file-progress",
                        transfer_id=transfer["id"],
                        name=transfer["name"],
                        received=entry["sent"],
                        size=transfer["size"],
                        direction="send",
                    )
        except OSError as error:
            completed = False
            self.on_event(
                "file-error",
                transfer_id=transfer["id"],
                text=f"could not read {transfer['name']} ({error})",
            )

        with self._lock:
            still_linked = peer_id in self._links
        if completed and not transfer["cancelled"] and self._running and still_linked:
            self._send_to(peer_id, create_envelope(
                "FILE_COMPLETE", self.client_id, self.username,
                room=transfer["room"], data={"transferId": transfer["id"]}))
            entry["phase"] = "done"
        else:
            entry["phase"] = "cancelled"
            if still_linked:
                self._send_to(peer_id, create_envelope(
                    "FILE_CANCEL", self.client_id, self.username,
                    room=transfer["room"], data={"transferId": transfer["id"]}))

        self._maybe_retire_outgoing(transfer)

    @staticmethod
    def _all_peers_settled(transfer):
        """True when no peer is still 'offered' or 'sending' on this offer."""
        return all(
            peer["phase"] not in ("offered", "sending")
            for peer in transfer["peers"].values()
        )

    def _maybe_retire_outgoing(self, transfer):
        """Drop a fully settled offer and report how it went."""
        with self._lock:
            if transfer["id"] not in self._outgoing:
                return
            if not self._all_peers_settled(transfer):
                return
            self._outgoing.pop(transfer["id"], None)
            peers = dict(transfer["peers"])

        accepted = sum(1 for peer in peers.values() if peer["phase"] == "done")
        self.on_event(
            "file-sent",
            transfer_id=transfer["id"],
            name=transfer["name"],
            size=transfer["size"],
            accepted=accepted,
            total=len(peers),
        )

    def _abort_transfers_for(self, client_id):
        """A peer vanished: stop sends to it and delete its partial downloads."""
        with self._lock:
            outgoing = list(self._outgoing.values())
            incoming = [
                transfer
                for transfer in self._incoming.values()
                if transfer["from"] == client_id
            ]

        for transfer in outgoing:
            entry = transfer["peers"].get(client_id)
            if entry is None:
                continue
            if entry["phase"] in ("sending", "offered"):
                entry["phase"] = "cancelled"
            if self._all_peers_settled(transfer):
                self._maybe_retire_outgoing(transfer)

        for transfer in incoming:
            self._abort_incoming(
                transfer, f"{transfer['fromUsername']} disconnected — transfer aborted"
            )

    def sweep_transfers(self, now=None):
        """Reap transfers nobody is feeding: partials deleted, offers cancelled."""
        now = now if now is not None else now_ms()
        with self._lock:
            stale_in = [
                (tid, transfer)
                for tid, transfer in self._incoming.items()
                if now - transfer["lastActivity"] > TRANSFER_IDLE_TIMEOUT_MS
            ]
            for tid, _ in stale_in:
                del self._incoming[tid]
            stale_out = [
                (tid, transfer)
                for tid, transfer in self._outgoing.items()
                if now - transfer["lastActivity"] > TRANSFER_IDLE_TIMEOUT_MS
            ]
            for tid, _ in stale_out:
                del self._outgoing[tid]

        for tid, transfer in stale_in:
            self._discard_incoming(transfer)
            self._send_transfer_control(
                "FILE_CANCEL", tid, transfer["room"], [transfer["from"]]
            )
            self.on_event(
                "file-error",
                transfer_id=tid,
                text=f"transfer of {transfer['name']} timed out — partial file deleted",
            )

        for tid, transfer in stale_out:
            transfer["cancelled"] = True
            self._send_transfer_control(
                "FILE_CANCEL", tid, transfer["room"], list(transfer["peers"])
            )
            self.on_event(
                "file-error",
                transfer_id=tid,
                text=f"offer of {transfer['name']} expired (no peer response)",
            )
