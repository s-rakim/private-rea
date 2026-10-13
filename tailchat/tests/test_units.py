"""Unit tests for the server's input checks (the API itself is covered by the
contract tests in test/, which drive it with the browser's crypto code)."""

import unittest

from tailchat_server.api import is_emoji
from tailchat_server.config import load_config
from tailchat_server.tailnet import decode_header_word, is_loopback, is_tailnet_address


class TailnetTests(unittest.TestCase):
    def test_tailnet_ranges(self):
        self.assertTrue(is_tailnet_address("100.64.0.1"))
        self.assertTrue(is_tailnet_address("100.127.255.254"))
        self.assertTrue(is_tailnet_address("::ffff:100.100.1.2"))
        self.assertTrue(is_tailnet_address("fd7a:115c:a1e0::1"))
        self.assertFalse(is_tailnet_address("100.128.0.1"))
        self.assertFalse(is_tailnet_address("192.168.1.10"))
        self.assertFalse(is_tailnet_address("fd7a:115c:a1e1::1"))
        self.assertFalse(is_tailnet_address(None))

    def test_loopback(self):
        self.assertTrue(is_loopback("127.0.0.1"))
        self.assertTrue(is_loopback("::1"))
        self.assertTrue(is_loopback("::ffff:127.0.0.1"))
        self.assertFalse(is_loopback("100.64.0.1"))

    def test_rfc2047_names(self):
        self.assertEqual(decode_header_word("Alice"), "Alice")
        self.assertEqual(decode_header_word("=?utf-8?q?Ren=C3=A9e_Smith?="), "Renée Smith")
        self.assertEqual(decode_header_word("=?utf-8?b?UmVuw6ll?="), "Renée")


class EmojiTests(unittest.TestCase):
    def test_accepts_emoji(self):
        for e in ["👍", "❤️", "👍🏽", "👩‍👩‍👧", "🇰🇪", "1️⃣", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]:
            self.assertTrue(is_emoji(e), e)

    def test_rejects_text(self):
        for e in ["", "lol", "a👍", "👍 ", "1", "<b>"]:
            self.assertFalse(is_emoji(e), e)


class ConfigTests(unittest.TestCase):
    def test_dev_mode_is_loopback_only(self):
        with self.assertRaises(ValueError):
            load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_HOST": "0.0.0.0"})
        self.assertEqual(load_config({"TAILCHAT_AUTH": "dev"}).host, "127.0.0.1")

    def test_direct_mode_needs_host(self):
        with self.assertRaises(ValueError):
            load_config({"TAILCHAT_AUTH": "direct"})

    def test_serve_mode_defaults_to_loopback(self):
        self.assertEqual(load_config({}).host, "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
