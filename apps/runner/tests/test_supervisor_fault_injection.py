from __future__ import annotations

import json
import unittest
from dataclasses import dataclass
from typing import Any
from unittest.mock import patch

from apps.runner.supervisor import run_supervisor_loop


class _SingleIntentRedis:
    def __init__(self, *, queue_key: str, intent_payload: dict[str, Any]) -> None:
        self._queue_key = queue_key
        self._raw_intent = json.dumps(intent_payload)
        self._calls = 0
        self.requeued: list[tuple[str, str]] = []

    def blpop(self, key: str, timeout: int = 0):  # noqa: ARG002
        self._calls += 1
        if self._calls == 1:
            return key, self._raw_intent
        raise KeyboardInterrupt()

    def rpush(self, key: str, value: str) -> int:
        self.requeued.append((key, value))
        return len(self.requeued)


class _QueueEmpty:
    def get_nowait(self) -> dict[str, Any]:
        raise RuntimeError("empty queue")


class _HungChildProcess:
    def __init__(self) -> None:
        self.started = False
        self.terminate_called = False
        self.kill_called = False
        self._alive_checks = 0
        self.exitcode = None

    def start(self) -> None:
        self.started = True

    def join(self, timeout: float | None = None) -> None:  # noqa: ARG002
        return None

    def is_alive(self) -> bool:
        self._alive_checks += 1
        if self._alive_checks in (1, 2):
            return True
        return False

    def terminate(self) -> None:
        self.terminate_called = True

    def kill(self) -> None:
        self.kill_called = True
        self.exitcode = -9


class _FakeSpawnContext:
    def __init__(self, process: _HungChildProcess) -> None:
        self._process = process

    def Queue(self, maxsize: int = 1) -> _QueueEmpty:  # noqa: ARG002
        return _QueueEmpty()

    def Process(self, *args, **kwargs) -> _HungChildProcess:  # noqa: ANN002, ARG002
        return self._process


class _FakeStateStore:
    def __init__(self, _redis_client: Any) -> None:
        return None

    def get_all_items(self, _repo_key: str) -> dict[str, dict[str, Any]]:
        return {}

    def set_item(self, _repo_key: str, _project_item_id: str, _item_dict: dict[str, Any]) -> None:
        return None


@dataclass
class _LedgerMark:
    run_id: str
    status: str
    result: dict[str, Any]


class _LedgerRecorder:
    def __init__(self, _redis_client: Any, _repo_key: str) -> None:
        self.mark_results: list[_LedgerMark] = []
        self.mark_running_calls: list[str] = []
        self.upsert_calls: list[Any] = []

    def get(self, _run_id: str) -> None:
        return None

    def upsert(self, entry: Any) -> None:
        self.upsert_calls.append(entry)

    def mark_running(self, run_id: str) -> None:
        self.mark_running_calls.append(run_id)

    def mark_result(self, run_id: str, *, status: str, result: dict[str, Any]) -> None:
        self.mark_results.append(_LedgerMark(run_id=run_id, status=status, result=result))

    def touch_task_last_activity(self, _project_item_id: str, *, at_iso: str) -> None:  # noqa: ARG002
        return None


class SupervisorFaultInjectionTests(unittest.TestCase):
    def test_watchdog_escalates_terminate_to_kill(self) -> None:
        role = "REVIEWER"
        repo_key = "example.repo"
        queue_key = f"orchestrator:queue:intents:{role}:{repo_key}"
        run_id = "run-timeout-1"
        intent_payload = {
            "type": "RUN_INTENT",
            "role": role,
            "run_id": run_id,
            "endpoint": "/internal/reviewer/resolve-linked-pr",
            "body": {"role": role, "run_id": run_id, "issue_number": 42},
        }

        redis_client = _SingleIntentRedis(queue_key=queue_key, intent_payload=intent_payload)
        hung_process = _HungChildProcess()
        spawn_context = _FakeSpawnContext(hung_process)
        ledger = _LedgerRecorder(redis_client, repo_key)
        release_calls: list[tuple[int, str]] = []

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=object()):
                with patch("apps.runner.supervisor.RedisStateStore", return_value=_FakeStateStore(redis_client)):
                    with patch("apps.runner.supervisor.RunLedger", return_value=ledger):
                        with patch("apps.runner.supervisor.get_context", return_value=spawn_context):
                            with patch("apps.runner.supervisor.acquire_in_flight_lock", return_value=True):
                                with patch(
                                    "apps.runner.supervisor.release_in_flight_lock",
                                    side_effect=lambda **kwargs: release_calls.append(
                                        (int(kwargs.get("issue_number") or 0), str(kwargs.get("run_id") or ""))
                                    ),
                                ):
                                    with self.assertRaises(KeyboardInterrupt):
                                        run_supervisor_loop(
                                            role=role,
                                            repo_key=repo_key,
                                            redis_url="redis://localhost:6379/0",
                                            backend_base_url="http://localhost:4000",
                                            backend_timeout_s=5.0,
                                            codex_bin="codex",
                                            codex_mcp_args="mcp-server",
                                            codex_tools_call_timeout_s=120.0,
                                            watchdog_timeout_s=1,
                                        )

        self.assertTrue(hung_process.started)
        self.assertTrue(hung_process.terminate_called)
        self.assertTrue(hung_process.kill_called)
        self.assertEqual(release_calls, [(42, run_id)])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, run_id)
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("failure_classification"), "HARD_STOP")
        self.assertEqual(mark.result.get("error_code"), "watchdog_timeout")
