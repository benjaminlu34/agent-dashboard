import unittest

from apps.runner.config import load_config


class RunnerConfigTests(unittest.TestCase):
    def test_accepts_backend_timeout_s(self) -> None:
        config = load_config(
            env={
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_SPRINT": "M1",
                "BACKEND_TIMEOUT_S": "120",
            }
        )
        self.assertEqual(config.backend_timeout_s, 120.0)

    def test_accepts_codex_tools_call_timeout_s(self) -> None:
        config = load_config(
            env={
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_SPRINT": "M1",
                "CODEX_TOOLS_CALL_TIMEOUT_S": "600",
            }
        )
        self.assertEqual(config.codex_tools_call_timeout_s, 600.0)

    def test_defaults_autopromote_enabled_and_ready_buffer(self) -> None:
        config = load_config(
            env={
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_SPRINT": "M1",
            }
        )
        self.assertTrue(config.autopromote)
        self.assertEqual(config.runner_ready_buffer, 2)
        self.assertEqual(config.review_stall_polls, 50)
        self.assertEqual(config.blocked_retry_minutes, 15)
        self.assertEqual(config.watchdog_timeout_s, 900)

    def test_accepts_ready_buffer_override(self) -> None:
        config = load_config(
            env={
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_SPRINT": "M1",
                "RUNNER_READY_BUFFER": "3",
                "REVIEW_STALL_POLLS": "60",
                "BLOCKED_RETRY_MINUTES": "20",
                "RUNNER_WATCHDOG_TIMEOUT_S": "1200",
            }
        )
        self.assertEqual(config.runner_ready_buffer, 3)
        self.assertEqual(config.review_stall_polls, 60)
        self.assertEqual(config.blocked_retry_minutes, 20)
        self.assertEqual(config.watchdog_timeout_s, 1200)
