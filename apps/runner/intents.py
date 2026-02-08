from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from typing import Any, Dict, Optional


ALLOWED_ROLES = {"EXECUTOR", "REVIEWER"}
INTENT_TYPE = "RUN_INTENT"
ALLOWED_ENDPOINTS_BY_ROLE = {
    "EXECUTOR": {"/internal/executor/claim-ready-item"},
    "REVIEWER": {"/internal/reviewer/resolve-linked-pr"},
}


class IntentError(Exception):
    def __init__(self, message: str, *, code: str = "intent_invalid", details: Optional[dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class RunIntent:
    type: str
    role: str
    run_id: str
    endpoint: str
    body: Dict[str, Any]
    raw: Dict[str, Any]

    @property
    def intent_hash(self) -> str:
        canonical = json.dumps(self.raw, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_json_line(line: str) -> dict[str, Any]:
    try:
        value = json.loads(line)
    except json.JSONDecodeError as exc:
        raise IntentError("orchestrator emitted invalid JSONL", code="intent_invalid_json", details={"error": str(exc)}) from None
    if not isinstance(value, dict):
        raise IntentError("intent line must be a JSON object", code="intent_invalid_type")
    return value


def parse_intent(value: dict[str, Any]) -> RunIntent:
    allowed_keys = {"type", "role", "run_id", "endpoint", "body"}
    extra_keys = set(value.keys()) - allowed_keys
    if extra_keys:
        raise IntentError("intent has unknown fields", code="intent_unknown_fields", details={"fields": sorted(extra_keys)})

    intent_type = value.get("type")
    if intent_type != INTENT_TYPE:
        raise IntentError("intent type mismatch", code="intent_type_mismatch", details={"type": intent_type})

    role = value.get("role")
    if not isinstance(role, str) or role.strip().upper() not in ALLOWED_ROLES:
        raise IntentError("intent role must be EXECUTOR or REVIEWER", code="intent_invalid_role", details={"role": role})
    normalized_role = role.strip().upper()

    run_id = value.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        raise IntentError("intent run_id is required", code="intent_missing_run_id")

    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint.strip().startswith("/internal/"):
        raise IntentError("intent endpoint is required", code="intent_invalid_endpoint", details={"endpoint": endpoint})
    normalized_endpoint = endpoint.strip()
    allowed_endpoints = ALLOWED_ENDPOINTS_BY_ROLE.get(normalized_role, set())
    if normalized_endpoint not in allowed_endpoints:
        raise IntentError(
            "intent endpoint is not allowed for role",
            code="intent_endpoint_not_allowed",
            details={"role": normalized_role, "endpoint": normalized_endpoint, "allowed": sorted(allowed_endpoints)},
        )

    body = value.get("body")
    if not isinstance(body, dict):
        raise IntentError("intent body must be an object", code="intent_invalid_body")

    body_role = body.get("role")
    if body_role != normalized_role:
        raise IntentError("intent body.role must match intent role", code="intent_role_mismatch")

    body_run_id = body.get("run_id")
    if body_run_id != run_id:
        raise IntentError("intent body.run_id must match intent run_id", code="intent_run_id_mismatch")

    return RunIntent(
        type=INTENT_TYPE,
        role=normalized_role,
        run_id=run_id,
        endpoint=normalized_endpoint,
        body=body,
        raw=value,
    )
