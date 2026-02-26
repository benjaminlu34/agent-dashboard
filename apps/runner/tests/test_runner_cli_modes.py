import contextlib
import io
import os
import tempfile
import unittest
from unittest.mock import patch

from apps.runner import runner


class _BackendStub:
    def __init__(self, base_url: str, timeout_s: float = 120.0) -> None:
        self.base_url = base_url
        self.timeout_s = timeout_s

    def preflight_orchestrator(self):
        return {"status": "PASS"}

    def get_agent_context(self, role: str):
        raise AssertionError(f"unexpected get_agent_context call for role={role}")


class _ProcStub:
    def __init__(self) -> None:
        r_out, w_out = os.pipe()
        r_err, w_err = os.pipe()
        # Close write ends immediately so reads return EOF.
        os.close(w_out)
        os.close(w_err)
        self.stdout = os.fdopen(r_out, "r", encoding="utf-8", closefd=True)
        self.stderr = os.fdopen(r_err, "r", encoding="utf-8", closefd=True)

    def poll(self):
        return 0

    def terminate(self) -> None:
        return None

    def wait(self, timeout: int = 5) -> int:
        return 0


class RunnerCliModeTests(unittest.TestCase):
    def test_loop_without_kickoff_with_sprint_spawns_orchestrator(self) -> None:
        captured = {"env": None, "cmd": None}

        def _spawn(cmd: str, *, env):
            captured["cmd"] = cmd
            captured["env"] = dict(env)
            return _ProcStub()

        with patch.dict(os.environ, {"BACKEND_BASE_URL": "http://localhost:4000"}, clear=True):
            with patch("apps.runner.runner.BackendClient", _BackendStub):
                with patch("apps.runner.runner._spawn_orchestrator", _spawn):
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        exit_code = runner.main(["--loop", "--dry-run", "--sprint", "M1"])

        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(captured["env"])
        assert captured["env"] is not None
        self.assertEqual(captured["env"].get("ORCHESTRATOR_SPRINT"), "M1")
        self.assertEqual(captured["env"].get("ORCHESTRATOR_MAX_EXECUTORS"), "3")
        self.assertEqual(captured["env"].get("ORCHESTRATOR_MAX_REVIEWERS"), "2")
        self.assertIn("--loop", str(captured["cmd"]))

    def test_loop_without_kickoff_without_sprint_is_config_error(self) -> None:
        with patch.dict(os.environ, {"BACKEND_BASE_URL": "http://localhost:4000"}, clear=True):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                exit_code = runner.main(["--loop", "--dry-run"])

        self.assertEqual(exit_code, 2)
        self.assertIn("CONFIG_ERROR", stderr.getvalue())
        self.assertIn("sprint is required", stderr.getvalue())

    def test_goal_file_without_kickoff_is_config_error(self) -> None:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as handle:
            handle.write("goal")
            path = handle.name

        try:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                exit_code = runner.main(["--goal-file", path, "--dry-run", "--once"])
            self.assertEqual(exit_code, 2)
            self.assertIn("requires --kickoff", stderr.getvalue())
        finally:
            os.unlink(path)

    def test_kickoff_without_goal_is_config_error(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            exit_code = runner.main(["--kickoff", "--dry-run", "--once", "--sprint", "M1"])

        self.assertEqual(exit_code, 2)
        self.assertIn("requires --goal or --goal-file", stderr.getvalue())
