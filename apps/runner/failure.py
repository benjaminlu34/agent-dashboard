from __future__ import annotations

from typing import Any

from .codex_worker import CodexWorkerError
from .http_client import HttpError
from .intents import IntentError


def classify_failure(error: Exception) -> str:
    # Returns one of: HARD_STOP, ITEM_STOP, TRANSIENT. Some ledger paths also record
    # explicit terminal classes such as STALLED without flowing through this mapper.
    if isinstance(error, IntentError):
        return "HARD_STOP"
    if isinstance(error, HttpError):
        if error.code in ("backend_unreachable",):
            return "TRANSIENT"
        if error.status_code == 409:
            return "ITEM_STOP"
        if error.status_code >= 500:
            return "TRANSIENT"
        # Backend 4xx is treated as fail-closed; caller can inspect payload.
        return "HARD_STOP"
    if isinstance(error, CodexWorkerError):
        if error.code in {
            "mcp_disconnected",
            "mcp_timeout",
            "mcp_error_response",
            "mcp_invalid_result",
            "mcp_invalid_json",
            "worker_invalid_output",
            "worker_identity_mismatch",
            "mcp_stdio_unavailable",
        }:
            return "ITEM_STOP"
        return "HARD_STOP"
    return "HARD_STOP"


def exit_code_for_classification(classification: str) -> int:
    if classification == "TRANSIENT":
        return 4
    if classification == "HARD_STOP":
        return 2
    if classification == "ITEM_STOP":
        return 0
    return 2


def is_retryable_failure(*, failure_classification: str, error_code: str) -> bool:
    normalized_class = str(failure_classification or "").strip().upper()
    normalized_code = str(error_code or "").strip()
    if normalized_class == "TRANSIENT":
        return True
    return normalized_code in {
        "mcp_disconnected",
        "mcp_timeout",
        "backend_unreachable",
        "mcp_stdio_unavailable",
        "mcp_error_response",
        "watchdog_timeout",
        "stall_timeout",
        "worker_down",
    }


def error_code_for_exception(exc: Exception) -> str:
    return str(getattr(exc, "code", "") or exc.__class__.__name__)
