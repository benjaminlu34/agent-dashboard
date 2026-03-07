from __future__ import annotations

import contextlib
import io
import unittest
from unittest.mock import patch

from apps.runner.config import RunnerConfig
from apps.runner.daemon import OrchestratorDaemon
from apps.runner.ledger import LedgerEntry
from apps.runner.state_store import RedisStateStore

from .fake_redis import FakeRedis


class _BackendStub:
    def __init__(self) -> None:
        self.base_url = "http://localhost:4000"
        self.calls: list[tuple[str, dict]] = []

    def post_json(self, path: str, *, body: dict):
        self.calls.append((path, body))
        if path == "/internal/reviewer/resolve-linked-pr":
            return {
                "issue_number": body.get("issue_number"),
                "project_item_id": "PVTI_2",
                "pr_url": "https://github.com/example/repo/pull/2",
            }
        if path == "/internal/project-item/update-field":
            return {"updated": {"Status": body.get("value")}}
        return {"ok": True}


def _base_config(*, repo_key: str) -> RunnerConfig:
    return RunnerConfig(
        backend_base_url="http://localhost:4000",
        backend_timeout_s=5.0,
        redis_url="redis://localhost:6379/0",
        repo_key=repo_key,
        orchestrator_sprint="M1",
        runner_max_executors=1,
        runner_max_reviewers=1,
        runner_ready_buffer=2,
        review_stall_polls=50,
        blocked_retry_minutes=15,
        error_retry_base_s=60.0,
        error_retry_max_s=3600.0,
        error_retry_multiplier=2.0,
        watchdog_timeout_s=60,
        runner_stall_timeout_s=300,
        dry_run=False,
        once=False,
        ledger_path="./.runner-ledger.json",
        sprint_plan_path="./.runner-sprint-plan.json",
        autopromote=False,
        orchestrator_state_path="./.orchestrator-state.json",
        orchestrator_cmd="",
        codex_bin="codex",
        codex_mcp_args="mcp-server",
        codex_tools_call_timeout_s=600.0,
        orchestrator_sanitization_regen_attempts=2,
    )


