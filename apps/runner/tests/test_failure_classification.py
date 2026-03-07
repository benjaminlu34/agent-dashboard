import unittest

from apps.runner.http_client import HttpError
from apps.runner.intents import IntentError
from apps.runner.codex_worker import CodexWorkerError
from apps.runner.failure import classify_failure, is_retryable_failure


class FailureClassificationTests(unittest.TestCase):
    def test_intent_error_is_hard_stop(self) -> None:
        self.assertEqual(classify_failure(IntentError("bad", code="intent_invalid_json")), "HARD_STOP")

    def test_http_409_is_item_stop(self) -> None:
        self.assertEqual(
            classify_failure(HttpError("conflict", code="backend_http_error", status_code=409, payload={"error": "ambiguous"})),
            "ITEM_STOP",
        )

    def test_http_5xx_is_transient(self) -> None:
        self.assertEqual(
            classify_failure(HttpError("bad gateway", code="backend_http_error", status_code=502, payload=None)),
            "TRANSIENT",
        )

    def test_unreachable_is_transient(self) -> None:
        self.assertEqual(classify_failure(HttpError("down", code="backend_unreachable")), "TRANSIENT")

    def test_codex_timeout_is_item_stop(self) -> None:
        self.assertEqual(classify_failure(CodexWorkerError("timeout", code="mcp_timeout")), "ITEM_STOP")

    def test_watchdog_timeout_is_retryable_for_backoff_recovery(self) -> None:
        self.assertTrue(is_retryable_failure(failure_classification="HARD_STOP", error_code="watchdog_timeout"))
