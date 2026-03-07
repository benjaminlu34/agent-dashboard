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


class _QueueWithPayload:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def get_nowait(self) -> dict[str, Any]:
        return self._payload


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


class _CompletingChildProcess(_ChildProcess):
    def __init__(self) -> None:
        super().__init__(survive_terminate=False)

    def join(self, timeout: float | None = None) -> None:
        super().join(timeout)
        self._alive = False
        self.exitcode = 0


class _FakeSpawnContext:
    def __init__(self, process: _ChildProcess, queue: Any) -> None:
        self._process = process
        self._queue = queue
        self.value = _SharedValue(100.0)

    def Queue(self, maxsize: int = 1) -> Any:  # noqa: ARG002
        return self._queue

    def Process(self, *args, **kwargs) -> _ChildProcess:  # noqa: ANN002, ARG002
        return self._process

    def Value(self, _typecode: str, value: float) -> Any:
        self.value = _SharedValue(value)
        return self.value


class _SharedValue:
    def __init__(self, value: float) -> None:
        self.value = value


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
        return self._initial_items.get(project_item_id)

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
        self.task_failure_records: list[tuple[str, str, str]] = []
        self.task_failure_resets: list[str] = []

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

    def record_task_failure(self, project_item_id: str, *, run_id: str, at_iso: str) -> dict[str, Any]:
        self.task_failure_records.append((project_item_id, run_id, at_iso))
        return {
            "consecutive_failures": 1,
            "last_failure_at": at_iso,
            "last_failure_run_id": run_id,
        }

    def reset_task_failures(self, project_item_id: str) -> None:
        self.task_failure_resets.append(project_item_id)


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
        stall_timeout_s: float = 300.0,
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
                                                stall_timeout_s=stall_timeout_s,
                                            )

        return ledger, release_calls

    def test_watchdog_escalates_terminate_to_kill(self) -> None:
        project_item_id = "PVTI_42"
        process = _ChildProcess(survive_terminate=True)
        state_store = _FakeStateStore(
            initial_items={
                project_item_id: {
                    "last_seen_issue_number": 42,
                    "last_seen_status": "In Review",
                    "last_seen_at": "2026-03-06T00:00:00Z",
                    "status_since_at": "2026-03-06T00:00:00Z",
                    "last_run_id": "11111111-1111-4111-8111-111111111111",
                }
            }
        )

        ledger, release_calls = self._run_supervisor_once(
            role="REVIEWER",
            run_id="11111111-1111-4111-8111-111111111111",
            issue_number=42,
            process=process,
            queue=_QueueEmpty(),
            state_store=state_store,
            watchdog_timeout_s=1,
        )

        self.assertTrue(process.started)
        self.assertTrue(process.terminate_called)
        self.assertTrue(process.kill_called)
        self.assertEqual(release_calls, [(42, "11111111-1111-4111-8111-111111111111")])
        self.assertEqual(state_store.polled_project_item_ids, [project_item_id])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "11111111-1111-4111-8111-111111111111")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("usage"), {})
        self.assertEqual(mark.result.get("failure_classification"), "HARD_STOP")
        self.assertEqual(mark.result.get("error_code"), "watchdog_timeout")
        self.assertEqual(len(ledger.task_failure_records), 1)
        self.assertEqual(ledger.task_failure_records[0][0], project_item_id)

    def test_stall_timeout_kills_idle_worker_before_global_watchdog(self) -> None:
        project_item_id = "PVTI_42"
        process = _ChildProcess(survive_terminate=False)
        state_store = _FakeStateStore(
            initial_items={
                project_item_id: {
                    "last_seen_issue_number": 42,
                    "last_seen_status": "In Review",
                    "last_seen_at": "2026-03-06T00:00:00Z",
                    "status_since_at": "2026-03-06T00:00:00Z",
                    "last_run_id": "44444444-4444-4444-8444-444444444444",
                }
            }
        )

        ledger, release_calls = self._run_supervisor_once(
            role="REVIEWER",
            run_id="44444444-4444-4444-8444-444444444444",
            issue_number=42,
            process=process,
            queue=_QueueEmpty(),
            state_store=state_store,
            watchdog_timeout_s=30,
            stall_timeout_s=1.0,
        )

        self.assertTrue(process.started)
        self.assertTrue(process.terminate_called)
        self.assertFalse(process.kill_called)
        self.assertEqual(release_calls, [(42, "44444444-4444-4444-8444-444444444444")])
        self.assertEqual(state_store.polled_project_item_ids, [])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "44444444-4444-4444-8444-444444444444")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("usage"), {})
        self.assertEqual(mark.result.get("failure_classification"), "STALLED")
        self.assertEqual(mark.result.get("error_code"), "stall_timeout")
        self.assertEqual(len(ledger.task_failure_records), 1)
        self.assertEqual(ledger.task_failure_records[0][0], project_item_id)

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
            run_id="22222222-2222-4222-8222-222222222222",
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
        self.assertEqual(release_calls, [(42, "22222222-2222-4222-8222-222222222222")])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "22222222-2222-4222-8222-222222222222")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("usage"), {})
        self.assertEqual(mark.result.get("failure_classification"), "PREEMPTED")
        self.assertEqual(mark.result.get("error_code"), "preempted")
        self.assertEqual(len(ledger.task_failure_records), 1)
        self.assertEqual(ledger.task_failure_records[0][0], project_item_id)

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
            run_id="33333333-3333-4333-8333-333333333333",
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
        self.assertEqual(release_calls, [(42, "33333333-3333-4333-8333-333333333333")])

        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "33333333-3333-4333-8333-333333333333")
        self.assertEqual(mark.status, "failed")
        self.assertEqual(mark.result.get("usage"), {})
        self.assertEqual(mark.result.get("failure_classification"), "PREEMPTED")
        self.assertEqual(mark.result.get("error_code"), "preempted")
        self.assertEqual(len(ledger.task_failure_records), 1)
        self.assertEqual(ledger.task_failure_records[0][0], project_item_id)

    def test_success_result_preserves_usage_from_child_ipc(self) -> None:
        process = _CompletingChildProcess()
        state_store = _FakeStateStore(
            initial_items={
                "PVTI_42": {
                    "last_seen_issue_number": 42,
                    "last_seen_status": "In Review",
                    "last_seen_at": "2026-03-06T00:00:00Z",
                    "status_since_at": "2026-03-06T00:00:00Z",
                    "last_run_id": "55555555-5555-4555-8555-555555555555",
                }
            }
        )

        ledger, release_calls = self._run_supervisor_once(
            role="EXECUTOR",
            run_id="55555555-5555-4555-8555-555555555555",
            issue_number=42,
            process=process,
            queue=_QueueWithPayload(
                {
                    "run_id": "55555555-5555-4555-8555-555555555555",
                    "role": "EXECUTOR",
                    "status": "succeeded",
                    "outcome": None,
                    "summary": "ok",
                    "urls": {},
                    "errors": [],
                    "usage": {"input_tokens": 13, "output_tokens": 5},
                    "marker_verified": None,
                }
            ),
            state_store=state_store,
            watchdog_timeout_s=30,
        )

        self.assertEqual(release_calls, [(42, "55555555-5555-4555-8555-555555555555")])
        self.assertEqual(len(ledger.mark_results), 1)
        mark = ledger.mark_results[0]
        self.assertEqual(mark.run_id, "55555555-5555-4555-8555-555555555555")
        self.assertEqual(mark.status, "succeeded")
        self.assertEqual(mark.result.get("usage"), {"input_tokens": 13, "output_tokens": 5})
        self.assertEqual(ledger.task_failure_resets, ["PVTI_42"])


if __name__ == "__main__":
    unittest.main()
