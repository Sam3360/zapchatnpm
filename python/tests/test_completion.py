"""Tests for the Python tab-completion module (v7)."""

from zapchat.completion import COMMAND_WORDS, TabCompleter, completions_for

MEMBERS = ("sam", "sasha", "alex")
ROOMS = ("general", "gaming", "lounge")


class TestCompletionsFor:
    def test_completes_command_from_prefix(self):
        assert completions_for("/jo") == ["/join"]

    def test_completes_aliases(self):
        assert completions_for("/wh") == ["/who"]

    def test_keeps_leading_slash(self):
        assert completions_for("/st") == ["/status"]

    def test_rotates_command_matches_sorted(self):
        # /clear and /connect both start with c; no /create on this stack.
        assert completions_for("/c") == ["/clear", "/connect"]

    def test_never_completes_plain_chat_into_command(self):
        assert completions_for("me too") == []
        assert completions_for("sa") == []

    def test_bare_slash_has_no_matches(self):
        assert completions_for("/") == []

    def test_unknown_command_prefix(self):
        assert completions_for("/zz") == []

    def test_completes_member_on_later_word(self):
        assert completions_for("/me waves sa", MEMBERS) == ["sam", "sasha"]

    def test_keeps_at_prefix(self):
        assert completions_for("hey @sa", MEMBERS) == ["@sam", "@sasha"]

    def test_case_insensitive_matching_original_case(self):
        assert completions_for("/me SAM", MEMBERS) == ["sam"]

    def test_completes_members_in_plain_chat(self):
        assert completions_for("thanks sa", MEMBERS) == ["sam", "sasha"]

    def test_completes_rooms_for_join(self):
        assert completions_for("/join #ge", rooms=ROOMS) == ["#general"]

    def test_create_is_not_a_python_command(self):
        assert completions_for("/create lo", rooms=ROOMS) == []

    def test_rotates_room_matches_sorted(self):
        assert completions_for("/join g", rooms=ROOMS) == ["general", "gaming"]

    def test_no_room_completion_for_other_commands(self):
        assert completions_for("/me ge", rooms=ROOMS) == []

    def test_no_completion_on_empty_word(self):
        assert completions_for("/join ", rooms=ROOMS) == []

    def test_command_list_is_sorted_and_complete(self):
        assert COMMAND_WORDS[0] == "?"
        assert "status" in COMMAND_WORDS
        assert "join" in COMMAND_WORDS
        # /clear exists on both stacks since v8.1, so it must complete too.
        assert "clear" in COMMAND_WORDS

    def test_v8_commands_are_completable(self):
        assert completions_for("/fi") == ["/file", "/fingerprint"]  # sorted
        assert completions_for("/re") == ["/react", "/reply"]  # sorted
        assert completions_for("/i") == ["/identity", "/ids"]  # sorted
        assert completions_for("/id") == ["/identity", "/ids"]  # sorted
        assert completions_for("/t") == ["/trust"]
        assert completions_for("/un") == ["/untrust"]

    def test_message_id_argument_is_left_alone(self):
        # The first argument to /reply and /react is a message id, not a name.
        assert completions_for("/reply sam", MEMBERS) == []
        assert completions_for("/react sam", MEMBERS) == []

    def test_completes_members_from_the_third_word_on(self):
        # /react <id> <body...>: usernames only kick in after the id.
        assert completions_for("/react abcd1234 sa", MEMBERS) == ["sam", "sasha"]
        assert completions_for("/reply abcd1234 @sa", MEMBERS) == ["@sam", "@sasha"]

    def test_no_completion_when_the_third_word_is_empty(self):
        assert completions_for("/reply abcd1234 ", MEMBERS) == []


class TestTabCompleter:
    def test_readline_protocol_returns_matches_in_order(self):
        calls = []

        def candidates():
            calls.append(1)
            return {"members": list(MEMBERS), "rooms": []}

        completer = TabCompleter(candidates)
        assert completer.complete("/me waves sa", 0) == "sam"
        assert completer.complete("/me waves sa", 1) == "sasha"
        assert completer.complete("/me waves sa", 2) is None
        # Candidates are fetched once per completion round, not per state.
        assert len(calls) == 1

    def test_new_round_refetches_candidates(self):
        data = {"members": [], "rooms": ["general"]}

        completer = TabCompleter(lambda: dict(data))
        assert completer.complete("/join ge", 0) == "general"

        data["rooms"] = ["gaming"]
        assert completer.complete("/join ge", 0) is None
        data["rooms"] = ["general"]
        assert completer.complete("/join ge", 0) == "general"

    def test_no_matches_returns_none(self):
        completer = TabCompleter(lambda: {"members": [], "rooms": []})
        assert completer.complete("/zz", 0) is None
