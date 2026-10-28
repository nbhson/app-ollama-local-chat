"""Unit tests for server-side logic (no Ollama needed).

Run: python3 -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server_lib.config import validate_ollama_url  # noqa: E402
from server_lib.handler import BodyTooLarge, ChatHandler  # noqa: E402
from server_lib import ollama  # noqa: E402


class TestValidateOllamaUrl(unittest.TestCase):
    def test_allows_loopback(self):
        url, err = validate_ollama_url("http://localhost:11434")
        self.assertIsNone(err)
        self.assertEqual(url, "http://localhost:11434")

    def test_allows_loopback_ip(self):
        url, err = validate_ollama_url("http://127.0.0.1:11434")
        self.assertIsNone(err)

    def test_rejects_metadata_ip(self):
        _, err = validate_ollama_url("http://169.254.169.254/latest")
        self.assertIsNotNone(err)

    def test_rejects_gcp_metadata_host(self):
        _, err = validate_ollama_url("http://metadata.google.internal/")
        self.assertIsNotNone(err)

    def test_rejects_non_http_scheme(self):
        _, err = validate_ollama_url("file:///etc/passwd")
        self.assertIsNotNone(err)

    def test_rejects_empty(self):
        _, err = validate_ollama_url("")
        self.assertIsNotNone(err)
        _, err = validate_ollama_url(None)
        self.assertIsNotNone(err)

    def test_rejects_unresolvable_host(self):
        _, err = validate_ollama_url("http://this-host-does-not-exist.invalid:11434")
        self.assertIsNotNone(err)

    def test_trailing_slash_stripped(self):
        url, err = validate_ollama_url("http://localhost:11434/")
        self.assertIsNone(err)
        self.assertEqual(url, "http://localhost:11434")

    def test_dns_rebind_blocked(self):
        # Hostname benign resolve tới metadata IP → phải bị chặn.
        with mock.patch("server_lib.config.socket.getaddrinfo",
                        return_value=[(2, 1, 6, "", ("169.254.169.254", 0))]):
            _, err = validate_ollama_url("http://evil.example.com")
        self.assertIsNotNone(err)

    def test_whitelist_enforced(self):
        with mock.patch.dict(os.environ, {"ALLOWED_OLLAMA_HOSTS": "localhost"}):
            _, err = validate_ollama_url("http://other-host.example.com:11434")
            self.assertIsNotNone(err)


class TestMessageValidation(unittest.TestCase):
    def _validate(self, messages):
        return ChatHandler._validate_messages(messages)

    def test_valid(self):
        self.assertIsNone(self._validate([{"role": "user", "content": "hi"}]))

    def test_empty_rejected(self):
        self.assertIsNotNone(self._validate([]))
        self.assertIsNotNone(self._validate("not a list"))

    def test_missing_content_rejected(self):
        self.assertIsNotNone(self._validate([{"role": "user"}]))

    def test_non_string_content_rejected(self):
        self.assertIsNotNone(self._validate([{"role": "user", "content": 42}]))


class TestFetchModels(unittest.TestCase):
    def _resp(self, status, body):
        return mock.MagicMock(status=status, read=lambda: body)

    def test_success(self):
        body = b'{"models": [{"name": "a"}, {"name": "b"}]}'
        with mock.patch.object(ollama, "_request", return_value=(200, body)):
            models, err = ollama.fetch_models("http://localhost:11434")
        self.assertEqual(models, ["a", "b"])
        self.assertIsNone(err)

    def test_connection_failure_has_error(self):
        with mock.patch.object(ollama, "_request", return_value=(0, b"refused")):
            models, err = ollama.fetch_models("http://localhost:11434")
        self.assertEqual(models, [])
        self.assertIn("Cannot connect", err)

    def test_http_error_has_error(self):
        with mock.patch.object(ollama, "_request", return_value=(500, b"boom")):
            models, err = ollama.fetch_models("http://localhost:11434")
        self.assertEqual(models, [])
        self.assertIn("500", err)


class TestStreamChat(unittest.TestCase):
    def test_client_disconnect_propagates(self):
        # on_chunk raise ConnectionResetError → phải propagate (không nuốt).
        def boom(_text):
            raise ConnectionResetError()

        fake_resp = mock.MagicMock()
        fake_resp.read.side_effect = [b'{"message":{"content":"hi"},"done":false}\n', b""]
        fake_resp.__enter__ = lambda s: fake_resp
        fake_resp.__exit__ = mock.MagicMock(return_value=False)
        with mock.patch.object(ollama.urllib.request, "urlopen", return_value=fake_resp):
            with self.assertRaises(ConnectionResetError):
                ollama.stream_chat("http://localhost:11434", {"model": "m"}, boom)

    def test_upstream_error_frame(self):
        fake_resp = mock.MagicMock()
        fake_resp.read.side_effect = [b'{"error": "model not found"}\n', b""]
        fake_resp.__enter__ = lambda s: fake_resp
        fake_resp.__exit__ = mock.MagicMock(return_value=False)
        chunks = []
        with mock.patch.object(ollama.urllib.request, "urlopen", return_value=fake_resp):
            status, error = ollama.stream_chat("http://localhost:11434", {}, chunks.append)
        self.assertEqual(status, 500)
        self.assertEqual(error, "model not found")
        self.assertEqual(chunks, [])


if __name__ == "__main__":
    unittest.main()
