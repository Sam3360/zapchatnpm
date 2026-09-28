"""Tests for the CTCP-style action (/me) codec and receive-path handling."""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zapchat.protocol import (
    ACTION_BYTE,
    action_body,
    encode_action_message,
    is_action_message,
    parse_message_data,
    render_action,
)


def test_frames_and_identifies_an_action():
    framed = encode_action_message("waves hello")
    assert framed == f"{ACTION_BYTE}ACTION waves hello{ACTION_BYTE}"
    assert is_action_message(framed)
    assert action_body(framed) == "waves hello"


def test_rejects_empty_actions():
    assert encode_action_message("") is None
    assert encode_action_message("   ") is None
    assert encode_action_message(None) is None


def test_does_not_mistake_ordinary_text_for_actions():
    assert not is_action_message("hello there")
    assert not is_action_message(f"{ACTION_BYTE}ACTION no trailing marker")
    assert not is_action_message(f"{ACTION_BYTE}ACTION{ACTION_BYTE}")


def test_renders_with_sender_as_subject():
    framed = encode_action_message("waves hello")
    assert render_action("sam", framed) == "* sam waves hello"


def test_survives_the_wire():
    framed = encode_action_message("waves")
    parsed = parse_message_data({"text": framed})
    assert parsed is not None
    assert is_action_message(parsed)
    assert action_body(parsed) == "waves"


def test_strips_hostile_content_inside_action_body():
    hostile = f"{ACTION_BYTE}ACTION hi\x1b[31mthere{ACTION_BYTE}"
    parsed = parse_message_data({"text": hostile})
    assert parsed is not None
    assert is_action_message(parsed)
    # Same behaviour as the npm sanitiser: ANSI removed with no space left.
    assert action_body(parsed) == "hithere"


def test_stray_control_byte_in_plain_chat_is_not_an_action():
    stray = parse_message_data({"text": f"hello {ACTION_BYTE} world"})
    # The control byte is stripped (Python keeps inner spacing as-is; npm also
    # collapses whitespace) — either way it cannot render as a framed action.
    assert stray == "hello  world"

    prefix_only = parse_message_data({"text": f"{ACTION_BYTE}ACTION sneaky"})
    assert prefix_only == "ACTION sneaky"


def test_framed_action_survives_json_roundtrip():
    """The 0x01 bytes must survive JSON encoding/decoding unchanged."""
    import json

    framed = encode_action_message("waves")
    data = {"text": framed}
    text = parse_message_data(json.loads(json.dumps(data)))
    assert text == framed
