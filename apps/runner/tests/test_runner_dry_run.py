import unittest
import io
import contextlib

from apps.runner.config import RunnerConfig
from apps.runner.daemon import OrchestratorDaemon
from apps.runner.redis_keys import orchestrator_intents_queue_key, orchestrator_ledger_key, orchestrator_root_key

from .fake_redis import FakeRedis


class _BackendStub:
    def __init__(self) -> None:
        self.calls = []

    def get_project_items_metadata(self, *, role: str, sprint: str):
        self.calls.append((role, sprint))
        return {
            "role": role,
            "sprint": sprint,
            "as_of": "2026-02-28T00:00:00Z",
            "items": [
                {
                    "project_item_id": "PVTI_1",
                    "issue_number": 1,
                    "issue_title": "Test task",
                    "issue_url": "https://github.com/example/repo/issues/1",
                    "status": "Ready",
                    "sprint": sprint,
                }
            ],
        }


class RunnerDryRunTests(unittest.TestCase):
    def test_dry_run_never_enqueues_intents_or_writes_ledger(self) -> None:
        backend = _BackendStub()
        redis = FakeRedis()
        repo_key = "example.repo"
        config = RunnerConfig(
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
            dry_run=True,
            once=True,
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
        daemon = OrchestratorDaemon(config=config, backend=backend, redis_client=redis)

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            daemon.run_once(sprint="M1")

        queue_key = orchestrator_intents_queue_key(role="EXECUTOR", repo_key=repo_key)
        self.assertEqual(redis._snapshot_list(queue_key), [])
        self.assertEqual(redis.hgetall(orchestrator_ledger_key(repo_key)), {})
        root = redis.hgetall(orchestrator_root_key(repo_key))
        self.assertEqual(root.get("poll_count"), "1")
        self.assertIn('"type":"DRY_RUN_WOULD_DISPATCH"', stderr.getvalue())
