from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Dict, Optional
import urllib.error
import urllib.parse
import urllib.request


class HttpError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "http_error",
        status_code: int = 0,
        payload: Any = None,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.payload = payload
        self.details = details or {}


@dataclass(frozen=True)
class BackendClient:
    base_url: str
    timeout_s: float = 15.0

    def get_json(self, path: str, *, params: Optional[dict[str, str]] = None) -> Dict[str, Any]:
        url = _build_url(self.base_url, path, params)
        payload, status_code = _request_json("GET", url, timeout_s=self.timeout_s)
        if status_code >= 400:
            raise HttpError(f"backend returned HTTP {status_code}", code="backend_http_error", status_code=status_code, payload=payload)
        if not isinstance(payload, dict):
            raise HttpError("backend JSON payload must be an object", code="backend_invalid_payload", status_code=status_code, payload=payload)
        return payload

    def post_json(self, path: str, *, body: Dict[str, Any]) -> Dict[str, Any]:
        url = _build_url(self.base_url, path, None)
        payload, status_code = _request_json("POST", url, timeout_s=self.timeout_s, body=body)
        if status_code >= 400:
            raise HttpError(f"backend returned HTTP {status_code}", code="backend_http_error", status_code=status_code, payload=payload)
        if not isinstance(payload, dict):
            raise HttpError("backend JSON payload must be an object", code="backend_invalid_payload", status_code=status_code, payload=payload)
        return payload

    def preflight_orchestrator(self) -> Dict[str, Any]:
        return self.get_json("/internal/preflight", params={"role": "ORCHESTRATOR"})

    def get_agent_context(self, role: str) -> Dict[str, Any]:
        return self.get_json("/internal/agent-context", params={"role": role})


def _build_url(base_url: str, path: str, params: Optional[dict[str, str]]) -> str:
    url = f"{base_url}{path}"
    if params:
        query = urllib.parse.urlencode(params)
        return f"{url}?{query}"
    return url


def _request_json(method: str, url: str, *, timeout_s: float, body: Optional[Dict[str, Any]] = None) -> tuple[Any, int]:
    data: Optional[bytes] = None
    headers: dict[str, str] = {}
    if body is not None:
        data = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        headers["content-type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status_code = int(getattr(exc, "code", 0) or 0)
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
    except (urllib.error.URLError, TimeoutError) as exc:
        reason_obj = getattr(exc, "reason", None)
        reason = str(reason_obj if reason_obj is not None else exc) or exc.__class__.__name__
        details = {"reason": reason, "error_type": exc.__class__.__name__}
        raise HttpError(
            "backend request failed",
            code="backend_unreachable",
            payload=details,
            details=details,
        ) from exc

    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {"raw": raw}
    return payload, status_code
