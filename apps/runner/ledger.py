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
        self._data: Dict[str, Dict[str, Any]] = {}
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

            self._data = payload
            self._loaded = True

    def get(self, run_id: str) -> Optional[Dict[str, Any]]:
        self.load()
        with self._lock:
            return self._data.get(run_id)

    def upsert(self, entry: LedgerEntry) -> None:
        self.load()
        with self._lock:
            self._data[entry.run_id] = {
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
            existing = self._data.get(run_id)
            if not existing:
                raise LedgerError("cannot mark running: run_id not in ledger")
            existing["status"] = "running"
            existing["result"] = existing.get("result")
            self._atomic_write()

    def mark_result(self, run_id: str, *, status: str, result: Dict[str, Any]) -> None:
        self.load()
        with self._lock:
            existing = self._data.get(run_id)
            if not existing:
                raise LedgerError("cannot mark result: run_id not in ledger")
            existing["status"] = status
            existing["result"] = result
            self._atomic_write()

    def _atomic_write(self) -> None:
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        os.makedirs(directory, exist_ok=True)
        temp_path = f"{self._path}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(self._data, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_path, self._path)

