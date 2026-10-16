"""Tests for durable chat history (v8.1) — Python twin of the npm suite."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zapchat.history import HISTORY_LIMIT, HistoryStore
from zapchat.cli import ChatApp


def temp_dir(tmp_path):
    return str(tmp_path / "cfg")


def chat(message_id="c1", room="general", text="hello", **overrides):
    message = {
        "id": message_id,
        "room": room,
        "kind": "chat",
        "text": text,
        "username": "sam",
        "ts": 1_700_000_000_000,
        "self": False,
    }
    message.update(overrides)
    return message


class TestStoreBasics:
    def test_round_trips_oldest_first(self, tmp_path):
        store = HistoryStore(temp_dir(tmp_path))
        store.append(chat("c1"))
        store.append(chat("c2"))
        loaded = store.load("general")
        assert [m["id"] for m in loaded] == ["c1", "c2"]

    def test_never_persists_system_notices(self, tmp_path):
        store = HistoryStore(temp_dir(tmp_path))
        store.append(chat("s1", kind="system", text="sam joined #general"))
        store.append(chat("c1"))
        assert [m["id"] for m in store.load("general")] == ["c1"]

    def test_bounded_on_disk_as_well_as_in_memory(self, tmp_path):
        directory = temp_dir(tmp_path)
        store = HistoryStore(directory, limit=3)
        for index in range(1, 6):
            store.append(chat(f"c{index}"))
        assert [m["id"] for m in store.load("general")] == ["c3", "c4", "c5"]

        # A fresh instance reads straight from disk: the file itself was
        # rewritten bounded, not merely the in-memory view.
        reread = HistoryStore(directory, limit=3)
        assert [m["id"] for m in reread.load("general")] == ["c3", "c4", "c5"]

    def test_skips_torn_or_garbage_lines(self, tmp_path):
        directory = temp_dir(tmp_path)
        store = HistoryStore(directory)
        store.append(chat("c1"))
        store.append(chat("c3"))
        with open(os.path.join(directory, "history", "general.jsonl"), "a", encoding="utf-8") as handle:
            handle.write('{"id":"c4","room":"gen')
        assert [m["id"] for m in store.load("general")] == ["c1", "c3"]

    def test_clear_room_deletes_the_file(self, tmp_path):
        directory = temp_dir(tmp_path)
        store = HistoryStore(directory)
        store.append(chat("c1"))
        store.clear_room("general")
        assert store.load("general") == []
        assert not os.path.exists(os.path.join(directory, "history", "general.jsonl"))

    def test_cannot_escape_its_directory(self, tmp_path):
        directory = temp_dir(tmp_path)
        store = HistoryStore(directory)
        store.append(chat("c1", room="../../evil"))
        assert store.load("../../evil") == []
        assert not os.path.exists(os.path.join(directory, "..", "..", "evil.jsonl"))
        assert store.rooms() == []

    def test_default_limit_matches_npm(self):
        assert HISTORY_LIMIT == 400


@pytest.fixture()
def app(tmp_path, capsys):
    application = ChatApp(
        username="sam",
        room="general",
        client_id="zc-test",
        no_discovery=True,
        history_store=HistoryStore(str(tmp_path / "cfg")),
    )
    application._print = lambda line: None  # silence stdout; capsys not needed
    return application


class TestChatAppWiring:
    def test_incoming_message_is_persisted(self, app, tmp_path):
        app._on_event("message", sender="pypeer", text="hi", message_id="m1", room="general", ts=1000)
        loaded = HistoryStore(str(tmp_path / "cfg")).load("general")
        assert [m["text"] for m in loaded] == ["hi"]
        assert loaded[0]["self"] is False

    def test_outgoing_message_is_persisted_with_self_true(self, app, tmp_path):
        app._on_event(
            "message-sent",
            envelope={"id": "m2", "room": "general", "ts": 2000, "username": "sam", "data": {"text": "hi there"}},
        )
        loaded = HistoryStore(str(tmp_path / "cfg")).load("general")
        assert [m["text"] for m in loaded] == ["hi there"]
        assert loaded[0]["self"] is True

    def test_action_is_persisted_rendered(self, app, tmp_path):
        framed = '\x01ACTION waves\x01'
        app._on_event(
            "message-sent",
            envelope={"id": "m3", "room": "general", "ts": 3000, "username": "sam", "data": {"text": framed}},
        )
        loaded = HistoryStore(str(tmp_path / "cfg")).load("general")
        assert loaded[0]["text"] == "* sam waves"

    def test_restore_replays_and_feeds_ids(self, app, tmp_path, capsys):
        store = HistoryStore(str(tmp_path / "cfg"))
        store.append(chat("m1", text="before restart"))
        app._restored_keys.clear()
        output = []
        app._print = output.append
        app._restore_history()
        assert any("1 chat message restored" in line for line in output)
        assert any("before restart" in line for line in output)
        # Restored lines are /reply targets.
        assert any(entry[0] == "m1" for entry in app._recent)

    def test_clear_wipes_persisted_copy(self, app, tmp_path):
        app._on_event("message-sent", envelope={"id": "m2", "room": "general", "ts": 2000, "username": "sam", "data": {"text": "wipe me"}})
        app.run_command("/clear")
        assert HistoryStore(str(tmp_path / "cfg")).load("general") == []
        assert app._recent == []

    def test_no_history_store_persists_nothing(self, tmp_path):
        silent = ChatApp(
            username="sam",
            room="general",
            client_id="zc-test",
            no_discovery=True,
            history_store=None,
        )
        silent._print = lambda line: None
        silent._on_event("message", sender="pypeer", text="hi", message_id="m1", room="general", ts=1000)
        directory = os.path.join(str(tmp_path / "cfg"), "history")
        assert not os.path.isdir(directory) or os.listdir(directory) == []
