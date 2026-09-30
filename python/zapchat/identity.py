"""Long-term identity and TOFU key pinning (protocol v2).

Port of the npm client's design: the Ed25519 *identity* key is what makes
peers recognisable across connections. X25519 key agreement alone is
anonymous — anyone on the LAN can run it — but every v2 HELLO carries the
sender's identity public key and a signature over the ephemeral exchange.
The first time we talk to a client id we pin the identity key it used; later
connections must present the same key or the link is refused. That is what
makes an active man-in-the-middle detectable rather than silent.

The seed lives in the local config file (owner-readable); pins persist in
the same file and expire after `PEER_PIN_TTL_MS`, so a legitimately rebuilt
install is not wedged forever.
"""

import time

from .crypto import generate_identity_seed, identity_public_from_seed, public_key_id

# Seconds a peer's TOFU pin stays trusted after its last sighting.
PEER_PIN_TTL_MS = 365 * 24 * 60 * 60 * 1000


def new_identity_seed():
    """Fresh 32-byte Ed25519 identity seed."""
    return generate_identity_seed()


def identity_public_key(seed):
    """Raw 32-byte identity public key for a seed."""
    return identity_public_from_seed(seed)


def identity_key_id(seed):
    """Fingerprint of our identity public key (for /status display)."""
    return public_key_id(identity_public_from_seed(seed))


class PeerPinStore:
    """TOFU pin store: maps client id -> first-seen identity key id.

    The npm client refuses a v2 link when a client id shows up with a
    different identity key than the pinned one; this store answers the same
    three-way verdict.
    """

    def __init__(self):
        # client_id -> {"keyId": str, "seenAt": int}
        self._pins = {}

    def seed(self, entries):
        """Pre-load from the config file's `peerPins` field. Never throws."""
        if not isinstance(entries, dict):
            return
        for client_id, pin in entries.items():
            if not isinstance(client_id, str) or not 0 < len(client_id) <= 64:
                continue
            if not isinstance(pin, dict):
                continue
            key_id = pin.get("keyId")
            seen_at = pin.get("seenAt")
            if isinstance(key_id, str) and 0 < len(key_id) <= 64 and isinstance(seen_at, (int, float)) and not isinstance(seen_at, bool):
                self._pins[client_id] = {"keyId": key_id, "seenAt": int(seen_at)}

    def to_config(self):
        """Serialise back out for config persistence."""
        return {client_id: dict(pin) for client_id, pin in self._pins.items()}

    def check(self, client_id, key_id, now=None):
        """Check a peer's key id against the pin store.

        Returns 'ok' when the key matches a pin, 'new' on first contact (and
        records the pin), or 'mismatch' — the dangerous case: this client id
        has talked to us before with a *different* key, which is either a
        rebuilt install or someone impersonating them.
        """
        if now is None:
            now = int(time.time() * 1000)

        pin = self._pins.get(client_id)
        if pin is None or now - pin["seenAt"] > PEER_PIN_TTL_MS:
            # First contact, or a long-expired pin: record (or re-record) it.
            self._pins[client_id] = {"keyId": key_id, "seenAt": now}
            return "new"

        if pin["keyId"] == key_id:
            pin["seenAt"] = now  # refresh on every successful sighting
            return "ok"

        return "mismatch"
