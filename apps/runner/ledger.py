from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Dict, Optional

from .redis_keys import orchestrator_ledger_key


class LedgerError(Exception):
    pass


@dataclass
class LedgerEntry:
    run_id: str
    role: str
    intent_hash: str
    received_at: str
    status: str  # queued|running|succeeded|failed|skipped
    result: Optional[Dict[str, Any]] = None


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _parse_json_object(raw: Any) -> Optional[dict[str, Any]]:
    if raw is None:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


class RunLedger:
    def __init__(self, redis_client: Any, repo_key: str):
        self._redis = redis_client
        self._repo_key = repo_key
        self._key = orchestrator_ledger_key(repo_key)

    def get(self, run_id: str) -> Optional[Dict[str, Any]]:
        if not isinstance(run_id, str) or not run_id.strip():
            return None
        raw = self._redis.hget(self._key, run_id.strip())
        return _parse_json_object(raw)

    def upsert(self, entry: LedgerEntry) -> None:
        payload: Dict[str, Any] = {
            "run_id": entry.run_id,
            "role": entry.role,
            "intent_hash": entry.intent_hash,
            "received_at": entry.received_at,
            "status": entry.status,
            "result": entry.result,
        }
        self._redis.hset(
            self._key,
            entry.run_id,
            json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        )

    def mark_running(self, run_id: str) -> None:
        existing = self.get(run_id)
        if not existing:
            raise LedgerError("cannot mark running: run_id not in ledger")
        existing["status"] = "running"
        existing["running_at"] = _utc_now_iso()
        existing["result"] = existing.get("result")
        self._redis.hset(
            self._key,
            run_id,
            json.dumps(existing, separators=(",", ":"), ensure_ascii=True),
        )

    def mark_result(self, run_id: str, *, status: str, result: Dict[str, Any]) -> None:
        existing = self.get(run_id)
        if not existing:
            raise LedgerError("cannot mark result: run_id not in ledger")
        existing["status"] = status
        existing["result"] = result
        self._redis.hset(
            self._key,
            run_id,
            json.dumps(existing, separators=(",", ":"), ensure_ascii=True),
        )

    def set_plan_version(self, plan_version: str) -> None:
        normalized = str(plan_version or "").strip()
        if not normalized:
            raise LedgerError("plan_version is required")
        self._redis.hset(self._key, "__meta__:plan_version", normalized)

    def get_plan_version(self) -> str:
        raw = self._redis.hget(self._key, "__meta__:plan_version")
        if raw is None:
            return ""
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        return raw if isinstance(raw, str) else str(raw)

    def get_task_last_activity(self, project_item_id: str) -> str:
        value = self._get_task_metadata(project_item_id).get("last_activity_at")
        return value if isinstance(value, str) else ""

    def touch_task_last_activity(self, project_item_id: str, *, at_iso: str) -> None:
        normalized_at = str(at_iso or "").strip()
        if not normalized_at:
            raise LedgerError("at_iso is required")
        self._set_task_metadata(project_item_id, {"last_activity_at": normalized_at})

    def get_task_failure_state(self, project_item_id: str) -> Dict[str, Any]:
        parsed = self._get_task_metadata(project_item_id)
        consecutive_failures = parsed.get("consecutive_failures")
        last_failure_at = parsed.get("last_failure_at")
        last_failure_run_id = parsed.get("last_failure_run_id")
        return {
            "consecutive_failures": consecutive_failures if isinstance(consecutive_failures, int) and consecutive_failures >= 0 else 0,
            "last_failure_at": last_failure_at if isinstance(last_failure_at, str) else "",
            "last_failure_run_id": last_failure_run_id if isinstance(last_failure_run_id, str) else "",
        }

    def record_task_failure(self, project_item_id: str, *, run_id: str, at_iso: str) -> Dict[str, Any]:
        normalized_run_id = str(run_id or "").strip()
        normalized_at = str(at_iso or "").strip()
        if not normalized_at:
            raise LedgerError("at_iso is required")

        metadata = self._get_task_metadata(project_item_id)
        tracked_run_id = str(metadata.get("last_failure_run_id") or "").strip()
        tracked_at = str(metadata.get("last_failure_at") or "").strip()
        consecutive_failures = metadata.get("consecutive_failures")
        current_count = consecutive_failures if isinstance(consecutive_failures, int) and consecutive_failures >= 0 else 0

        if normalized_run_id and tracked_run_id == normalized_run_id and tracked_at:
            next_count = current_count if current_count > 0 else 1
        else:
            next_count = current_count + 1

        metadata.update(
            {
                "consecutive_failures": next_count,
                "last_failure_at": normalized_at,
                "last_failure_run_id": normalized_run_id,
            }
        )
        self._write_task_metadata(project_item_id, metadata)
        return {
            "consecutive_failures": next_count,
            "last_failure_at": normalized_at,
            "last_failure_run_id": normalized_run_id,
        }

    def reset_task_failures(self, project_item_id: str) -> None:
        metadata = self._get_task_metadata(project_item_id)
        metadata.update(
            {
                "consecutive_failures": 0,
                "last_failure_at": "",
                "last_failure_run_id": "",
            }
        )
        self._write_task_metadata(project_item_id, metadata)

    def _get_task_metadata(self, project_item_id: str) -> Dict[str, Any]:
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            raise LedgerError("project_item_id is required")
        raw = self._redis.hget(self._key, f"__task__:{project_item_id.strip()}")
        parsed = _parse_json_object(raw)
        return parsed if isinstance(parsed, dict) else {}

    def _set_task_metadata(self, project_item_id: str, fields: Dict[str, Any]) -> None:
        metadata = self._get_task_metadata(project_item_id)
        metadata.update(fields)
        self._write_task_metadata(project_item_id, metadata)

    def _write_task_metadata(self, project_item_id: str, payload: Dict[str, Any]) -> None:
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            raise LedgerError("project_item_id is required")
        field = f"__task__:{project_item_id.strip()}"
        self._redis.hset(
            self._key,
            field,
            json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
        )
