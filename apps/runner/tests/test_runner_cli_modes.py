from __future__ import annotations

import contextlib
import io
import unittest
from unittest.mock import patch

from apps.runner import cli
from apps.runner.config import RunnerConfig


def _base_config(*, dry_run: bool) -> RunnerConfig:
    return RunnerConfig(
        backend_base_url="http://localhost:4000",
        backend_timeout_s=5.0,
        redis_url="redis://localhost:6379/0",
        repo_key="example.repo",
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
        dry_run=dry_run,
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


class _DaemonStub:
    def __init__(self, *, config: RunnerConfig, backend, redis_client) -> None:  # noqa: ANN001
        self.config = config
        self.backend = backend
        self.redis_client = redis_client
        self.run_called = False
        self.run_once_calls: list[str] = []

    def run_once(self, *, sprint: str) -> None:
        self.run_once_calls.append(sprint)

    def run(self) -> None:
        self.run_called = True


class RunnerCliModeTests(unittest.TestCase):
    def test_once_calls_run_once_and_skips_supervisors(self) -> None:
        config = _base_config(dry_run=True)
        start_supervisors_calls = []

        with patch("apps.runner.cli.load_config", return_value=config):
            with patch("apps.runner.cli.create_redis_client", return_value=object()):
                with patch("apps.runner.cli.OrchestratorDaemon", _DaemonStub):
                    with patch(
                        "apps.runner.cli.start_supervisors",
                        side_effect=lambda **_kwargs: start_supervisors_calls.append(True),
                    ):
                        exit_code = cli.main(["--once", "--dry-run", "--sprint", "M1"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(start_supervisors_calls, [])

    def test_daemon_starts_supervisors_when_not_dry_run(self) -> None:
        config = _base_config(dry_run=False)
        start_supervisors_calls = []
        daemon = _DaemonStub(config=config, backend=object(), redis_client=object())

        with patch("apps.runner.cli.load_config", return_value=config):
            with patch("apps.runner.cli.create_redis_client", return_value=object()):
                with patch("apps.runner.cli.OrchestratorDaemon", return_value=daemon):
                    with patch(
                        "apps.runner.cli.start_supervisors",
                        side_effect=lambda **_kwargs: start_supervisors_calls.append(True),
                    ):
                        exit_code = cli.main(["--daemon"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(start_supervisors_calls, [True])
        self.assertTrue(daemon.run_called)

    def test_daemon_skips_supervisors_in_dry_run(self) -> None:
        config = _base_config(dry_run=True)
        start_supervisors_calls = []
        daemon = _DaemonStub(config=config, backend=object(), redis_client=object())

        with patch("apps.runner.cli.load_config", return_value=config):
            with patch("apps.runner.cli.create_redis_client", return_value=object()):
                with patch("apps.runner.cli.OrchestratorDaemon", return_value=daemon):
                    with patch(
                        "apps.runner.cli.start_supervisors",
                        side_effect=lambda **_kwargs: start_supervisors_calls.append(True),
                    ):
                        exit_code = cli.main(["--daemon", "--dry-run"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(start_supervisors_calls, [])
        self.assertTrue(daemon.run_called)

    def test_config_error_returns_exit_2(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with patch("apps.runner.cli.load_config", side_effect=ValueError("boom")):
                exit_code = cli.main(["--once", "--sprint", "M1"])
        self.assertEqual(exit_code, 2)
        self.assertIn('"type":"CONFIG_ERROR"', stderr.getvalue())
