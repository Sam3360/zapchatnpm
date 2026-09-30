"""Live integration test: two real zapchat processes chat over the LAN.

Spawns two CLI processes with separate config dirs, waits for them to
discover each other over UDP, then sends a message from each side and checks
both arrive. Mirrors the npm project's cli end-to-end test.
"""

import os
import subprocess
import threading
import sys
import tempfile
import time


def _find_exe():
    """The installed CLI: env override, then common venv spots, then PATH."""
    override = os.environ.get("ZAPCHAT_EXE")
    if override:
        return override
    candidates = [
        os.path.join(sys.prefix, "Scripts", "zapchat.exe"),
        os.path.join(sys.prefix, "bin", "zapchat"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return "zapchat"


EXE = _find_exe()


class Instance:
    """One spawned zapchat process with a single reader thread.

    Exactly one thread consumes the process's stdout into a shared list —
    a second iterating reader would steal lines and starve later assertions.
    """

    def __init__(self, name, room, config_dir):
        self.name = name
        self.process = subprocess.Popen(
            [EXE, "--name", name, "--room", room],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "ZAPCHAT_CONFIG_DIR": config_dir, "PYTHONUNBUFFERED": "1"},
        )
        self.lines = []
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in self.process.stdout:
            self.lines.append(line)

    def output(self):
        return "".join(self.lines)

    def wait_for(self, needle, timeout=20.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if needle in self.output():
                return True
            time.sleep(0.2)
        return False

    def send(self, text):
        self.process.stdin.write(text + "\n")
        self.process.stdin.flush()

    def stop(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        self.process.terminate()


def test_two_instances_chat():
    # The live test needs a runnable CLI. When ZAPCHAT_EXE is unset and the
    # resolved default is not our own Python CLI (e.g. the npm shim on PATH),
    # skip rather than test the wrong binary.
    import shutil

    resolved = os.environ.get("ZAPCHAT_EXE") or shutil.which("zapchat")
    if resolved is None or resolved.lower().endswith(".cmd"):
        import pytest

        pytest.skip("no Python zapchat CLI on PATH; set ZAPCHAT_EXE to run the live test")

    with tempfile.TemporaryDirectory() as tmp:
        alice = Instance("alice", "general", os.path.join(tmp, "a"))
        bob = Instance("bob", "general", os.path.join(tmp, "b"))

        try:
            # Discovery: each side should connect to the other within seconds.
            assert alice.wait_for("connected", timeout=30), f"alice never saw bob: {alice.output()!r}"
            assert bob.wait_for("connected", timeout=10), f"bob never saw alice: {bob.output()!r}"

            # Messages in both directions.
            alice.send("hello from alice")
            assert bob.wait_for("hello from alice", timeout=10), f"bob output: {bob.output()!r}"

            bob.send("hi alice, this is bob")
            assert alice.wait_for("hi alice, this is bob", timeout=10), f"alice output: {alice.output()!r}"

            # A /command runs locally without being sent as chat.
            alice.send("/rooms")
            assert alice.wait_for("general", timeout=5), f"alice output: {alice.output()!r}"

            # /status reports the live link count (the command was broken in
            # <= 5.0.0: it fell through the /me branch and never ran).
            alice.send("/status")
            assert alice.wait_for("peers: 1", timeout=5), f"alice output: {alice.output()!r}"
        finally:
            alice.stop()
            bob.stop()


if __name__ == "__main__":
    test_two_instances_chat()
    print("TWO-INSTANCE CHAT OK")
