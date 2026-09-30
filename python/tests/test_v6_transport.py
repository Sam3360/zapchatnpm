"""In-process transport tests for the v6 dual-mode client.

These run two ChatClient instances against each other over real localhost
sockets: secure (v2) links by default, plaintext (v1) links only with
allow_plaintext, and refusal of legacy peers without the opt-in — the Python
mirror of the npm transport guarantees.
"""

import json
import socket
import time

from zapchat.client import ChatClient


class Harness:
    """A ChatClient bound to a free port with events recorded."""

    def __init__(self, name, allow_plaintext=False):
        self.name = name
        self.client = ChatClient(
            f"clid-{name}",
            name,
            get_room=lambda: "general",
            on_event=self._event,
            allow_plaintext=allow_plaintext,
        )
        self.events = []
        self.port = self.client.start(port_base=0)

    def _event(self, kind, **kwargs):
        self.events.append((kind, kwargs))

    def saw(self, kind, needle=None):
        for kind_, kwargs in self.events:
            if kind_ != kind:
                continue
            if needle is None or needle in json.dumps(kwargs, default=str):
                return True
        return False

    def stop(self):
        self.client.stop()


def wait_for(predicate, timeout=10.0, step=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return False


def test_two_clients_link_securely_and_chat():
    alice = Harness("alice")
    bob = Harness("bob")
    try:
        assert alice.client.connect_to("127.0.0.1", bob.port)

        assert wait_for(lambda: bob.saw("peer-connected")), "bob never saw alice"
        assert alice.client.link_modes() == {bob.client.client_id: "secure"}
        assert bob.client.link_modes() == {alice.client.client_id: "secure"}

        alice.client.send_chat("secure hello")
        assert wait_for(
            lambda: bob.saw("message", "secure hello")
        ), f"bob events: {bob.events!r}"

        bob.client.send_chat("secure reply")
        assert wait_for(lambda: alice.saw("message", "secure reply"))
    finally:
        alice.stop()
        bob.stop()


def test_actions_flow_over_secure_links():
    alice = Harness("alice")
    bob = Harness("bob")
    try:
        assert alice.client.connect_to("127.0.0.1", bob.port)
        assert wait_for(lambda: bob.saw("peer-connected"))

        alice.client.send_action("waves")
        assert wait_for(lambda: bob.saw("message", "ACTION waves"))
    finally:
        alice.stop()
        bob.stop()


def test_legacy_v1_peer_is_refused_without_opt_in():
    """A raw protocol-v1 peer (plain JSON HELLO) gets no link, no reply."""
    target = Harness("strict")
    try:
        sock = socket.create_connection(("127.0.0.1", target.port), timeout=5)
        hello = json.dumps(
            {
                "v": 1,
                "id": "legacy12345",
                "type": "HELLO",
                "ts": int(time.time() * 1000),
                "from": "clid-legacy",
                "username": "legacy",
                "room": "general",
                "data": {"port": 1, "addresses": ["127.0.0.1"]},
            }
        )
        sock.sendall((hello + "\n").encode())

        # The secure-only acceptor must close the socket without a HELLO.
        sock.settimeout(5.0)
        got_reply = sock.recv(4096) != b""
        assert not got_reply, "legacy peer received a reply without the opt-in"
        assert not wait_for(
            lambda: target.saw("peer-connected"), timeout=1.0
        ), "legacy peer was registered"
        sock.close()
    finally:
        target.stop()


def test_legacy_v1_peer_links_with_opt_in():
    """With allow_plaintext, a raw v1 peer links and chats (restamped to v1)."""
    target = Harness("friendly", allow_plaintext=True)
    try:
        sock = socket.create_connection(("127.0.0.1", target.port), timeout=5)
        hello = json.dumps(
            {
                "v": 1,
                "id": "legacy12345",
                "type": "HELLO",
                "ts": int(time.time() * 1000),
                "from": "clid-legacy",
                "username": "legacy",
                "room": "general",
                "data": {"port": 1, "addresses": ["127.0.0.1"]},
            }
        )
        sock.sendall((hello + "\n").encode())

        sock.settimeout(5.0)
        buffer = b""
        reply = None
        deadline = time.time() + 5
        while reply is None and time.time() < deadline:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
            for line in buffer.split(b"\n"):
                if not line.strip():
                    continue
                raw = json.loads(line.decode())
                if raw.get("type") == "HELLO":
                    reply = raw
                    break

        assert reply is not None, "plaintext opt-in never answered the HELLO"
        assert reply["v"] == 1, "our HELLO must be restamped to v1 for a legacy peer"

        # Their v1 chat message arrives.
        sock.sendall(
            (
                json.dumps(
                    {
                        "v": 1,
                        "id": "legacy12346",
                        "type": "MESSAGE",
                        "ts": int(time.time() * 1000),
                        "from": "clid-legacy",
                        "username": "legacy",
                        "room": "general",
                        "data": {"text": "plain hello"},
                    }
                )
                + "\n"
            ).encode()
        )
        assert wait_for(lambda: target.saw("message", "plain hello"))

        # And a chat reply is written back as a v1-stamped plain envelope.
        target.client.send_chat("plain reply")
        buffer = b""
        deadline = time.time() + 5
        saw_reply = False
        while time.time() < deadline:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
            for line in buffer.split(b"\n"):
                if not line.strip():
                    continue
                raw = json.loads(line.decode())
                if raw.get("type") == "MESSAGE" and raw.get("data", {}).get("text") == "plain reply":
                    assert raw["v"] == 1, "replies to a legacy peer must be v1-stamped"
                    saw_reply = True
            if saw_reply:
                break
        assert saw_reply, "never received the chat reply on the plain link"
        sock.close()
    finally:
        target.stop()


def test_dial_retries_plaintext_for_v1_peer_only_when_allowed():
    """Dialling a socket that never speaks v2: no retry without the flag.

    The retry is a fresh connection (same as the npm client's manual
    connect), so the fake legacy peer answers several connections.
    """
    import threading

    def serve_v1(listener, client_id, message_id):
        def handle(conn):
            try:
                conn.recv(4096)  # whatever they send (sealed or JSON)
                conn.sendall(
                    (
                        json.dumps(
                            {
                                "v": 1,
                                "id": message_id,
                                "type": "HELLO",
                                "ts": int(time.time() * 1000),
                                "from": client_id,
                                "username": "legacy",
                                "room": "general",
                                "data": {"port": 1, "addresses": ["127.0.0.1"]},
                            }
                        )
                        + "\n"
                    ).encode()
                )
                time.sleep(1.0)
            except OSError:
                pass
            finally:
                conn.close()

        for _ in range(3):
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(conn,), daemon=True).start()

    # A fake v1 responder: answers any connection with a v1 HELLO.
    responder = socket.socket()
    responder.bind(("127.0.0.1", 0))
    responder.listen(1)
    port = responder.getsockname()[1]
    threading.Thread(target=serve_v1, args=(responder, "clid-legacy", "legacy12345"), daemon=True).start()

    strict = Harness("strict-dial")
    try:
        # Without the opt-in the v1 reply must not produce a link.
        assert not strict.client.connect_to("127.0.0.1", port)
        assert not wait_for(lambda: strict.saw("peer-connected"), timeout=1.0)
    finally:
        strict.stop()
        responder.close()

    # Reset the responder for the opt-in run.
    responder2 = socket.socket()
    responder2.bind(("127.0.0.1", 0))
    responder2.listen(1)
    port2 = responder2.getsockname()[1]
    threading.Thread(target=serve_v1, args=(responder2, "clid-legacy2", "legacy22345"), daemon=True).start()

    lenient = Harness("lenient-dial", allow_plaintext=True)
    try:
        assert lenient.client.connect_to("127.0.0.1", port2)
        assert wait_for(lambda: lenient.client.link_modes().get("clid-legacy2") == "plain")
    finally:
        lenient.stop()
        responder2.close()


