"""Tests for the wire protocol helpers."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zapchat.protocol import (
    create_envelope,
    decode_frames,
    encode_envelope,
    parse_announce_data,
    parse_envelope,
    parse_message_data,
    sanitize_room_name,
    sanitize_username,
)


def test_roundtrip_envelope():
    sender = {"clientId": "zc-test-1234", "username": "sam"}
    envelope = create_envelope("MESSAGE", sender["clientId"], sender["username"], room="general", data={"text": "hi"})
    wire = encode_envelope(envelope)
    parsed, leftover = decode_frames(wire)
    assert leftover == ""
    assert len(parsed) == 1
    assert parsed[0]["type"] == "MESSAGE"
    assert parsed[0]["data"]["text"] == "hi"


def test_rejects_garbage():
    for bad in ["hello", None, [], 42]:
        assert parse_envelope(bad) is None


def test_rejects_wrong_version_and_types():
    envelope = create_envelope("PING", "zc-test-1234", "sam")
    assert parse_envelope({**envelope, "v": 99}) is None
    assert parse_envelope({**envelope, "type": "DROP TABLE"}) is None
    assert parse_envelope({**envelope, "from": "x"}) is None


def test_strips_control_characters():
    # ANSI styling is stripped and the remaining name is clean text —
    # matching the npm client's repair-don't-reject behaviour.
    assert sanitize_username("\x1b[31mhacker\x1b[0m\x07") == "hacker"
    text = parse_message_data({"text": "hi\x1b[31mthere"})
    assert text == "hithere"
    # Pure control garbage with no usable name is rejected.
    assert sanitize_username("\x07\x1b") is None


def test_room_names_are_normalised():
    assert sanitize_room_name("General") == "general"
    assert sanitize_room_name("bad/room") is None
    assert sanitize_room_name("") is None


def test_announce_parsing():
    data = parse_announce_data({"port": 45913, "addresses": ["192.168.1.5", "nope"], "rooms": ["general", "BAD/", 42]})
    assert data["port"] == 45913
    assert data["addresses"] == ["192.168.1.5"]
    assert data["rooms"] == ["general"]


def test_frames_split_across_chunks():
    first = encode_envelope(create_envelope("PING", "zc-test-1234", "sam"))
    second = encode_envelope(create_envelope("PONG", "zc-test-1234", "sam"))
    stream = first + second[:5]
    parsed, buffer = decode_frames(stream)
    assert len(parsed) == 1
    parsed2, buffer2 = decode_frames(second[5:].encode() if isinstance(second[5:], str) else second[5:], buffer)
    assert len(parsed2) == 1


def test_max_message_length():
    long_text = "x" * 1500
    result = parse_message_data({"text": long_text})
    assert result is not None
    assert len(result) <= 1000
    assert parse_message_data({"text": "x" * 5000}) is None
