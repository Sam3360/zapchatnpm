"""IPv6 support: address validation and host:port splitting (v8).

The Python mirror of the npm `isValidIpv6` / `splitTarget` behaviour. Both
stacks must accept and reject exactly the same literals, or an npm peer could
advertise an address the Python client refuses (or vice versa).
"""

from zapchat.protocol import (
    is_valid_host,
    is_valid_ipv4,
    is_valid_ipv6,
    sanitize_address_list,
    split_host_port,
)


class TestIsValidIpv6:
    def test_accepts_full_and_compressed_literals(self):
        for address in (
            "::",
            "::1",
            "fe80::",
            "fe80::1",
            "2001:db8::",
            "2001:db8::8a2e:370:7334",
            "1:2:3:4:5:6:7:8",
            "2001:0db8:0000:0000:0000:ff00:0042:8329",
        ):
            assert is_valid_ipv6(address), address

    def test_accepts_an_embedded_ipv4_quad(self):
        assert is_valid_ipv6("::ffff:192.168.0.1")
        assert is_valid_ipv6("64:ff9b::1.2.3.4")

    def test_accepts_a_zone_id_on_link_local(self):
        assert is_valid_ipv6("fe80::1%eth0")
        assert not is_valid_ipv6("fe80::1%")
        assert not is_valid_ipv6("::%")

    def test_rejects_too_many_groups(self):
        assert not is_valid_ipv6("1:2:3:4:5:6:7:8:9")

    def test_rejects_too_few_groups_without_elision(self):
        assert not is_valid_ipv6("1:2:3:4:5:6:7")

    def test_rejects_two_elisions(self):
        assert not is_valid_ipv6("1::2::3")

    def test_rejects_a_leading_or_trailing_colon(self):
        assert not is_valid_ipv6(":1:2:3:4:5:6:7:8")
        assert not is_valid_ipv6("1:2:3:4:5:6:7:")

    def test_rejects_out_of_range_and_non_hex_groups(self):
        assert not is_valid_ipv6("gggg::1")
        assert not is_valid_ipv6("12345::1")

    def test_rejects_a_malformed_embedded_quad(self):
        assert not is_valid_ipv6("1:2:3:4:5:6:1.2.3")
        assert not is_valid_ipv6("1:2:3:4:5:6:7:999.1.1.1")

    def test_rejects_ipv4_and_empty_input(self):
        assert not is_valid_ipv6("192.168.0.1")
        assert not is_valid_ipv6("")
        assert not is_valid_ipv6(None)


class TestIsValidHost:
    def test_accepts_hostnames(self):
        assert is_valid_host("example.com")
        assert is_valid_host("host-name")
        assert is_valid_host("a")

    def test_accepts_ipv4_and_ipv6_literals(self):
        assert is_valid_host("192.168.1.5")
        assert is_valid_host("fe80::1")

    def test_rejects_a_broken_dotted_quad(self):
        assert not is_valid_host("999.1.1.1")

    def test_rejects_whitespace_and_slashes(self):
        assert not is_valid_host("has space")
        assert not is_valid_host("a/b")

    def test_rejects_empty_and_overlong(self):
        assert not is_valid_host("")
        assert not is_valid_host("a" * 254)


class TestSplitHostPort:
    def test_splits_host_and_port(self):
        assert split_host_port("192.168.1.5:45913") == ("192.168.1.5", "45913")
        assert split_host_port("peer.local:1234") == ("peer.local", "1234")

    def test_host_without_port(self):
        assert split_host_port("192.168.1.5") == ("192.168.1.5", None)

    def test_bracketed_ipv6_with_port(self):
        assert split_host_port("[::1]:45913") == ("::1", "45913")
        assert split_host_port("[fe80::1%eth0]:45913") == ("fe80::1%eth0", "45913")

    def test_bracketed_ipv6_without_port(self):
        assert split_host_port("[::1]") == ("::1", None)

    def test_bare_ipv6_is_never_split_on_its_last_colon(self):
        # Without brackets the last group is an address part, not a port.
        assert split_host_port("fe80::1") == ("fe80::1", None)
        assert split_host_port("::1") == ("::1", None)

    def test_unterminated_bracket_is_passed_through(self):
        assert split_host_port("[::1") == ("[::1", None)


class TestSanitizeAddressList:
    def test_keeps_both_families_and_drops_junk(self):
        result = sanitize_address_list(
            ["192.168.1.5", "fe80::1%eth0", "not an address", "::1", "10.0.0.1"], 8
        )
        assert result == ["192.168.1.5", "fe80::1", "::1", "10.0.0.1"]

    def test_strips_the_zone_id_before_advertising(self):
        # A scope id is local to this machine and meaningless to a peer.
        assert sanitize_address_list(["fe80::1%eth0"], 8) == ["fe80::1"]

    def test_honours_the_cap(self):
        assert len(sanitize_address_list(["10.0.0.1", "10.0.0.2", "::1", "::2"], 2)) == 2

    def test_rejects_a_non_list(self):
        assert sanitize_address_list("192.168.1.5", 8) == []


def test_ipv4_helper_is_independent_of_ipv6():
    assert is_valid_ipv4("192.168.0.1")
    assert not is_valid_ipv4("256.0.0.1")
    assert not is_valid_ipv4("::1")