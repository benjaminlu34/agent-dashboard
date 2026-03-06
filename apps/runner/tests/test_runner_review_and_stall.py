from __future__ import annotations

import contextlib
import io
import unittest
from unittest.mock import patch

from apps.runner.config import RunnerConfig
from apps.runner.daemon import OrchestratorDaemon
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