class RunnerReviewAndStallTests(unittest.TestCase):
    def test_dispatch_summary_handler_errors_are_isolated(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        daemon = OrchestratorDaemon(config=_base_config(repo_key="example.repo"), backend=backend, redis_client=redis)
        summary = {"processed_items": [], "needs_attention": {"stalled_in_progress": [], "in_review_churn": []}}

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with patch.object(daemon, "_recover_passed_in_review_items", return_value=None) as pass_recovery_mock:
                with patch.object(
                    daemon,
                    "_recover_lost_in_review_reviewer_dispatches",
                    side_effect=RuntimeError("boom"),
                ):
                    with patch.object(daemon, "_handle_review_stall", return_value=None) as review_stall_mock:
                        with patch.object(daemon, "_handle_stalled_in_progress", return_value=None) as stalled_in_progress_mock:
                            with patch.object(daemon, "_handle_blocked_retries", return_value=None) as blocked_retry_mock:
                                with patch.object(daemon, "_handle_in_review_cycle_caps", return_value=None) as cycle_caps_mock:
                                    with patch.object(daemon, "_handle_running_watchdog", return_value=None) as watchdog_mock:
                                        daemon._handle_dispatch_summary(summary=summary)  # pylint: disable=protected-access

        self.assertEqual(pass_recovery_mock.call_count, 1)
        self.assertEqual(review_stall_mock.call_count, 1)
        self.assertEqual(stalled_in_progress_mock.call_count, 1)
        self.assertEqual(blocked_retry_mock.call_count, 1)
        self.assertEqual(cycle_caps_mock.call_count, 1)
        self.assertEqual(watchdog_mock.call_count, 1)
        self.assertIn('"type":"DISPATCH_SUMMARY_HANDLER_FAILED"', stderr.getvalue())
        self.assertIn('"handler":"recover_lost_in_review_reviewer_dispatches"', stderr.getvalue())

    def test_stale_in_review_pass_is_recovered_to_needs_human_approval(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        daemon = OrchestratorDaemon(config=_base_config(repo_key=repo_key), backend=backend, redis_client=redis)
        state_store = RedisStateStore(redis)
        state_store.set_item(
            repo_key,
            "PVTI_2",
            {
                "last_seen_issue_number": 2,
                "last_seen_status": "In Review",
                "last_reviewer_outcome": "PASS",
                "last_reviewer_feedback_at": "2026-02-27T02:00:00.000Z",
                "last_run_id": "review-pass-run",
            },
        )

        summary = {
            "processed_items": [{"issue_number": 2, "project_item_id": "PVTI_2", "status": "In Review"}],
            "needs_attention": {"stalled_in_progress": [], "in_review_churn": []},
        }

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            daemon._handle_dispatch_summary(summary=summary)  # pylint: disable=protected-access

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Needs Human Approval")
        self.assertIn('"type":"REVIEW_PASS_RECOVERED"', stderr.getvalue())

    def test_retryable_blocked_item_is_deferred_inside_backoff_window(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        daemon = OrchestratorDaemon(config=_base_config(repo_key=repo_key), backend=backend, redis_client=redis)
        state_store = RedisStateStore(redis)
        state_store.set_item(
            repo_key,
            "PVTI_3",
            {
                "last_seen_issue_number": 3,
                "last_seen_status": "Blocked",
                "status_since_at": "2026-03-07T00:09:00.000Z",
                "last_run_id": "blocked-run",
            },
        )
        daemon._ledger.upsert(  # pylint: disable=protected-access
            LedgerEntry(
                run_id="blocked-run",
                role="EXECUTOR",
                intent_hash="hash",
                received_at="2026-03-07T00:09:00.000Z",
                status="failed",
                result={
                    "status": "failed",
                    "failure_classification": "TRANSIENT",
                    "error_code": "backend_unreachable",
                },
            )
        )
        daemon._ledger.record_task_failure("PVTI_3", run_id="blocked-run", at_iso="2026-03-07T00:09:00.000Z")  # pylint: disable=protected-access

        summary = {"processed_items": [{"issue_number": 3, "project_item_id": "PVTI_3", "status": "Blocked"}]}

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with patch("apps.runner.daemon._utc_now_iso_ms", return_value="2026-03-07T00:10:00.000Z"):
                with patch("apps.runner.daemon.calculate_backoff_delay", return_value=120.0):
                    daemon._handle_blocked_retries(summary=summary)  # pylint: disable=protected-access

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(update_calls, [])
        self.assertIn('"type":"BLOCKED_RETRY_DEFERRED"', stderr.getvalue())

    def test_retryable_blocked_item_retries_after_backoff_window(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        daemon = OrchestratorDaemon(config=_base_config(repo_key=repo_key), backend=backend, redis_client=redis)
        state_store = RedisStateStore(redis)
        state_store.set_item(
            repo_key,
            "PVTI_4",
            {
                "last_seen_issue_number": 4,
                "last_seen_status": "Blocked",
                "status_since_at": "2026-03-07T00:05:00.000Z",
                "last_run_id": "blocked-run-ok",
            },
        )
        daemon._ledger.upsert(  # pylint: disable=protected-access
            LedgerEntry(
                run_id="blocked-run-ok",
                role="EXECUTOR",
                intent_hash="hash",
                received_at="2026-03-07T00:05:00.000Z",
                status="failed",
                result={
                    "status": "failed",
                    "failure_classification": "TRANSIENT",
                    "error_code": "backend_unreachable",
                },
            )
        )
        daemon._ledger.record_task_failure("PVTI_4", run_id="blocked-run-ok", at_iso="2026-03-07T00:05:00.000Z")  # pylint: disable=protected-access

        summary = {"processed_items": [{"issue_number": 4, "project_item_id": "PVTI_4", "status": "Blocked"}]}

        with patch("apps.runner.daemon._utc_now_iso_ms", return_value="2026-03-07T00:10:00.000Z"):
            with patch("apps.runner.daemon.calculate_backoff_delay", return_value=120.0):
                daemon._handle_blocked_retries(summary=summary)  # pylint: disable=protected-access

        update_calls = [call for call in backend.calls if call[0] == "/internal/project-item/update-field"]
        self.assertEqual(len(update_calls), 1)
        self.assertEqual(update_calls[0][1]["value"], "Ready")

    def test_reviewer_dispatch_recovery_is_deferred_inside_backoff_window(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        daemon = OrchestratorDaemon(config=_base_config(repo_key=repo_key), backend=backend, redis_client=redis)
        state_store = RedisStateStore(redis)
        state_store.set_item(
            repo_key,
            "PVTI_5",
            {
                "last_seen_issue_number": 5,
                "last_seen_status": "In Review",
                "last_reviewer_outcome": "",
                "review_cycle_count": 0,
                "last_dispatched_role": "REVIEWER",
                "last_dispatched_status": "In Review",
                "last_dispatched_at": "2026-03-07T00:09:00.000Z",
                "last_dispatched_poll": 1,
                "last_run_id": "review-run",
            },
        )
        daemon._ledger.upsert(  # pylint: disable=protected-access
            LedgerEntry(
                run_id="review-run",
                role="REVIEWER",
                intent_hash="hash",
                received_at="2026-03-07T00:09:00.000Z",
                status="failed",
                result={
                    "status": "failed",
                    "failure_classification": "TRANSIENT",
                    "error_code": "backend_unreachable",
                    "reviewer_outcome": "",
                },
            )
        )

        summary = {
            "poll_count": 2,
            "processed_items": [{"issue_number": 5, "project_item_id": "PVTI_5", "status": "In Review"}],
        }

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with patch("apps.runner.daemon._utc_now_iso_ms", return_value="2026-03-07T00:10:00.000Z"):
                with patch("apps.runner.daemon.calculate_backoff_delay", return_value=120.0):
                    daemon._recover_lost_in_review_reviewer_dispatches(summary=summary)  # pylint: disable=protected-access

        reloaded = state_store.get_item(repo_key, "PVTI_5")
        assert reloaded is not None
        self.assertEqual(reloaded["last_dispatched_role"], "REVIEWER")
        self.assertEqual(reloaded["last_reviewer_outcome"], "")
        self.assertIn('"type":"REVIEW_DISPATCH_RECOVERY_DEFERRED"', stderr.getvalue())

    def test_reviewer_dispatch_recovery_applies_after_backoff_window(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        daemon = OrchestratorDaemon(config=_base_config(repo_key=repo_key), backend=backend, redis_client=redis)
        state_store = RedisStateStore(redis)
        state_store.set_item(
            repo_key,
            "PVTI_6",
            {
                "last_seen_issue_number": 6,
                "last_seen_status": "In Review",
                "last_reviewer_outcome": "",
                "review_cycle_count": 0,
                "last_dispatched_role": "REVIEWER",
                "last_dispatched_status": "In Review",
                "last_dispatched_at": "2026-03-07T00:05:00.000Z",
                "last_dispatched_poll": 1,
                "last_run_id": "review-run-ok",
            },
        )
        daemon._ledger.upsert(  # pylint: disable=protected-access
            LedgerEntry(
                run_id="review-run-ok",
                role="REVIEWER",
                intent_hash="hash",
                received_at="2026-03-07T00:05:00.000Z",
                status="failed",
                result={
                    "status": "failed",
                    "failure_classification": "TRANSIENT",
                    "error_code": "backend_unreachable",
                    "reviewer_outcome": "",
                },
            )
        )

        summary = {
            "poll_count": 2,
            "processed_items": [{"issue_number": 6, "project_item_id": "PVTI_6", "status": "In Review"}],
        }

        with patch("apps.runner.daemon._utc_now_iso_ms", return_value="2026-03-07T00:10:00.000Z"):
            with patch("apps.runner.daemon.calculate_backoff_delay", return_value=120.0):
                daemon._recover_lost_in_review_reviewer_dispatches(summary=summary)  # pylint: disable=protected-access

        reloaded = state_store.get_item(repo_key, "PVTI_6")
        assert reloaded is not None
        self.assertEqual(reloaded["last_dispatched_role"], "")
        self.assertEqual(reloaded["last_reviewer_outcome"], "INCOMPLETE")
        self.assertEqual(reloaded["review_cycle_count"], 1)
