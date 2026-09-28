"""UDP discovery: announce ourselves, listen for other instances.

Compatible with the npm client: the same multicast group and port, the same
ANNOUNCE envelope shape, beacons sent to multicast, subnet broadcast and
loopback so several instances work on one machine too.
"""

import json
import socket
import sys
import threading

from .protocol import (
    MAX_UDP_PACKET_BYTES,
    MAX_USERNAME_LENGTH,
    create_envelope,
    now_ms,
    parse_announce_data,
    parse_envelope,
)

MULTICAST_GROUP = "239.255.42.99"
DISCOVERY_PORT = 45912
ANNOUNCE_INTERVAL = 2.0
PEER_STALE_SECONDS = 7


class Peer:
    """Another instance seen on the LAN."""

    def __init__(self, client_id, username, room, port, addresses, last_seen):
        self.client_id = client_id
        self.username = username
        self.room = room
        self.port = port
        self.addresses = addresses
        self.last_seen = last_seen

    def fresh(self, now=None):
        return now_ms() - self.last_seen < PEER_STALE_SECONDS * 1000


class DiscoveryService:
    """Bind one UDP socket, send beacons, and keep a map of live peers."""

    def __init__(self, client_id, username, room, tcp_port, on_warning=None):
        self.client_id = client_id
        self.username = username
        self.room = room
        self.tcp_port = tcp_port
        self.on_warning = on_warning or (lambda message: None)

        self.peers = {}  # client_id -> Peer
        self.rooms = {}  # room name -> {"online": int, "seen": ms}
        self.beacons_sent = 0
        self.beacons_received = 0
        self.multicast_ok = False
        self.broadcast_ok = False

        self._sock = None
        self._running = False
        self._lock = threading.Lock()
        self._beacon_sources = {}  # client_id -> (ip, port) of last beacon
        self._owns_discovery_port = False
        self._replied_to = set()  # client ids we have unicast-replied to

    # ------------------------------------------------------------------ state

    def current_room(self):
        return self.room

    def set_state(self, username, room, tcp_port):
        """Update what our beacons advertise (called on any identity change)."""
        self.username = username
        self.room = room
        self.tcp_port = tcp_port

    def live_peers(self):
        """Fresh peers only, stale entries pruned."""
        now = now_ms()
        with self._lock:
            for client_id in [cid for cid, p in self.peers.items() if not p.fresh(now)]:
                del self.peers[client_id]
            return list(self.peers.values())

    def live_rooms(self):
        """Rooms advertised by anyone (including us), freshest counts win."""
        with self._lock:
            for peer in self.peers.values():
                if peer.fresh() and peer.room:
                    entry = self.rooms.setdefault(peer.room, {"online": 0, "seen": 0})
                    entry["seen"] = max(entry["seen"], peer.last_seen)
        return dict(self.rooms)

    # ----------------------------------------------------------------- socket

    def start(self):
        self._running = True
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if sys.platform != "win32":
                # On POSIX, REUSEADDR allows quick restarts and multi-process
                # multicast. On Windows it would let a second bind "succeed"
                # while unicast then reaches only the last binder — so there
                # we deliberately let the second bind fail and fall back.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("", DISCOVERY_PORT))
                self._owns_discovery_port = True
            except OSError:
                # Another instance owns the well-known port. Multicast (joined
                # below) still delivers to every member regardless of bind
                # port, which is what keeps several instances on one machine
                # working.
                sock.bind(("", 0))
                self.on_warning("another instance holds the discovery port; using multicast")

            self._sock = sock

            try:
                group = socket.inet_aton(MULTICAST_GROUP)
                mreq = group + socket.inet_aton("0.0.0.0")
                sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
                self.multicast_ok = True
            except OSError:
                self.on_warning("multicast unavailable; falling back to broadcast")

            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                self.broadcast_ok = True
            except OSError:
                pass

            threading.Thread(target=self._listen, daemon=True).start()
            threading.Thread(target=self._announce_loop, daemon=True).start()
            self.send_beacon()
        except OSError as error:
            self.on_warning(f"discovery unavailable: {error}")

    def stop(self):
        self._running = False
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    # ---------------------------------------------------------------- sending

    def beacon_targets(self):
        """Where beacons go: multicast, each subnet broadcast, and loopback."""
        targets = []
        if self.multicast_ok:
            targets.append((MULTICAST_GROUP, DISCOVERY_PORT))

        # Loopback unicast only helps when we (or a same-machine peer) own the
        # well-known port; the multicast path covers the other same-machine
        # instances.
        targets.append(("127.0.0.1", DISCOVERY_PORT))

        for address in self._local_addresses():
            broadcast = ".".join(address.split(".")[:-1]) + ".255"
            if broadcast not in [t[0] for t in targets]:
                targets.append((broadcast, DISCOVERY_PORT))

        if self.broadcast_ok and ("255.255.255.255", DISCOVERY_PORT) not in targets:
            targets.append(("255.255.255.255", DISCOVERY_PORT))

        return targets

    def _local_addresses(self):
        """Best-effort list of this machine's LAN IPv4 addresses."""
        addresses = []
        try:
            hostname = socket.gethostname()
            for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
                address = info[4][0]
                if address not in addresses and not address.startswith("127."):
                    addresses.append(address)
        except OSError:
            pass
        return addresses

    def build_beacon(self):
        local_port = self._sock.getsockname()[1] if self._sock is not None else 0
        return create_envelope(
            "ANNOUNCE",
            self.client_id,
            (self.username or "anon")[:MAX_USERNAME_LENGTH],
            room=self.room,
            data={
                "port": self.tcp_port,
                "addresses": self._local_addresses(),
                "rooms": [self.room] if self.room else [],
                # Where a unicast beacon reaches us directly (Python clients).
                "replyPort": local_port,
            },
        )

    def send_beacon(self):
        if self._sock is None:
            return
        packet = json.dumps(self.build_beacon(), separators=(",", ":")).encode("utf-8")[:MAX_UDP_PACKET_BYTES]
        for target in self.beacon_targets():
            try:
                self._sock.sendto(packet, target)
                self.beacons_sent += 1
            except OSError as error:
                self.on_warning(f"beacon to {target[0]} failed: {error}")

    def _announce_loop(self):
        import time

        while self._running:
            self.send_beacon()
            time.sleep(ANNOUNCE_INTERVAL)

    # -------------------------------------------------------------- receiving

    def _listen(self):
        while self._running:
            try:
                packet, address = self._sock.recvfrom(MAX_UDP_PACKET_BYTES * 2)
            except OSError:
                return

            try:
                raw = json.loads(packet.decode("utf-8", errors="replace"))
            except ValueError:
                continue

            envelope = parse_envelope(raw)
            if envelope is None:
                continue

            # Our own beacon echoing back from a multicast membership: skip it.
            if envelope["from"] == self.client_id:
                continue

            data = parse_announce_data(envelope["data"])
            if data is None:
                continue

            self.beacons_received += 1
            self._remember_peer(envelope, data, address)

    def _remember_peer(self, envelope, data, source_address):
        with self._lock:
            client_id = envelope["from"]
            peer = self.peers.get(client_id)
            if peer is None:
                peer = Peer(
                    client_id=client_id,
                    username=envelope["username"],
                    room=envelope["room"] or (data["rooms"][0] if data["rooms"] else None),
                    port=data["port"],
                    addresses=data["addresses"],
                    last_seen=now_ms(),
                )
            else:
                peer.username = envelope["username"]
                peer.room = envelope["room"] or peer.room
                peer.port = data["port"]
                if data["addresses"]:
                    peer.addresses = data["addresses"]
                peer.last_seen = now_ms()

            self.peers[client_id] = peer
            # Remember where the beacon came from so TCP can dial it even if
            # the advertised address list was empty.
            self._beacon_sources[client_id] = source_address[0]

            for room in data["rooms"] or ([peer.room] if peer.room else []):
                entry = self.rooms.setdefault(room, {"online": 0, "seen": 0})
                entry["seen"] = now_ms()

        # First contact: reply by direct unicast so the other side learns us
        # even when multicast/broadcast is unavailable (the Python protocol
        # carries a replyPort for exactly this; npm peers ignore it).
        if client_id not in self._replied_to and data["reply_port"]:
            self._replied_to.add(client_id)
            try:
                if self._sock is not None:
                    packet = json.dumps(self.build_beacon(), separators=(",", ":")).encode("utf-8")
                    self._sock.sendto(packet, (source_address[0], data["reply_port"]))
                    self.beacons_sent += 1
            except OSError:
                pass
