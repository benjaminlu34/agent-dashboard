from __future__ import annotations

from dataclasses import dataclass
import json
import os
import threading
import time
from typing import Any, Dict, Optional


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


class RunLedger:
    def __init__(self, path: str):
        self._path = path
        self._lock = threading.Lock()
        self._root: Dict[str, Any] = {}
        self._loaded = False

    def load(self) -> None:
        with self._lock:
            if self._loaded:
                return
            try:
                with open(self._path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except FileNotFoundError:
                payload = {}
            except json.JSONDecodeError as exc:
                raise LedgerError(f"ledger file is not valid JSON: {self._path}") from exc

            if not isinstance(payload, dict):
                raise LedgerError("ledger root must be a JSON object")

            self._root = self._normalize_payload(payload)
            self._loaded = True

    def get(self, run_id: str) -> Optional[Dict[str, Any]]:
        self.load()
        with self._lock:
            return self._runs().get(run_id)

    def upsert(self, entry: LedgerEntry) -> None:
        self.load()
        with self._lock:
            self._runs()[entry.run_id] = {
                "run_id": entry.run_id,
                "role": entry.role,
                "intent_hash": entry.intent_hash,
                "received_at": entry.received_at,
                "status": entry.status,
                "result": entry.result,
            }
            self._atomic_write()

    def mark_running(self, run_id: str) -> None:
        self.load()
        with self._lock:
            existing = self._runs().get(run_id)
            if not existing:
                raise LedgerError("cannot mark running: run_id not in ledger")
            existing["status"] = "running"
            existing["running_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            existing["result"] = existing.get("result")
            self._atomic_write()

    def mark_result(self, run_id: str, *, status: str, result: Dict[str, Any]) -> None:
        self.load()
        with self._lock:
            existing = self._runs().get(run_id)
            if not existing:
                raise LedgerError("cannot mark result: run_id not in ledger")
            existing["status"] = status
            existing["result"] = result
            self._atomic_write()

    def get_plan_version(self) -> str:
        self.load()
        with self._lock:
            value = self._root.get("plan_version")
            return value if isinstance(value, str) else ""

    def get_task_last_activity(self, project_item_id: str) -> str:
        self.load()
        with self._lock:
            tasks = self._tasks()
            entry = tasks.get(project_item_id)
            if not isinstance(entry, dict):
                return ""
            value = entry.get("last_activity_at")
            return value if isinstance(value, str) else ""

    def touch_task_last_activity(self, project_item_id: str, *, at_iso: str) -> None:
        self.load()
        with self._lock:
            tasks = self._tasks()
            entry = tasks.get(project_item_id)
            if not isinstance(entry, dict):
                entry = {}
                tasks[project_item_id] = entry
            entry["last_activity_at"] = at_iso
            self._atomic_write()

    def _normalize_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        # Supports both legacy run-ledger format (run_id keys at root) and the staged
        # sprint ledger format (plan_version + {runs,tasks} objects).
        uses_structured_shape = any(key in payload for key in ("plan_version", "runs", "tasks"))
        if not uses_structured_shape:
            return {
                "plan_version": "",
                "runs": payload,
                "tasks": {},
            }

        normalized: Dict[str, Any] = dict(payload)
        plan_version = normalized.get("plan_version")
        normalized["plan_version"] = plan_version if isinstance(plan_version, str) else ""
        runs = normalized.get("runs")
        normalized["runs"] = runs if isinstance(runs, dict) else {}
        tasks = normalized.get("tasks")
        normalized["tasks"] = tasks if isinstance(tasks, dict) else {}
        return normalized

    def _runs(self) -> Dict[str, Dict[str, Any]]:
        runs = self._root.get("runs")
        if isinstance(runs, dict):
            return runs  # type: ignore[return-value]
        return {}

    def _tasks(self) -> Dict[str, Dict[str, Any]]:
        tasks = self._root.get("tasks")
        if isinstance(tasks, dict):
            return tasks  # type: ignore[return-value]
        return {}

    def _atomic_write(self) -> None:
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        os.makedirs(directory, exist_ok=True)
        temp_path = f"{self._path}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(self._root, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_path, self._path)
