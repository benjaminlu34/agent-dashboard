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

    def test_get_project_items_metadata_calls_metadata_endpoint_with_role_and_sprint(self) -> None:
        client = BackendClient(base_url="http://localhost:4000", timeout_s=1.0)
        with patch("apps.runner.http_client.BackendClient.get_json", return_value={"items": []}) as mock_get_json:
            payload = client.get_project_items_metadata(role="ORCHESTRATOR", sprint="M1")

        self.assertEqual(payload, {"items": []})
        mock_get_json.assert_called_once_with(
            "/internal/metadata/project-items",
            params={"role": "ORCHESTRATOR", "sprint": "M1"},
            timeout_s=None,
        )
