from __future__ import annotations

import unittest
from unittest.mock import patch

from apps.runner.codex_worker import CodexWorkerError, WorkerResult
from apps.runner.supervisor import _intent_child_main


class _RedisStub:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _BackendStub:
    def __init__(self, bundle: dict[str, object]) -> None:
        self.bundle = bundle

    def get_agent_context(self, _role: str) -> dict[str, object]:
        return self.bundle


class _QueueStub:
    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    def put(self, payload: dict[str, object]) -> None:
        self.payloads.append(payload)


class _SharedValueStub:
    def __init__(self, value: float) -> None:
        self.value = value


class SupervisorWorktreeTests(unittest.TestCase):
    def test_intent_child_main_uses_worktree_cwd_and_tears_down(self) -> None:
        redis_client = _RedisStub()
        backend = _BackendStub({"role": "EXECUTOR", "files": []})
        result_queue = _QueueStub()

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=backend):
                with patch("apps.runner.supervisor.setup_worktree", return_value="/tmp/agent-worktrees/run-123") as setup_mock:
                    with patch("apps.runner.supervisor.teardown_worktree") as teardown_mock:
                        with patch(
                            "apps.runner.supervisor.run_intent_with_codex_mcp",
                            return_value=WorkerResult(
                                run_id="run-123",
                                role="EXECUTOR",
                                status="succeeded",
                                outcome=None,
                                summary="ok",
                                urls={},
                                errors=[],
                                marker_verified=None,
                            ),
                        ) as worker_mock:
                            _intent_child_main(
                                redis_url="redis://localhost:6379/0",
                                backend_base_url="http://localhost:4000",
                                backend_timeout_s=5.0,
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                codex_tools_call_timeout_s=120.0,
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                                last_activity_ts=_SharedValueStub(0.0),
                                result_queue=result_queue,
                            )

        setup_mock.assert_called_once()
        self.assertEqual(worker_mock.call_args.kwargs["cwd"], "/tmp/agent-worktrees/run-123")
        teardown_mock.assert_called_once()
        self.assertEqual(teardown_mock.call_args.kwargs["worktree_path"], "/tmp/agent-worktrees/run-123")
        self.assertEqual(result_queue.payloads[0]["status"], "succeeded")
        self.assertEqual(result_queue.payloads[0]["usage"], {})
        self.assertTrue(redis_client.closed)

    def test_intent_child_main_tears_down_after_worker_failure(self) -> None:
        redis_client = _RedisStub()
        backend = _BackendStub({"role": "EXECUTOR", "files": []})
        result_queue = _QueueStub()

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=backend):
                with patch("apps.runner.supervisor.setup_worktree", return_value="/tmp/agent-worktrees/run-123"):
                    with patch("apps.runner.supervisor.teardown_worktree") as teardown_mock:
                        with patch("apps.runner.supervisor.run_intent_with_codex_mcp", side_effect=RuntimeError("boom")):
                            _intent_child_main(
                                redis_url="redis://localhost:6379/0",
                                backend_base_url="http://localhost:4000",
                                backend_timeout_s=5.0,
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                codex_tools_call_timeout_s=120.0,
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                                last_activity_ts=_SharedValueStub(0.0),
                                result_queue=result_queue,
                            )

        teardown_mock.assert_called_once()
        self.assertEqual(teardown_mock.call_args.kwargs["worktree_path"], "/tmp/agent-worktrees/run-123")
        self.assertEqual(result_queue.payloads[0]["status"], "failed")
        self.assertEqual(result_queue.payloads[0]["summary"], "boom")
        self.assertEqual(result_queue.payloads[0]["usage"], {})
        self.assertTrue(redis_client.closed)

    def test_intent_child_main_skips_worker_when_worktree_setup_fails(self) -> None:
        redis_client = _RedisStub()
        backend = _BackendStub({"role": "EXECUTOR", "files": []})
        result_queue = _QueueStub()

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=backend):
                with patch(
                    "apps.runner.supervisor.setup_worktree",
                    side_effect=CodexWorkerError("setup failed", code="workspace_setup_failed"),
                ):
                    with patch("apps.runner.supervisor.teardown_worktree") as teardown_mock:
                        with patch("apps.runner.supervisor.run_intent_with_codex_mcp") as worker_mock:
                            _intent_child_main(
                                redis_url="redis://localhost:6379/0",
                                backend_base_url="http://localhost:4000",
                                backend_timeout_s=5.0,
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                codex_tools_call_timeout_s=120.0,
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                                last_activity_ts=_SharedValueStub(0.0),
                                result_queue=result_queue,
                            )

        worker_mock.assert_not_called()
        teardown_mock.assert_not_called()
        self.assertEqual(result_queue.payloads[0]["status"], "failed")
        self.assertEqual(result_queue.payloads[0]["summary"], "setup failed")
        self.assertEqual(result_queue.payloads[0]["usage"], {})
        self.assertTrue(redis_client.closed)

    def test_intent_child_main_updates_heartbeat_from_transcript_sink(self) -> None:
        redis_client = _RedisStub()
        backend = _BackendStub({"role": "EXECUTOR", "files": []})
        result_queue = _QueueStub()
        heartbeat = _SharedValueStub(0.0)

        with patch("apps.runner.supervisor.create_redis_client", return_value=redis_client):
            with patch("apps.runner.supervisor.BackendClient", return_value=backend):
                with patch("apps.runner.supervisor.setup_worktree", return_value="/tmp/agent-worktrees/run-123"):
                    with patch("apps.runner.supervisor.teardown_worktree"):
                        with patch("apps.runner.supervisor.time.time", return_value=1234.5):
                            with patch("apps.runner.supervisor.publish_transcript_event") as publish_mock:
                                def _worker(**kwargs):
                                    sink = kwargs["transcript_event_sink"]
                                    sink("assistant", "heartbeat")
                                    return WorkerResult(
                                        run_id="run-123",
                                        role="EXECUTOR",
                                        status="succeeded",
                                        outcome=None,
                                        summary="ok",
                                        urls={},
                                        errors=[],
                                        marker_verified=None,
                                    )

                                with patch("apps.runner.supervisor.run_intent_with_codex_mcp", side_effect=_worker):
                                    _intent_child_main(
                                        redis_url="redis://localhost:6379/0",
                                        backend_base_url="http://localhost:4000",
                                        backend_timeout_s=5.0,
                                        codex_bin="codex",
                                        codex_mcp_args="mcp-server",
                                        codex_tools_call_timeout_s=120.0,
                                        intent={
                                            "type": "RUN_INTENT",
                                            "role": "EXECUTOR",
                                            "run_id": "run-123",
                                            "endpoint": "/internal/executor/claim-ready-item",
                                            "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                        },
                                        last_activity_ts=heartbeat,
                                        result_queue=result_queue,
                                    )

        self.assertEqual(heartbeat.value, 1234.5)
        publish_mock.assert_called_once()
        self.assertEqual(result_queue.payloads[0]["status"], "succeeded")
        self.assertEqual(result_queue.payloads[0]["usage"], {})
