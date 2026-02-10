import tempfile
import threading
import time
import unittest

from apps.runner.runner import Runner


class _BackendStub:
    def __init__(self) -> None:
        self.base_url = "http://localhost:4000"

    def get_agent_context(self, role: str):
        return {"role": role, "files": []}

    def post_json(self, path: str, *, body):
        return {"ok": True}


def _build_runner(*, state_path: str) -> Runner:
    return Runner(
        backend=_BackendStub(),
        ledger=None,
        dry_run=False,
        codex_bin="codex",
        codex_mcp_args="mcp-server",
        codex_tools_call_timeout_s=1.0,
        orchestrator_state_path=state_path,
        review_stall_polls=50,
        blocked_retry_minutes=15,
        watchdog_timeout_s=900,
    )


class RunnerInFlightGateTests(unittest.TestCase):
    def test_reserve_blocks_until_release(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            runner = _build_runner(state_path=f"{tmp_dir}/orchestrator-state.json")

            runner._reserve_issue_slot(issue_number=42, run_id="run-1", role="EXECUTOR")

            acquired = threading.Event()

            def reserve_second() -> None:
                runner._reserve_issue_slot(issue_number=42, run_id="run-2", role="REVIEWER")
                acquired.set()

            thread = threading.Thread(target=reserve_second, daemon=True)
            thread.start()

            # The second reservation must not acquire until the first is released.
            time.sleep(0.2)
            self.assertFalse(acquired.is_set())

            runner._release_issue_slot(issue_number=42, run_id="run-1")

            thread.join(timeout=2.0)
            self.assertTrue(acquired.is_set())

            runner._release_issue_slot(issue_number=42, run_id="run-2")

