import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.runner.runner import Runner, _drift_defense_or_exit, _phase_guard_or_exit


class _BackendStub:
    def __init__(self, payload, *, error: Exception | None = None) -> None:
        self.base_url = "http://localhost:4000"
        self._payload = payload
        self._error = error
        self.calls = []

    def get_project_items_metadata(self, *, role: str, sprint: str):
        self.calls.append({"role": role, "sprint": sprint})
        if self._error is not None:
            raise self._error
        return self._payload


def _build_runner(*, backend, state_path: str, dry_run: bool = False) -> Runner:
    return Runner(
        backend=backend,
        ledger=None,
        dry_run=dry_run,
        codex_bin="codex",
        codex_mcp_args="mcp-server",
        codex_tools_call_timeout_s=600.0,
        orchestrator_state_path=state_path,
        review_stall_polls=50,
        blocked_retry_minutes=15,
        watchdog_timeout_s=900,
    )


class RunnerStartupReconciliationTests(unittest.TestCase):
    def test_phase_guard_exits_when_pending_verification_and_poll_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps({"sprint_phase": "PENDING_VERIFICATION"}),
                encoding="utf-8",
            )

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                with patch.dict(os.environ, {"RUNNER_VERIFY_POLL_SECONDS": "0"}, clear=False):
                    with patch("apps.runner.runner.sys.exit") as exit_mock:
                        _phase_guard_or_exit(orchestrator_state_path=state_path)

            exit_mock.assert_called_once_with(2)
            self.assertIn("Sprint pending verification. Awaiting seal.", stderr.getvalue())

    def test_drift_defense_exits_on_plan_version_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            plan_path = f"{tmp_dir}/runner-sprint-plan.json"
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            Path(plan_path).write_text(
                json.dumps({"plan_version": "2026-02-28T00:00:00.000Z"}),
                encoding="utf-8",
            )
            Path(ledger_path).write_text(
                json.dumps({"plan_version": "2026-02-28T00:00:01.000Z"}),
                encoding="utf-8",
            )

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                with patch("apps.runner.runner.sys.exit") as exit_mock:
                    _drift_defense_or_exit(sprint_plan_path=plan_path, ledger_path=ledger_path)

            exit_mock.assert_called_once_with(2)
            self.assertIn(
                "Ledger/Plan version mismatch. Sprint was re-sealed or state is corrupted.",
                stderr.getvalue(),
            )

    def test_reconcile_startup_state_rehydrates_items_and_clears_dispatch_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 136,
                        "items": {
                            "PVTI_live": {
                                "last_seen_status": "In Review",
                                "last_seen_sprint": "M1",
                                "last_seen_issue_number": 4,
                                "last_seen_issue_title": "Old title",
                                "last_seen_at": "2026-02-26T23:33:03.253Z",
                                "status_since_at": "2026-02-26T23:25:14.735Z",
                                "status_since_poll": 105,
                                "last_activity_at": "2026-02-26T23:25:14.735Z",
                                "last_activity_indicator": "status_changed",
                                "last_dispatched_role": "REVIEWER",
                                "last_dispatched_status": "In Review",
                                "last_dispatched_at": "2026-02-26T23:25:14.735Z",
                                "last_dispatched_poll": 105,
                                "last_run_id": "run-reviewer-1",
                                "reviewer_dispatches_for_current_status": 1,
                                "review_cycle_count": 1,
                                "last_reviewer_outcome": "INCOMPLETE",
                                "last_reviewer_feedback_at": "2026-02-26T23:55:15.621670Z",
                                "last_executor_response_at": "",
                                "in_review_origin": "",
                            },
                            "PVTI_stale": {
                                "last_seen_status": "Backlog",
                                "last_seen_sprint": "M1",
                                "last_seen_issue_number": 99,
                            },
                        },
                        "sprint_plan": {"4": {"depends_on": []}},
                        "ownership_index": {"src/components": [4]},
                    }
                ),
                encoding="utf-8",
            )

            backend = _BackendStub(
                {
                    "role": "ORCHESTRATOR",
                    "sprint": "M1",
                    "as_of": "2026-02-27T00:30:00Z",
                    "items": [
                        {
                            "project_item_id": "PVTI_live",
                            "issue_number": 4,
                            "issue_title": "Render subscription dashboard list and spending totals",
                            "issue_url": "https://github.com/example/repo/issues/4",
                            "status": "In Review",
                            "sprint": "M1",
                        }
                    ],
                }
            )
            runner = _build_runner(backend=backend, state_path=state_path, dry_run=False)
            result = runner.reconcile_startup_state(sprint="M1")

            self.assertEqual(result["status"], "APPLIED")
            self.assertEqual(result["remote_items"], 1)
            self.assertEqual(result["pruned_local_items"], 1)
            self.assertTrue(result["state_changed"])

            state_after = json.loads(Path(state_path).read_text(encoding="utf-8"))
            self.assertEqual(state_after["poll_count"], 136)
            self.assertIn("PVTI_live", state_after["items"])
            self.assertNotIn("PVTI_stale", state_after["items"])
            self.assertEqual(state_after["sprint_plan"], {"4": {"depends_on": []}})
            self.assertEqual(state_after["ownership_index"], {"src/components": [4]})

            item = state_after["items"]["PVTI_live"]
            self.assertEqual(item["last_seen_status"], "In Review")
            self.assertEqual(item["last_seen_sprint"], "M1")
            self.assertEqual(item["last_seen_issue_number"], 4)
            self.assertEqual(item["last_seen_issue_title"], "Render subscription dashboard list and spending totals")
            self.assertEqual(item["last_seen_issue_url"], "https://github.com/example/repo/issues/4")
            self.assertEqual(item["status_since_poll"], 105)
            self.assertEqual(item["last_dispatched_role"], "")
            self.assertEqual(item["last_dispatched_status"], "")
            self.assertEqual(item["last_dispatched_at"], "")
            self.assertEqual(item["last_dispatched_poll"], 0)
            self.assertEqual(item["reviewer_dispatches_for_current_status"], 0)
            self.assertEqual(item["last_run_id"], "run-reviewer-1")
            self.assertEqual(item["review_cycle_count"], 1)
            self.assertEqual(item["last_reviewer_outcome"], "INCOMPLETE")

    def test_reconcile_startup_state_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 10,
                        "items": {},
                        "sprint_plan": {"1": {"depends_on": []}},
                        "ownership_index": {"src": [1]},
                    }
                ),
                encoding="utf-8",
            )
            payload = {
                "role": "ORCHESTRATOR",
                "sprint": "M1",
                "as_of": "2026-02-27T01:00:00Z",
                "items": [
                    {
                        "project_item_id": "PVTI_1",
                        "issue_number": 1,
                        "issue_title": "Goal",
                        "issue_url": "https://github.com/example/repo/issues/1",
                        "status": "Backlog",
                        "sprint": "M1",
                    }
                ],
            }
            backend = _BackendStub(payload)
            runner = _build_runner(backend=backend, state_path=state_path, dry_run=False)

            first = runner.reconcile_startup_state(sprint="M1")
            state_after_first = Path(state_path).read_text(encoding="utf-8")
            second = runner.reconcile_startup_state(sprint="M1")
            state_after_second = Path(state_path).read_text(encoding="utf-8")

            self.assertTrue(first["state_changed"])
            self.assertFalse(second["state_changed"])
            self.assertEqual(state_after_first, state_after_second)

    def test_reconcile_startup_state_skips_when_remote_fetch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(json.dumps({"poll_count": 1, "items": {}}), encoding="utf-8")

            backend = _BackendStub(payload={}, error=RuntimeError("fetch failed"))
            runner = _build_runner(backend=backend, state_path=state_path, dry_run=False)
            result = runner.reconcile_startup_state(sprint="M1")

            self.assertEqual(result["status"], "SKIPPED")
            self.assertEqual(result["reason"], "remote_fetch_failed")
            self.assertIn("fetch failed", result["error"])

    def test_reconcile_startup_state_drops_stale_pass_for_in_review_item(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            Path(state_path).write_text(
                json.dumps(
                    {
                        "poll_count": 25,
                        "items": {
                            "PVTI_2": {
                                "last_seen_status": "In Review",
                                "last_seen_sprint": "M1",
                                "last_seen_issue_number": 2,
                                "last_seen_issue_title": "Old title",
                                "last_seen_issue_url": "https://github.com/example/repo/issues/2",
                                "last_seen_at": "2026-02-27T01:00:00Z",
                                "status_since_at": "2026-02-27T00:50:00Z",
                                "status_since_poll": 20,
                                "last_activity_at": "2026-02-27T01:00:00Z",
                                "last_activity_indicator": "status_unchanged",
                                "last_dispatched_role": "REVIEWER",
                                "last_dispatched_status": "In Review",
                                "last_dispatched_at": "2026-02-27T01:00:00Z",
                                "last_dispatched_poll": 21,
                                "last_run_id": "review-pass-run",
                                "reviewer_dispatches_for_current_status": 1,
                                "review_cycle_count": 0,
                                "last_reviewer_outcome": "PASS",
                                "last_reviewer_feedback_at": "2026-02-27T01:00:30Z",
                                "last_executor_response_at": "",
                                "in_review_origin": "",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            backend = _BackendStub(
                {
                    "role": "ORCHESTRATOR",
                    "sprint": "M1",
                    "as_of": "2026-02-27T01:05:00Z",
                    "items": [
                        {
                            "project_item_id": "PVTI_2",
                            "issue_number": 2,
                            "issue_title": "Fresh title",
                            "issue_url": "https://github.com/example/repo/issues/2",
                            "status": "In Review",
                            "sprint": "M1",
                        }
                    ],
                }
            )
            runner = _build_runner(backend=backend, state_path=state_path, dry_run=False)
            result = runner.reconcile_startup_state(sprint="M1")

            self.assertEqual(result["status"], "APPLIED")
            state_after = json.loads(Path(state_path).read_text(encoding="utf-8"))
            item = state_after["items"]["PVTI_2"]
            self.assertEqual(item["last_seen_status"], "In Review")
            self.assertEqual(item["last_reviewer_outcome"], "")