def test_tampered_secure_frame_drops_the_link():
    alice = Harness("tamper-a")
    bob = Harness("tamper-b")
    try:
        assert alice.client.connect_to("127.0.0.1", bob.port)
        assert wait_for(lambda: bob.saw("peer-connected"))

        # Corrupt the session's send key on alice's side: bob must reject the
        # next frame (AEAD failure) and drop the link.
        link = alice.client._links[bob.client.client_id]
        link["session"].send_key = bytes(32)

        alice.client.send_chat("should not land")
        assert wait_for(
            lambda: bob.saw("peer-gone"), timeout=10.0
        ), f"bob kept the link: {bob.events!r}"
        assert not bob.saw("message", "should not land")
    finally:
        alice.stop()
        bob.stop()


def test_beacon_classification_never_downgrades_to_legacy():
    """v6+ announces in v1 AND v2; arrival order must not re-classify."""
    from zapchat.discovery import DiscoveryService, Peer

    service = DiscoveryService("clid-self", "self", "general", tcp_port=1)
    envelope_v2 = {
        "v": 2,
        "id": "beacon0001",
        "type": "ANNOUNCE",
        "ts": int(time.time() * 1000),
        "from": "clid-peer",
        "username": "peer",
        "room": "general",
        "data": {"port": 1, "addresses": ["127.0.0.1"], "rooms": ["general"]},
    }
    envelope_v1 = {**envelope_v2, "v": 1}
    announce_data = {"port": 1, "addresses": [], "rooms": [], "reply_port": 0}

    service._remember_peer(envelope_v2, dict(announce_data), ("127.0.0.1", 1), wire_version=2)
    service._remember_peer(envelope_v1, dict(announce_data), ("127.0.0.1", 1), wire_version=1)
    # The v1 beacon (older clients, or our own dual announce) must not make a
    # v2-capable peer look legacy — that stalled the mesh in 6.0.0.
    assert service.peers["clid-peer"].wire_version == 2

    # A genuinely legacy peer stays legacy.
    peer = Peer("clid-other", "old", "general", 1, [], int(time.time() * 1000), wire_version=1)
    service.peers["clid-other"] = peer
    service._remember_peer(
        envelope_v1, dict(announce_data), ("127.0.0.1", 1), wire_version=1
    )
    assert service.peers["clid-other"].wire_version == 1
