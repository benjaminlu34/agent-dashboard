import unittest
from unittest.mock import patch
import urllib.error

from apps.runner.http_client import BackendClient, HttpError


class HttpClientTimeoutTests(unittest.TestCase):
    def test_timeout_error_keeps_fail_closed_code_and_reason(self) -> None:
        client = BackendClient(base_url="http://localhost:4000", timeout_s=0.01)
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("timed out")):
            with self.assertRaises(HttpError) as ctx:
                client.preflight_orchestrator()

        error = ctx.exception
        self.assertEqual(error.code, "backend_unreachable")
        self.assertIsInstance(error.payload, dict)
        reason = str(error.payload.get("reason", ""))
        self.assertIn("timed out", reason.lower())

