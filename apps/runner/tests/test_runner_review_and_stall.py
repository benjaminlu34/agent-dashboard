import contextlib
import io
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.runner.codex_worker import WorkerResult
from apps.runner.intents import parse_intent
from apps.runner.ledger import RunLedger
from apps.runner.runner import Runner


class _BackendStub:
    def __init__(self) -> None:
        self.base_url = "http://localhost:4000"
        self.calls = []

    def get_agent_context(self, role: str):
        return {"role": role, "files": []}

    def post_json(self, path: str, *, body):
        self.calls.append((path, body))
        if path == "/internal/reviewer/resolve-linked-pr":
            issue_number = body.get("issue_number")
            return {
                "pr_number": 55,
                "pr_url": f"https://github.com/example/repo/pull/{issue_number}",
                "issue_number": issue_number,
                "project_item_id": "PVTI_2",
                "run_id": "linked-run",
            }
        if path == "/internal/project-item/update-field":
            return {"updated": {"Status": body.get("value")}}
        return {"ok": True}


class _LedgerStub:
    def __init__(self, payload):
        self._payload = payload
        self.mark_result_calls = []

    def get(self, run_id: str):
        return self._payload.get(run_id)

    def mark_result(self, run_id: str, *, status: str, result):
        self.mark_result_calls.append((run_id, status, result))
        self._payload[run_id] = {"status": status, "result": result}


def _build_runner(
    *,
    backend,
    state_path: str,
    ledger=None,
    review_stall_polls=50,
    blocked_retry_minutes=15,
    watchdog_timeout_s=900,
):
    return Runner(
        backend=backend,
        ledger=ledger,
        dry_run=False,
        codex_bin="codex",
        codex_mcp_args="mcp-server",
        codex_tools_call_timeout_s=600.0,
        orchestrator_state_path=state_path,
        review_stall_polls=review_stall_polls,
        blocked_retry_minutes=blocked_retry_minutes,
        watchdog_timeout_s=watchdog_timeout_s,
    )


