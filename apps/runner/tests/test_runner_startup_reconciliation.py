from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from apps.runner.config import RunnerConfig
from apps.runner.daemon import OrchestratorDaemon
from apps.runner.redis_keys import orchestrator_root_key

from .fake_redis import FakeRedis


class _BackendStub:  # noqa: D101 - test stub
    def preflight_orchestrator(self):
        return {"status": "PASS"}


def _base_config(*, repo_key: str, sprint_plan_path: str) -> RunnerConfig:
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
        dry_run=False,
        once=False,
        ledger_path="./.runner-ledger.json",
        sprint_plan_path=sprint_plan_path,
        autopromote=False,
        orchestrator_state_path="./.orchestrator-state.json",
        orchestrator_cmd="",
        codex_bin="codex",
        codex_mcp_args="mcp-server",
        codex_tools_call_timeout_s=600.0,
        orchestrator_sanitization_regen_attempts=2,
    )


class RunnerStartupReconciliationTests(unittest.TestCase):
    def test_phase_guard_fails_closed_when_pending_verification_and_poll_zero(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"
        config = _base_config(repo_key=repo_key, sprint_plan_path="./.runner-sprint-plan.json")
        daemon = OrchestratorDaemon(config=config, backend=_BackendStub(), redis_client=redis)
        redis.hset(orchestrator_root_key(repo_key), mapping={"sprint_phase": "PENDING_VERIFICATION"})

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with mock.patch.dict(os.environ, {"RUNNER_VERIFY_POLL_SECONDS": "0"}, clear=False):
                ok = daemon._phase_guard_or_stop()  # pylint: disable=protected-access

        self.assertFalse(ok)
        self.assertIn('"reason":"sprint_pending_verification"', stderr.getvalue())

    def test_drift_defense_fails_closed_on_plan_version_mismatch(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"

        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=True) as handle:
            plan_path = handle.name
            json.dump({"plan_version": "2026-02-28T00:00:00.000Z"}, handle)
            handle.flush()

            config = _base_config(repo_key=repo_key, sprint_plan_path=plan_path)
            daemon = OrchestratorDaemon(config=config, backend=_BackendStub(), redis_client=redis)
            daemon._ledger.set_plan_version("2026-02-28T00:00:01.000Z")  # pylint: disable=protected-access

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                ok = daemon._drift_defense_or_stop()  # pylint: disable=protected-access

        self.assertFalse(ok)
        self.assertIn('"reason":"plan_version_mismatch"', stderr.getvalue())
