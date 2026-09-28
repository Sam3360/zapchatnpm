"""Live npm<->Python interop test: real npm client meets the Python client.

Requires the built npm CLI (ZAPCHAT_NPM_EXE) and an installed Python CLI
(ZAPCHAT_EXE). Skips when either is missing so unit-only environments stay
green. This is the end-to-end check for the v5 beacon + plaintext work:
discovery must bridge versions, and with --allow-plaintext both sides chat.
"""

import os
import shutil
import subprocess
import tempfile
import threading
import time

import pytest


def _find_npm_exe():
    override = os.environ.get("ZAPCHAT_NPM_EXE")
    if override:
        # Allow "node C:/path/main.js" (runner + script) as well as a bare exe.
        return override.split() if " " in override else override
    candidates = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "dist", "cli", "main.js"),
    ]
    for candidate in candidates:
        candidate = os.path.abspath(candidate)
        if os.path.exists(candidate):
            return ["node", candidate]
    return None


def _find_py_exe():
    override = os.environ.get("ZAPCHAT_EXE")
    if override:
        return override
    resolved = shutil.which("zapchat")
    if resolved and not resolved.lower().endswith(".cmd"):
        return resolved
    return None


def _npm_available():
    npm_exe = _find_npm_exe()
    if npm_exe is None:
        return False
    try:
        subprocess.run(
            npm_exe if isinstance(npm_exe, list) else [npm_exe],
            capture_output=True,
            timeout=30,
            input="",
            text=True,
        )
        return True
    except (OSError, subprocess.TimeoutExpired):
        return False


NPM_EXE = _find_npm_exe()
PY_EXE = _find_py_exe()


class Instance:
    """One spawned CLI process (npm or Python) with a single reader thread.

    `--headless` is an npm-only flag: the Python CLI is line-based on stdin by
    default, so it must be started without it.
    """

    def __init__(self, exe, name, config_dir, extra_args=(), headless=True):
        command = list(exe) if isinstance(exe, list) else [exe]
        flags = ["--headless"] if headless else []
        self.process = subprocess.Popen(
            command + flags + ["--name", name, "--room", "general"] + list(extra_args),
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

    def wait_for(self, needle, timeout=30.0):
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


needs_both = pytest.mark.skipif(
    NPM_EXE is None or PY_EXE is None,
    reason="needs ZAPCHAT_NPM_EXE (built npm CLI) and ZAPCHAT_EXE (Python CLI)",
)


@needs_both
def test_npm_and_python_discover_and_chat():
    with tempfile.TemporaryDirectory() as tmp:
        # npm starts first and owns the shared UDP discovery port; the Python
        # client then falls back to multicast-only beacons, which npm still
        # receives. Starting both at once makes the port race nondeterministic.
        npm = Instance(NPM_EXE, "npm-alice", os.path.join(tmp, "npm"), ["--allow-plaintext"])
        assert npm.wait_for("listening tcp", timeout=15), f"npm never started: {npm.output()!r}"
        time.sleep(1)
        python = Instance(PY_EXE, "py-bob", os.path.join(tmp, "py"), headless=False)

        try:
            # Beacon interop: each side must discover the other.
            assert npm.wait_for("connected", timeout=40), f"npm output: {npm.output()!r}"
            assert python.wait_for("connected", timeout=15), f"python output: {python.output()!r}"

            # Cross-stack chat in both directions.
            npm.send("hello from npm")
            assert python.wait_for("hello from npm", timeout=15), f"python output: {python.output()!r}"

            python.send("hello from python")
            assert npm.wait_for("hello from python", timeout=15), f"npm output: {npm.output()!r}"
        finally:
            npm.stop()
            python.stop()


@needs_both
def test_python_dials_older_npm_without_flag():
    """Without --allow-plaintext the npm client still discovers (beacons) but
    must NOT open an unencrypted chat link to the v1 Python peer."""
    with tempfile.TemporaryDirectory() as tmp:
        npm = Instance(NPM_EXE, "npm-strict", os.path.join(tmp, "npm"))
        assert npm.wait_for("listening tcp", timeout=15), f"npm never started: {npm.output()!r}"
        time.sleep(1)
        python = Instance(PY_EXE, "py-carol", os.path.join(tmp, "py"), headless=False)

        try:
            # Give discovery time, then confirm no encrypted link was claimed.
            time.sleep(12)
            assert "connected to py-carol" not in npm.output(), (
                f"npm linked without the flag: {npm.output()!r}"
            )
        finally:
            npm.stop()
            python.stop()