class RunnerReviewAndStallTests(unittest.TestCase):
    def test_dispatch_summary_handler_errors_are_isolated(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=None)
            summary = {"processed_items": []}

            with patch.object(runner, "_recover_passed_in_review_items", return_value=None) as pass_recovery_mock:
                with patch.object(runner, "_recover_lost_in_review_reviewer_dispatches", side_effect=RuntimeError("boom")):
                    with patch.object(runner, "_handle_review_stall", return_value=None) as review_stall_mock:
                        with patch.object(runner, "_handle_blocked_retries", return_value=None) as blocked_retry_mock:
                            with patch.object(runner, "_handle_in_review_cycle_caps", return_value=None) as cycle_caps_mock:
                                with patch.object(runner, "_handle_running_watchdog", return_value=None) as watchdog_mock:
                                    stderr = io.StringIO()
                                    with contextlib.redirect_stderr(stderr):
                                        runner.handle_dispatch_summary(summary=summary)

            self.assertEqual(pass_recovery_mock.call_count, 1)
            self.assertEqual(review_stall_mock.call_count, 1)
            self.assertEqual(blocked_retry_mock.call_count, 1)
            self.assertEqual(cycle_caps_mock.call_count, 1)
            self.assertEqual(watchdog_mock.call_count, 1)
            self.assertIn('"type":"DISPATCH_SUMMARY_HANDLER_FAILED"', stderr.getvalue())
            self.assertIn('"handler":"recover_lost_in_review_reviewer_dispatches"', stderr.getvalue())

    def test_stale_in_review_pass_is_recovered_to_needs_human_approval(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 142,
                        "items": {
                            "PVTI_2": {
                                "last_seen_issue_number": 2,
                                "last_seen_status": "In Review",
                                "last_reviewer_outcome": "PASS",
                                "last_reviewer_feedback_at": "2026-02-27T02:00:00.000Z",
                                "last_run_id": "review-pass-run",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=None)
            summary = {
                "processed_items": [{"issue_number": 2, "project_item_id": "PVTI_2", "status": "In Review"}],
                "needs_attention": {"stalled_in_progress": [], "in_review_churn": []},
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Needs Human Approval")
        self.assertIn('"type":"REVIEW_PASS_RECOVERED"', stderr.getvalue())

    def test_executor_and_reviewer_same_issue_are_serialized_by_in_flight_gate(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 1,
                        "items": {
                            "PVTI_2": {
                                "last_seen_issue_number": 2,
                                "last_seen_status": "In Progress",
                                "last_dispatched_role": "EXECUTOR",
                                "last_run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=None)
            exec_intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "endpoint": "/internal/executor/claim-ready-item",
                    "body": {
                        "role": "EXECUTOR",
                        "run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "sprint": "M1",
                    },
                }
            )
            reviewer_intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "REVIEWER",
                        "run_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        "issue_number": 2,
                    },
                }
            )

            executor_started = threading.Event()
            allow_executor_finish = threading.Event()
            executor_finished = threading.Event()
            reviewer_worker_started = threading.Event()
            ordering: dict[str, float] = {}
            ordering_lock = threading.Lock()
            failures = []

            def fake_worker_call(*, intent, **_kwargs):
                role = intent.get("role")
                if role == "EXECUTOR":
                    executor_started.set()
                    allow_executor_finish.wait(timeout=3.0)
                    return WorkerResult(
                        run_id=exec_intent.run_id,
                        role="EXECUTOR",
                        status="succeeded",
                        outcome=None,
                        summary="executor done",
                        urls={},
                        errors=[],
                    )

                reviewer_worker_started.set()
                with ordering_lock:
                    ordering["reviewer_started"] = time.monotonic()
                return WorkerResult(
                    run_id=reviewer_intent.run_id,
                    role="REVIEWER",
                    status="succeeded",
                    outcome="FAIL",
                    summary="reviewer done",
                    urls={},
                    errors=[],
                )

            def run_intent(intent_obj):
                try:
                    runner._handle_intent(intent_obj)  # pylint: disable=protected-access
                    if intent_obj.run_id == exec_intent.run_id:
                        with ordering_lock:
                            ordering["executor_finished"] = time.monotonic()
                        executor_finished.set()
                except Exception as exc:  # pragma: no cover - test assertion handles this list
                    failures.append(exc)

            with patch("apps.runner.runner.run_intent_with_codex_mcp", side_effect=fake_worker_call):
                executor_thread = threading.Thread(target=run_intent, args=(exec_intent,), daemon=True)
                reviewer_thread = threading.Thread(target=run_intent, args=(reviewer_intent,), daemon=True)

                executor_thread.start()
                self.assertTrue(executor_started.wait(timeout=1.0))
                reviewer_thread.start()

                # Reviewer must wait until executor releases the issue slot.
                time.sleep(0.2)
                self.assertFalse(reviewer_worker_started.is_set())

                allow_executor_finish.set()
                self.assertTrue(executor_finished.wait(timeout=2.0))
                executor_thread.join(timeout=2.0)
                reviewer_thread.join(timeout=2.0)

            self.assertEqual(failures, [])
            self.assertTrue(reviewer_worker_started.is_set())
            self.assertGreaterEqual(
                ordering.get("reviewer_started", 0.0),
                ordering.get("executor_finished", 0.0),
            )

    def test_missing_reviewer_outcome_fails_closed(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger = RunLedger(f"{tmp_dir}/runner-ledger.json")
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=ledger)
            intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "10101010-1010-4010-8010-101010101010",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "REVIEWER",
                        "run_id": "10101010-1010-4010-8010-101010101010",
                        "issue_number": 2,
                    },
                }
            )

            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=intent.run_id,
                    role="REVIEWER",
                    status="succeeded",
                    outcome=None,
                    summary="No outcome provided.",
                    urls={},
                    errors=[],
                ),
            ):
                with self.assertRaises(Exception):
                    runner._handle_intent(intent)  # pylint: disable=protected-access

            entry = ledger.get(intent.run_id)
            self.assertEqual(entry["result"]["reviewer_outcome"], "INCOMPLETE")

    def test_reviewer_outcome_is_recorded_in_ledger(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger = RunLedger(f"{tmp_dir}/runner-ledger.json")
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=ledger)
            intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "REVIEWER",
                        "run_id": "11111111-1111-4111-8111-111111111111",
                        "issue_number": 2,
                    },
                }
            )

            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=intent.run_id,
                    role="REVIEWER",
                    status="succeeded",
                    outcome="FAIL",
                    summary="Blocking findings posted as issue comment.",
                    urls={},
                    errors=[],
                ),
            ):
                runner._handle_intent(intent)  # pylint: disable=protected-access

            entry = ledger.get(intent.run_id)
            self.assertEqual(entry["result"]["reviewer_outcome"], "FAIL")
            update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
            self.assertEqual(update_calls, [])

    def test_executor_pr_run_requires_marker_verified(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger = RunLedger(f"{tmp_dir}/runner-ledger.json")
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=ledger)
            intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "1f1f1f1f-1111-4111-8111-111111111111",
                    "endpoint": "/internal/executor/claim-ready-item",
                    "body": {
                        "role": "EXECUTOR",
                        "run_id": "1f1f1f1f-1111-4111-8111-111111111111",
                        "sprint": "M1",
                    },
                }
            )
            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=intent.run_id,
                    role="EXECUTOR",
                    status="succeeded",
                    outcome=None,
                    summary="Opened PR.",
                    urls={"pr_url": "https://github.com/example/repo/pull/1"},
                    errors=[],
                    marker_verified=False,
                ),
            ):
                with self.assertRaises(Exception):
                    runner._handle_intent(intent)  # pylint: disable=protected-access

    def test_executor_pr_run_requires_marker_verified_for_pull_request_url_key(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger = RunLedger(f"{tmp_dir}/runner-ledger.json")
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=ledger)
            intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "2f2f2f2f-2222-4222-8222-222222222222",
                    "endpoint": "/internal/executor/claim-ready-item",
                    "body": {
                        "role": "EXECUTOR",
                        "run_id": "2f2f2f2f-2222-4222-8222-222222222222",
                        "sprint": "M1",
                    },
                }
            )
            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=intent.run_id,
                    role="EXECUTOR",
                    status="succeeded",
                    outcome=None,
                    summary="Opened PR.",
                    urls={"pull_request": "https://github.com/example/repo/pull/2"},
                    errors=[],
                    marker_verified=False,
                ),
            ):
                with self.assertRaises(Exception):
                    runner._handle_intent(intent)  # pylint: disable=protected-access

    def test_reviewer_pass_moves_item_to_needs_human_approval(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            runner = _build_runner(backend=backend, state_path=f"{tmp_dir}/orchestrator-state.json", ledger=None)
            intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "22222222-2222-4222-8222-222222222222",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "REVIEWER",
                        "run_id": "22222222-2222-4222-8222-222222222222",
                        "issue_number": 2,
                    },
                }
            )

            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=intent.run_id,
                    role="REVIEWER",
                    status="succeeded",
                    outcome="PASS",
                    summary="All checks passed.",
                    urls={},
                    errors=[],
                ),
            ):
                runner._handle_intent(intent)  # pylint: disable=protected-access

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        _, payload = update_calls[0]
        self.assertEqual(payload["role"], "ORCHESTRATOR")
        self.assertEqual(payload["value"], "Needs Human Approval")
        self.assertEqual(payload["issue_number"], 2)

    def test_in_review_feedback_then_executor_response_updates_state_timestamps(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 1,
                        "items": {
                            "PVTI_2": {
                                "last_seen_issue_number": 2,
                                "last_seen_status": "In Review",
                                "last_dispatched_role": "REVIEWER",
                                "last_run_id": "review-run",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=None)
            review_intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "REVIEWER",
                        "run_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "issue_number": 2,
                    },
                }
            )
            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=review_intent.run_id,
                    role="REVIEWER",
                    status="succeeded",
                    outcome="FAIL",
                    summary="Blocking findings posted.",
                    urls={},
                    errors=[],
                ),
            ):
                runner._handle_intent(review_intent)  # pylint: disable=protected-access

            state_after_review = json.loads(Path(state_path).read_text(encoding="utf-8"))
            feedback_at = state_after_review["items"]["PVTI_2"].get("last_reviewer_feedback_at")
            self.assertTrue(isinstance(feedback_at, str) and feedback_at)

            state_after_review["items"]["PVTI_2"]["last_dispatched_role"] = "EXECUTOR"
            state_after_review["items"]["PVTI_2"]["last_run_id"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            Path(state_path).write_text(json.dumps(state_after_review), encoding="utf-8")

            exec_intent = parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {
                        "role": "EXECUTOR",
                        "run_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        "issue_number": 2,
                    },
                }
            )
            with patch(
                "apps.runner.runner.run_intent_with_codex_mcp",
                return_value=WorkerResult(
                    run_id=exec_intent.run_id,
                    role="EXECUTOR",
                    status="succeeded",
                    outcome=None,
                    summary="Addressed review feedback.",
                    urls={},
                    errors=[],
                ),
            ):
                runner._handle_intent(exec_intent)  # pylint: disable=protected-access

            state_after_exec = json.loads(Path(state_path).read_text(encoding="utf-8"))
            executor_at = state_after_exec["items"]["PVTI_2"].get("last_executor_response_at")
            self.assertTrue(isinstance(executor_at, str) and executor_at)
            self.assertGreater(executor_at, feedback_at)

    def test_double_stall_escalates_to_needs_human_approval(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 60,
                        "items": {
                            "PVTI_2": {
                                "last_seen_issue_number": 2,
                                "last_seen_status": "In Review",
                                "reviewer_dispatches_for_current_status": 2,
                                "last_run_id": "review-run-2",
                                "status_since_at": "2026-02-08T00:00:00.000Z",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=None, review_stall_polls=50)
            summary = {
                "needs_attention": {
                    "in_review_churn": [
                        {
                            "issue_number": 2,
                            "project_item_id": "PVTI_2",
                            "in_review_polls": 51,
                            "last_run_id": "review-run-2",
                        }
                    ]
                },
                "processed_items": [{"issue_number": 2, "project_item_id": "PVTI_2", "status": "In Review"}],
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)

        text = stderr.getvalue()
        self.assertIn('"type":"REVIEW_STALL_DETECTED"', text)
        self.assertIn('"type":"REVIEW_STALL_ESCALATED"', text)
        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Needs Human Approval")

    def test_stale_reviewer_dispatch_without_ledger_entry_is_recovered(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub({})
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 120,
                        "items": {
                            "PVTI_4": {
                                "last_seen_issue_number": 4,
                                "last_seen_status": "In Review",
                                "reviewer_dispatches_for_current_status": 1,
                                "last_run_id": "review-run-lost",
                                "last_dispatched_role": "REVIEWER",
                                "last_dispatched_status": "In Review",
                                "last_dispatched_at": "2026-02-08T00:00:00.000Z",
                                "last_dispatched_poll": 105,
                                "last_reviewer_outcome": "",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=ledger, review_stall_polls=50)
            summary = {
                "poll_count": 121,
                "processed_items": [{"issue_number": 4, "project_item_id": "PVTI_4", "status": "In Review"}],
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)

            state_after_recovery = json.loads(Path(state_path).read_text(encoding="utf-8"))

        state_item = state_after_recovery["items"]["PVTI_4"]
        self.assertEqual(state_item["last_dispatched_role"], "")
        self.assertEqual(state_item["last_dispatched_status"], "")
        self.assertEqual(state_item["last_dispatched_at"], "")
        self.assertEqual(state_item["last_dispatched_poll"], 0)
        self.assertEqual(state_item["last_run_id"], "review-run-lost")
        self.assertIn('"type":"REVIEW_DISPATCH_RECOVERED"', stderr.getvalue())

    def test_stale_reviewer_dispatch_is_not_recovered_in_same_poll_epoch(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub({})
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 200,
                        "items": {
                            "PVTI_7": {
                                "last_seen_issue_number": 7,
                                "last_seen_status": "In Review",
                                "reviewer_dispatches_for_current_status": 1,
                                "last_run_id": "review-run-same-poll",
                                "last_dispatched_role": "REVIEWER",
                                "last_dispatched_status": "In Review",
                                "last_dispatched_at": "2026-02-08T00:00:00.000Z",
                                "last_dispatched_poll": 200,
                                "last_reviewer_outcome": "",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=ledger, review_stall_polls=50)
            summary = {
                "poll_count": 200,
                "processed_items": [{"issue_number": 7, "project_item_id": "PVTI_7", "status": "In Review"}],
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)

            state_after = json.loads(Path(state_path).read_text(encoding="utf-8"))

        state_item = state_after["items"]["PVTI_7"]
        self.assertEqual(state_item["last_dispatched_role"], "REVIEWER")
        self.assertEqual(state_item["last_dispatched_status"], "In Review")
        self.assertEqual(state_item["last_dispatched_poll"], 200)
        self.assertNotIn('"type":"REVIEW_DISPATCH_RECOVERED"', stderr.getvalue())

    def test_blocked_retry_triggers_after_cooldown_for_retryable_failure(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub(
            {
                "run-retryable": {
                    "status": "failed",
                    "result": {
                        "failure_classification": "TRANSIENT",
                        "error_code": "backend_unreachable",
                    },
                }
            }
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 10,
                        "items": {
                            "PVTI_4": {
                                "last_seen_issue_number": 4,
                                "last_seen_status": "Blocked",
                                "status_since_at": "2026-02-08T00:00:00.000Z",
                                "last_run_id": "run-retryable",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=ledger, blocked_retry_minutes=15)
            summary = {"processed_items": [{"issue_number": 4, "project_item_id": "PVTI_4", "status": "Blocked"}]}
            runner.handle_dispatch_summary(summary=summary)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Ready")

    def test_blocked_retry_skips_non_retryable_failure(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub(
            {
                "run-hard-stop": {
                    "status": "failed",
                    "result": {
                        "failure_classification": "HARD_STOP",
                        "error_code": "worker_invalid_output",
                    },
                }
            }
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 10,
                        "items": {
                            "PVTI_5": {
                                "last_seen_issue_number": 5,
                                "last_seen_status": "Blocked",
                                "status_since_at": "2026-02-08T00:00:00.000Z",
                                "last_run_id": "run-hard-stop",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            runner = _build_runner(backend=backend, state_path=state_path, ledger=ledger, blocked_retry_minutes=15)
            summary = {"processed_items": [{"issue_number": 5, "project_item_id": "PVTI_5", "status": "Blocked"}]}
            runner.handle_dispatch_summary(summary=summary)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(update_calls, [])

    def test_watchdog_times_out_running_executor_and_blocks_item(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub(
            {
                "run-watchdog": {
                    "status": "running",
                    "running_at": "2026-02-08T00:00:00.000Z",
                    "received_at": "2026-02-08T00:00:00.000Z",
                    "result": None,
                }
            }
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 1,
                        "items": {
                            "PVTI_W": {
                                "last_seen_issue_number": 42,
                                "last_seen_status": "In Progress",
                                "last_run_id": "run-watchdog",
                                "last_dispatched_role": "EXECUTOR",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            runner = _build_runner(
                backend=backend,
                state_path=state_path,
                ledger=ledger,
                watchdog_timeout_s=1,
            )
            summary = {
                "processed_items": [
                    {"issue_number": 42, "project_item_id": "PVTI_W", "status": "In Progress"},
                ]
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)
            self.assertIn('"type":"WORKER_WATCHDOG_TIMEOUT"', stderr.getvalue())
            self.assertEqual(len(ledger.mark_result_calls), 1)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Blocked")

    def test_watchdog_times_out_running_executor_in_review_and_blocks_item(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub(
            {
                "run-watchdog-review": {
                    "status": "running",
                    "running_at": "2026-02-08T00:00:00.000Z",
                    "received_at": "2026-02-08T00:00:00.000Z",
                    "result": None,
                }
            }
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 1,
                        "items": {
                            "PVTI_W2": {
                                "last_seen_issue_number": 52,
                                "last_seen_status": "In Review",
                                "last_run_id": "run-watchdog-review",
                                "last_dispatched_role": "EXECUTOR",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            runner = _build_runner(
                backend=backend,
                state_path=state_path,
                ledger=ledger,
                watchdog_timeout_s=1,
            )
            summary = {
                "processed_items": [
                    {"issue_number": 52, "project_item_id": "PVTI_W2", "status": "In Review"},
                ]
            }
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                runner.handle_dispatch_summary(summary=summary)
            self.assertIn('"type":"WORKER_WATCHDOG_TIMEOUT"', stderr.getvalue())
            self.assertEqual(len(ledger.mark_result_calls), 1)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Blocked")

    def test_watchdog_times_out_running_reviewer_in_review_and_recovers_dispatch_state(self) -> None:
        backend = _BackendStub()
        ledger = _LedgerStub(
            {
                "run-watchdog-reviewer": {
                    "status": "running",
                    "role": "REVIEWER",
                    "running_at": "2026-02-08T00:00:00.000Z",
                    "received_at": "2026-02-08T00:00:00.000Z",
                    "result": None,
                }
            }
        )
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 1,
                        "items": {
                            "PVTI_R": {
                                "last_seen_issue_number": 62,
                                "last_seen_status": "In Review",
                                "last_run_id": "run-watchdog-reviewer",
                                "last_dispatched_role": "REVIEWER",
                                "last_dispatched_status": "In Review",
                                "last_dispatched_at": "2026-02-08T00:10:00.000Z",
                                "last_dispatched_poll": 1,
                                "reviewer_dispatches_for_current_status": 1,
                                "last_reviewer_outcome": "INCOMPLETE",
                                "last_reviewer_feedback_at": "2026-02-08T00:10:00.000Z",
                                "last_executor_response_at": "2026-02-08T00:20:00.000Z",
                                "review_cycle_count": 1,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            runner = _build_runner(
                backend=backend,
                state_path=state_path,
                ledger=ledger,
                watchdog_timeout_s=1,
            )
            summary = {
                "processed_items": [
                    {"issue_number": 62, "project_item_id": "PVTI_R", "status": "In Review"},
                ]
            }
            stderr = io.StringIO()
            with patch("apps.runner.runner._utc_now_iso", return_value="2026-02-27T01:00:00Z"):
                with contextlib.redirect_stderr(stderr):
                    runner.handle_dispatch_summary(summary=summary)

            logs = stderr.getvalue()
            self.assertIn('"type":"WORKER_WATCHDOG_TIMEOUT"', logs)
            self.assertIn('"type":"WORKER_WATCHDOG_TIMEOUT_RECOVERY"', logs)

            state_after = json.loads(Path(state_path).read_text(encoding="utf-8"))
            item = state_after["items"]["PVTI_R"]
            self.assertEqual(item["last_dispatched_role"], "")
            self.assertEqual(item["last_dispatched_status"], "")
            self.assertEqual(item["last_dispatched_at"], "")
            self.assertEqual(item["last_dispatched_poll"], 0)
            self.assertEqual(item["last_reviewer_outcome"], "INCOMPLETE")
            self.assertEqual(item["last_reviewer_feedback_at"], "2026-02-27T01:00:00Z")
            self.assertGreaterEqual(item["review_cycle_count"], 2)

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(update_calls, [])
