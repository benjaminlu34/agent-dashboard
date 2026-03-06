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


class _QueueMustNotBeRead:
    def get_nowait(self) -> dict[str, Any]:
        raise AssertionError("preempted runs must not read child IPC results")


class _ChildProcess:
    def __init__(self, *, survive_terminate: bool) -> None:
        self.started = False
        self.terminate_called = False
        self.kill_called = False
        self.exitcode = None
        self._alive = False
        self.join_timeouts: list[float | None] = []
        self._survive_terminate = survive_terminate

    def start(self) -> None:
        self.started = True
        self._alive = True

    def join(self, timeout: float | None = None) -> None:
        self.join_timeouts.append(timeout)

    def is_alive(self) -> bool:
        return self._alive

    def terminate(self) -> None:
        self.terminate_called = True
        if not self._survive_terminate:
            self._alive = False

    def kill(self) -> None:
        self.kill_called = True
        self._alive = False
        self.exitcode = -9


class _FakeSpawnContext:
    def __init__(self, process: _ChildProcess, queue: Any) -> None:
        self._process = process
        self._queue = queue

    def Queue(self, maxsize: int = 1) -> Any:  # noqa: ARG002
        return self._queue

    def Process(self, *args, **kwargs) -> _ChildProcess:  # noqa: ANN002, ARG002
        return self._process


class _FakeStateStore:
    def __init__(
        self,
        initial_items: dict[str, dict[str, Any]] | None = None,
        polled_items: list[dict[str, Any] | None] | None = None,
    ) -> None:
        self._initial_items = initial_items or {}
        self._polled_items = list(polled_items or [])
        self.polled_project_item_ids: list[str] = []

    def get_all_items(self, _repo_key: str) -> dict[str, dict[str, Any]]:
        return self._initial_items

    def get_item(self, _repo_key: str, project_item_id: str) -> dict[str, Any] | None:
        self.polled_project_item_ids.append(project_item_id)
        if self._polled_items:
            return self._polled_items.pop(0)
        return None

    def set_item(self, _repo_key: str, _project_item_id: str, _item_dict: dict[str, Any]) -> None:
        return None


class _FakeTime:
    def __init__(self, *, start: float = 100.0, step: float = 0.6) -> None:
        self._value = start
        self._step = step

    def __call__(self) -> float:
        current = self._value
        self._value += self._step
        return current


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
    def _run_supervisor_once(
        self,
        *,
        role: str,
        run_id: str,
        issue_number: int,
        process: _ChildProcess,
        queue: Any,
        state_store: _FakeStateStore,
        watchdog_timeout_s: int,
    ) -> tuple[_LedgerRecorder, list[tuple[int, str]]]:
        repo_key = "example.repo"
        queue_key = f"orchestrator:queue:intents:{role}:{repo_key}"
        intent_payload = {
            "type": "RUN_INTENT",
            "role": role,
            "run_id": run_id,
            "endpoint": "/internal/reviewer/resolve-linked-pr",
            "body": {"role": role, "run_id": run_id, "issue_number": issue_number},
        }

        redis_client = _SingleIntentRedis(queue_key=queue_key, intent_payload=intent_payload)
        spawn_context = _FakeSpawnContext(process, queue)
        ledger = _LedgerRecorder(redis_client, repo_key)
        release_calls: list[tuple[int, str]] = []

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=object()):
                with patch("apps.runner.supervisor.RedisStateStore", return_value=state_store):
                    with patch("apps.runner.supervisor.RunLedger", return_value=ledger):
                        with patch("apps.runner.supervisor.get_context", return_value=spawn_context):
                            with patch("apps.runner.supervisor.acquire_in_flight_lock", return_value=True):
                                with patch("apps.runner.supervisor.time.time", side_effect=_FakeTime()):
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
                                                watchdog_timeout_s=watchdog_timeout_s,
                                            )

        return ledger, release_calls

    def test_watchdog_escalates_terminate_to_kill(self) -> None:
        process = _ChildProcess(survive_terminate=True)
        state_store = _FakeStateStore()

        ledger, release_calls = self._run_supervisor_once(
            role="REVIEWER",
            run_id="run-timeout-1",
            issue_number=42,
            process=process,
            queue=_QueueEmpty(),
            state_store=state_store,
            watchdog_timeout_s=1,
        )

        self.assertTrue(process.started)
        self.assertTrue(process.terminate_called)
        self.assertTrue(process.kill_called)
        self.assertEqual(release_calls, [(42, "run-timeout-1")])
        self.assertEqual(state_store.polled_project_item_ids, [])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "run-timeout-1")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("failure_classification"), "HARD_STOP")
        self.assertEqual(mark.result.get("error_code"), "watchdog_timeout")

    def test_preempts_when_item_moves_to_terminal_state(self) -> None:
        project_item_id = "PVTI_42"
        initial_items = {
            project_item_id: {
                "last_seen_issue_number": 42,
                "last_seen_status": "In Progress",
                "last_seen_at": "2026-03-06T00:00:00Z",
                "status_since_at": "2026-03-06T00:00:00Z",
            }
        }
        state_store = _FakeStateStore(
            initial_items=initial_items,
            polled_items=[{"last_seen_status": "Done"}],
        )
        process = _ChildProcess(survive_terminate=False)

        ledger, release_calls = self._run_supervisor_once(
            role="REVIEWER",
            run_id="run-preempted-done",
            issue_number=42,
            process=process,
            queue=_QueueMustNotBeRead(),
            state_store=state_store,
            watchdog_timeout_s=30,
        )

        self.assertTrue(process.started)
        self.assertTrue(process.terminate_called)
        self.assertFalse(process.kill_called)
        self.assertEqual(state_store.polled_project_item_ids, [project_item_id])
        self.assertEqual(release_calls, [(42, "run-preempted-done")])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "run-preempted-done")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("failure_classification"), "PREEMPTED")
        self.assertEqual(mark.result.get("error_code"), "preempted")

    def test_preempts_when_tracked_item_disappears(self) -> None:
        project_item_id = "PVTI_42"
        initial_items = {
            project_item_id: {
                "last_seen_issue_number": 42,
                "last_seen_status": "In Review",
                "last_seen_at": "2026-03-06T00:00:00Z",
                "status_since_at": "2026-03-06T00:00:00Z",
            }
        }
        state_store = _FakeStateStore(
            initial_items=initial_items,
            polled_items=[None],
        )
        process = _ChildProcess(survive_terminate=False)

        ledger, release_calls = self._run_supervisor_once(
            role="REVIEWER",
            run_id="run-preempted-missing",
            issue_number=42,
            process=process,
            queue=_QueueMustNotBeRead(),
            state_store=state_store,
            watchdog_timeout_s=30,
        )

        self.assertTrue(process.started)
        self.assertTrue(process.terminate_called)
        self.assertFalse(process.kill_called)
        self.assertEqual(state_store.polled_project_item_ids, [project_item_id])
        self.assertEqual(release_calls, [(42, "run-preempted-missing")])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "run-preempted-missing")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("failure_classification"), "PREEMPTED")
        self.assertEqual(mark.result.get("error_code"), "preempted")


if __name__ == "__main__":
    unittest.main()
