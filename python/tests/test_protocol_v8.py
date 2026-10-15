import time

from zapchat.protocol import (
    parse_envelope,
    parse_reply_data,
    parse_reaction_data,
    parse_file_offer_data,
    parse_file_chunk_data,
    RECEIVED_FILES_DIR,
    MAX_FILE_BYTES,
    MAX_FILE_CHUNKS,
    MAX_REACTION_CHARS,
)


def _now():
    return int(time.time() * 1000)


def test_parse_reply_data_keeps_valid():
    text, reply_to = parse_reply_data({"text": "see above", "replyTo": "aBc12345"})
    assert text == "see above"
    assert reply_to == "aBc12345"


def test_parse_reply_data_rejects_short_reply_to():
    assert parse_reply_data({"text": "hi", "replyTo": "abc"}) == (None, None)


def test_parse_reaction_data_accepts_allowed():
    target, reaction = parse_reaction_data({"target": "aBc12345", "reaction": "+1"})
    assert target == "aBc12345"
    assert reaction == "+1"


def test_parse_reaction_data_rejects_outside_set():
    assert parse_reaction_data({"target": "aBc12345", "reaction": ":-)"}) == (None, None)


def test_parse_reaction_data_rejects_too_long():
    assert parse_reaction_data({"target": "aBc12345", "reaction": "a" * (MAX_REACTION_CHARS + 1)}) == (None, None)


def test_parse_file_offer_sanitises_path_traversal():
    offer = parse_file_offer_data({"transferId": "transfer-001", "name": "../etc/passwd", "size": 100})
    assert offer is not None
    assert offer["name"] == "passwd"


def test_parse_file_offer_rejects_dot_only():
    assert parse_file_offer_data({"transferId": "transfer-001b", "name": "..", "size": 100}) is None


def test_parse_file_offer_rejects_empty_name():
    assert parse_file_offer_data({"transferId": "transfer-001c", "name": "", "size": 100}) is None


def test_parse_file_offer_rejects_size_over_cap():
    assert parse_file_offer_data({"transferId": "t", "name": "big.bin", "size": MAX_FILE_BYTES + 1}) is None


def test_parse_file_chunk_accepts_valid():
    chunk = parse_file_chunk_data({"transferId": "transfer-003", "index": 0, "data": "AA=="})
    assert chunk is not None
    assert chunk["index"] == 0


def test_parse_file_chunk_rejects_out_of_range_index():
    assert parse_file_chunk_data({"transferId": "t", "index": MAX_FILE_CHUNKS, "data": "AA=="}) is None


def test_parse_envelope_accepts_reply():
    env = parse_envelope({
        "v": 2,
        "id": "aBc123456789",
        "type": "REPLY",
        "ts": _now(),
        "from": "zc-valid-id",
        "username": "sam",
        "room": "general",
        "data": {"text": "quoted", "replyTo": "aBc12345"},
    })
    assert env is not None
    assert env["type"] == "REPLY"


def test_parse_envelope_accepts_reaction():
    env = parse_envelope({
        "v": 2,
        "id": "aBc123456789",
        "type": "REACTION",
        "ts": _now(),
        "from": "zc-valid-id",
        "username": "sam",
        "room": "general",
        "data": {"target": "aBc12345", "reaction": "❤"},
    })
    assert env is not None
    assert env["type"] == "REACTION"


def test_parse_envelope_accepts_file_offer():
    env = parse_envelope({
        "v": 2,
        "id": "aBc123456789",
        "type": "FILE_OFFER",
        "ts": _now(),
        "from": "zc-valid-id",
        "username": "sam",
        "room": "general",
        "data": {"transferId": "transfer-004", "name": "doc.pdf", "size": 500},
    })
    assert env is not None
    assert env["type"] == "FILE_OFFER"


def test_parse_envelope_accepts_file_control():
    for msg_type in ("FILE_ACCEPT", "FILE_REJECT", "FILE_COMPLETE", "FILE_CANCEL"):
        env = parse_envelope({
            "v": 2,
            "id": "aBc123456789",
            "type": msg_type,
            "ts": _now(),
            "from": "zc-valid-id",
            "username": "sam",
            "room": "general",
            "data": {"transferId": "transfer-005"},
        })
        assert env is not None, f"should accept {msg_type}"
        assert env["type"] == msg_type


def test_parse_reaction_data_rejects_outside_set_on_parse():
    # A reaction outside REACTION_SET is rejected at the payload parser level,
    # so no valid REACTION envelope can carry it on the wire.
    assert parse_reaction_data({"target": "aBc12345", "reaction": "notallowed"}) == (None, None)


def test_constants_parity():
    assert RECEIVED_FILES_DIR == "zapchat-received"
    assert MAX_FILE_BYTES > 0
    assert MAX_FILE_CHUNKS > 0
