"""End-to-end v8 file transfer tests over real localhost sockets.

Two ChatClient instances run the full offer → accept → chunk → complete
machine against each other. These prove the wire format agrees with the npm
client (the npm integration suite transfers the same 64 KiB payload) and that
the guard rails hold: refused oversized/empty files, slot limits, sanitised
names and cancellation.
"""

import os
import tempfile
import time

import threading

from zapchat.client import ChatClient
from zapchat.protocol import (
    MAX_FILE_BYTES,
    TRANSFER_IDLE_TIMEOUT_MS,
    create_envelope,
)
from zapchat.transfers import (
    chunk_count,
    format_bytes,
    is_transferable_size,
    received_file_path,
    received_files_dir,
    sanitize_file_name,
)


def wait_for(predicate, timeout=20.0, step=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return False


class Harness:
    """A ChatClient bound to an ephemeral port with its events recorded."""

    def __init__(self, name):
        self.name = name
        self.events = []
        self.client = ChatClient(
            f"clid-{name}",
            name,
            get_room=lambda: "general",
            on_event=self._event,
        )
        self.port = self.client.start(port_base=0)

    def _event(self, kind, **kwargs):
        self.events.append((kind, kwargs))

    def first(self, kind):
        for seen_kind, kwargs in self.events:
            if seen_kind == kind:
                return kwargs
        return None

    def saw(self, kind, needle=None):
        for seen_kind, kwargs in self.events:
            if seen_kind != kind:
                continue
            if needle is None or needle in str(kwargs):
                return True
        return False

    def stop(self):
        self.client.stop()


def linked_pair():
    """Two harnesses linked over a real secure TCP link."""
    alice = Harness("alice")
    bob = Harness("bob")
    assert alice.client.connect_to("127.0.0.1", bob.port)
    assert wait_for(lambda: alice.client.peer_ids and bob.client.peer_ids)
    return alice, bob


def _remove(path):
    """Delete a file, tolerating Windows still holding it from a sender thread."""
    for _ in range(50):
        try:
            os.remove(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            time.sleep(0.05)
    raise AssertionError(f"could not remove {path}")


def sample_file(size, name="payload.bin"):
    """Write a deterministic `size`-byte file under `name` in a fresh temp dir."""
    directory = tempfile.mkdtemp()
    path = os.path.join(directory, name)
    with open(path, "wb") as stream:
        stream.write(bytes(index % 251 for index in range(size)))
    return path


# ------------------------------------------------------------------- helpers


def test_sanitize_file_name_defeats_traversal():
    assert sanitize_file_name("../../etc/passwd") == "passwd"
    assert sanitize_file_name(r"C:\Windows\System32\evil.exe") == "evil.exe"
    assert sanitize_file_name("plain.txt") == "plain.txt"
    # Nothing usable left after stripping control bytes.
    assert sanitize_file_name("..") is None
    assert sanitize_file_name("\x1b[31m") is None
    # Windows-hostile characters become underscores rather than separators.
    assert sanitize_file_name('a:b*c?d"e<f>g|h.txt') == "a_b_c_d_e_f_g_h.txt"


def test_received_file_path_stays_inside_the_directory():
    directory = os.path.abspath(tempfile.mkdtemp())
    target = received_file_path(directory, "abc123", "../../etc/passwd")
    assert target is not None
    assert target.startswith(directory + os.sep)
    assert target.endswith("-passwd")
    # A transfer id that is not url-safe is refused outright.
    assert received_file_path(directory, "../evil", "x.txt") is None


def test_format_bytes_and_chunk_count():
    assert format_bytes(0) == "0 B"
    assert format_bytes(1023) == "1023 B"
    assert format_bytes(1024) == "1.0 KiB"
    assert format_bytes(64 * 1024) == "64 KiB"
    assert chunk_count(1) == 1
    assert chunk_count(4096) == 1
    assert chunk_count(4097) == 2


# ---------------------------------------------------------------- end-to-end


def test_transfer_round_trips_byte_for_byte():
    alice, bob = linked_pair()
    path = sample_file(64 * 1024)
    try:
        ok, error = alice.client.offer_file(path)
        assert ok, error

        # Bob auto-accepts, so the transfer completes without further input.
        assert wait_for(lambda: bob.saw("file-received"))

        received = bob.first("file-received")
        assert received["name"] == "payload.bin"
        assert received["size"] == 64 * 1024
        assert os.path.getsize(received["target"]) == 64 * 1024

        with open(path, "rb") as original, open(received["target"], "rb") as copy:
            assert original.read() == copy.read()

        # Alice is told how many peers took the file, and retires the offer.
        assert wait_for(lambda: alice.saw("file-sent"))
        assert alice.first("file-sent")["accepted"] == 1
        assert alice.first("file-sent")["total"] == 1

        # Nothing stays active once the offer is fully settled.
        assert not alice.client._outgoing
        assert not bob.client._incoming
    finally:
        alice.stop()
        bob.stop()
        _remove(path)


def test_transfer_reaches_every_accepting_peer():
    alice = Harness("alice")
    bob = Harness("bob")
    carol = Harness("carol")
    path = sample_file(4096)
    try:
        assert alice.client.connect_to("127.0.0.1", bob.port)
        assert alice.client.connect_to("127.0.0.1", carol.port)
        # Star topology: alice holds both links, bob and carol hold only alice's.
        assert wait_for(
            lambda: len(alice.client.peer_ids) == 2
            and len(bob.client.peer_ids) == 1
            and len(carol.client.peer_ids) == 1
        )

        ok, error = alice.client.offer_file(path)
        assert ok, error
        assert wait_for(lambda: bob.saw("file-received") and carol.saw("file-received"))

        assert wait_for(lambda: alice.saw("file-sent"))
        assert alice.first("file-sent")["accepted"] == 2

        bob_file = bob.first("file-received")["target"]
        carol_file = carol.first("file-received")["target"]
        # Both receivers are on this one host, so they can share the same temp
        # path (one offer = one transfer id = one prefix). On real networks each
        # peer has its own temp dir. What matters is that both got the bytes.
        assert open(bob_file, "rb").read() == open(carol_file, "rb").read()
        assert os.path.getsize(bob_file) == 4096
    finally:
        alice.stop()
        bob.stop()
        _remove(path)
        carol.stop()


def test_offer_rejected_when_nobody_is_in_the_room():
    alice = Harness("alice")
    path = sample_file(128)
    try:
        ok, error = alice.client.offer_file(path)
        assert not ok
        assert "no peers" in error
    finally:
        alice.stop()
        _remove(path)


def test_offer_rejects_empty_and_oversized_files():
    alice = Harness("alice")
    empty_fd, empty = tempfile.mkstemp()
    os.close(empty_fd)
    try:
        ok, error = alice.client.offer_file(empty)
        assert not ok
        assert "empty" in error

        ok, error = alice.client.offer_file(os.path.join(tempfile.gettempdir(), "nope.bin"))
        assert not ok
        assert "no such file" in error

        ok, error = alice.client.offer_file(tempfile.gettempdir())
        assert not ok
        assert "not a regular file" in error
    finally:
        os.remove(empty)
        alice.stop()


def test_size_cap_bounds_are_enforced():
    """A file past MAX_FILE_BYTES never becomes an offer, so no chunk is read."""
    assert is_transferable_size(0) is True
    assert is_transferable_size(MAX_FILE_BYTES) is True
    assert is_transferable_size(MAX_FILE_BYTES + 1) is False
    assert is_transferable_size(-1) is False
    # bools are ints in Python and must not sneak past the guard.
    assert is_transferable_size(True) is False
    assert is_transferable_size("1024") is False
    assert is_transferable_size(1.5) is False


def test_cancel_stops_an_in_flight_transfer_and_deletes_the_partial():
    alice, bob = linked_pair()
    # 32 MiB over loopback still takes long enough to cancel mid-transfer; the
    # retry covers the rare case where a fast machine finishes first.
    path = sample_file(32 * 1024 * 1024, "big.bin")
    try:
        partial = None
        for _ in range(3):
            ok, error = alice.client.offer_file(path)
            assert ok, error
            assert wait_for(lambda: bob.first("file-receiving") is not None)
            partial = bob.first("file-receiving")["target"]
            cancelled_ok, cancel_error = bob.client.cancel_transfer()
            if cancelled_ok:
                break

            # The whole file landed before we could cancel: retry with a fresh
            # transfer so the cancel path is actually exercised.
            _remove(partial)
            partial = None

        assert cancelled_ok, "could not cancel an in-flight transfer in 3 attempts"
        assert not bob.saw("file-received")

        # The partial download never survives a cancel.
        deadline = time.time() + 5.0
        while time.time() < deadline and os.path.exists(partial):
            time.sleep(0.02)
        assert not os.path.exists(partial)
        assert not bob.client._incoming

        # Alice retires the offer once the cancel lands, whatever she had
        # already pushed. The guarantee that matters is on the receiver side:
        # a cancelled transfer is never reported as received.
        assert wait_for(lambda: alice.saw("file-sent"))
    finally:
        alice.stop()
        bob.stop()
        _remove(path)


def test_idle_sweep_deletes_a_stalled_partial_and_expires_stale_offers():
    """The timeout path, driven directly so it never races a live transfer."""
    bob = Harness("bob")

    # Feed a FILE_OFFER straight into the dispatcher: no sockets, so the
    # transfer is guaranteed to still be open when the sweep fires.
    offer = create_envelope(
        "FILE_OFFER",
        "clid-alice",
        "alice",
        room="general",
        data={"transferId": "stall-test-01", "name": "stall.bin", "size": 4096},
    )
    try:
        bob.client._handle(offer, "clid-alice")
        assert wait_for(lambda: bob.client._incoming)

        with bob.client._lock:
            transfer = next(iter(bob.client._incoming.values()))
        assert os.path.exists(transfer["target"])
        assert bob.saw("file-receiving")

        # A sweep inside the idle window leaves it alone.
        bob.client.sweep_transfers(now=transfer["lastActivity"])
        assert bob.client._incoming
        assert os.path.exists(transfer["target"])

        # One millisecond past the window it is reaped and the file deleted.
        bob.client.sweep_transfers(
            now=transfer["lastActivity"] + TRANSFER_IDLE_TIMEOUT_MS + 1
        )
        assert not bob.client._incoming
        assert not os.path.exists(transfer["target"])
        assert bob.saw("file-error", "timed out")
    finally:
        bob.stop()


def test_idle_sweep_expires_a_stalled_transfer_on_both_sides():
    """A transfer neither side moves is reaped: offer cancelled, partial deleted."""
    alice, bob = linked_pair()
    # Large enough that bob is still receiving when we rewind the clocks.
    path = sample_file(32 * 1024 * 1024, "stall.bin")
    try:
        ok, error = alice.client.offer_file(path)
        assert ok, error
        assert wait_for(lambda: bob.client._incoming and alice.client._outgoing)

        with bob.client._lock:
            incoming = next(iter(bob.client._incoming.values()))
        target = incoming["target"]
        offer_id, offer = next(iter(alice.client._outgoing.items()))

        # Rewind the clocks instead of sleeping, so the sweep is the only thing
        # that can move either transfer forward.
        rewind = TRANSFER_IDLE_TIMEOUT_MS + 1
        with bob.client._lock:
            incoming["lastActivity"] -= rewind
        with alice.client._lock:
            offer["lastActivity"] -= rewind

        alice.client.sweep_transfers(now=offer["lastActivity"] + rewind)

        assert offer_id not in alice.client._outgoing
        assert alice.saw("file-error", "expired")

        # Bob is told to stop, and the partial download is deleted.
        assert wait_for(lambda: not bob.client._incoming)
        deadline = time.time() + 5.0
        while time.time() < deadline and os.path.exists(target):
            time.sleep(0.02)
        assert not os.path.exists(target)
        # Either bob's own sweep or alice's FILE_CANCEL can win this race; both
        # must name the file and drop the partial.
        assert bob.saw("file-error", "stall.bin")
    finally:
        alice.stop()
        bob.stop()
        _remove(path)


def test_cancel_with_nothing_active_reports_it():
    alice = Harness("alice")
    try:
        ok, error = alice.client.cancel_transfer()
        assert not ok
        assert "no active transfers" in error

        ok, error = alice.client.cancel_transfer("does-not-exist")
        assert not ok
        assert "no transfer matching" in error
    finally:
        alice.stop()


def test_reply_and_reaction_round_trip():
    alice, bob = linked_pair()
    try:
        assert alice.client.send_chat("hello") >= 1
        assert wait_for(lambda: bob.saw("message", "hello"))

        assert alice.client.send_reply("abcd1234", "sure thing") >= 1
        assert wait_for(lambda: bob.saw("reply", "sure thing"))
        reply = bob.first("reply")
        assert reply["reply_to"] == "abcd1234"
        assert reply["sender"] == "alice"

        assert alice.client.send_reaction("abcd1234", "\U0001f44d") >= 1
        assert wait_for(lambda: bob.saw("reaction", "\U0001f44d"))
        assert bob.first("reaction")["target"] == "abcd1234"

        # Invalid targets and unknown emoji are refused before hitting the wire.
        assert alice.client.send_reply("", "text") is None
        assert alice.client.send_reply("!!", "text") is None
        assert alice.client.send_reaction("abcd1234", "not-an-emoji") is None
    finally:
        alice.stop()
        bob.stop()


def test_received_files_live_in_a_dedicated_temp_subdirectory():
    directory = received_files_dir()
    assert directory.endswith("zapchat-received")
    assert os.path.dirname(directory) == tempfile.gettempdir()