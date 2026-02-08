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

    def test_accepts_ready_buffer_override(self) -> None:
        config = load_config(
            env={
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_SPRINT": "M1",
                "RUNNER_READY_BUFFER": "3",
            }
        )
        self.assertEqual(config.runner_ready_buffer, 3)
