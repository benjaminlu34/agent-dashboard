import asyncio
import json
import unittest
from unittest.mock import patch

from apps.runner.codex_worker import (
    CodexWorkerError,
    _MCP_PROTOCOL_VERSION,
    _build_worker_prompt,
    _build_worker_result_replay_prompt,
    _extract_worker_result,
    _sandbox_for_role,
    _strip_markdown_json_fences,
    generate_json_with_codex_mcp_async,
    run_intent_with_codex_mcp_async,
)


class _FakeProcStdin:
    def close(self) -> None:
        return None

    async def wait_closed(self) -> None:
        return None


class _FakeStream:
    async def readline(self) -> bytes:
        return b""


class _FakeProc:
    def __init__(self) -> None:
        self.stdin = _FakeProcStdin()
        self.stdout = None
        self.stderr = _FakeStream()
        self.returncode = 0

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        return int(self.returncode or 0)


class _FakeTask:
    def cancel(self) -> None:
        return None

    def __await__(self):
        async def _done() -> None:
            return None

        return _done().__await__()


def _fake_create_task(coro, *args, **kwargs):  # noqa: ANN001, ARG001
    coro.close()
    return _FakeTask()


class _FakeClient:
    instances: list["_FakeClient"] = []

    def __init__(self, _proc) -> None:  # noqa: ANN001
        self.calls: list[tuple[str, dict | None]] = []
        _FakeClient.instances.append(self)

    async def call(self, method: str, params: dict | None = None, *, timeout_s: float = 120.0) -> dict:
        _ = timeout_s
        self.calls.append((method, params))
        if method == "initialize":
            return {"protocolVersion": _MCP_PROTOCOL_VERSION}
        if method == "tools/list":
            return {"tools": [{"name": "codex"}]}
        if method == "tools/call":
            name = str((params or {}).get("name") or "")
            if name == "codex":
                prompt = (params or {}).get("arguments", {}).get("prompt")
                if prompt == "json-prompt":
                    return {
                        "structuredContent": {"threadId": "thread-1", "content": json.dumps({"ok": True})},
                        "usage": {"input_tokens": 3, "output_tokens": 2},
                    }
                return {
                    "structuredContent": {
                        "threadId": "thread-1",
                        "content": json.dumps(
                            {
                                "run_id": "run-123",
                                "role": "EXECUTOR",
                                "status": "succeeded",
                                "summary": "ok",
                                "urls": {},
                                "errors": [],
                                "marker_verified": None,
                            }
                        ),
                    },
                    "usage": {"input_tokens": 11, "output_tokens": "7"},
                }
            if name == "codex-reply":
                return {
                    "structuredContent": {"threadId": "thread-1", "content": json.dumps({"ok": True})},
                    "usage": {"input_tokens": 1, "output_tokens": 1},
                }
        return {}

    async def notify(self, method: str, params: dict | None = None) -> None:
        self.calls.append((method, params))

    async def close(self) -> None:
        return None


class CodexWorkerPromptTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeClient.instances.clear()

    def test_executor_prompt_mentions_fixup_branch_constraints(self) -> None:
        prompt = _build_worker_prompt(
            role_bundle={"role": "EXECUTOR", "files": []},
            intent={
                "type": "RUN_INTENT",
                "role": "EXECUTOR",
                "run_id": "11111111-1111-4111-8111-111111111111",
                "endpoint": "/internal/executor/claim-ready-item",
                "body": {
                    "role": "EXECUTOR",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "sprint": "M1",
                },
            },
            backend_base_url="http://localhost:4000",
        )
        self.assertIn("MUST set marker_verified=true", prompt)
        self.assertIn("In Review fixup run", prompt)
        self.assertIn("descend from head_sha", prompt)
        self.assertIn("Never use /tmp", prompt)
        self.assertIn('"marker_verified": true|false|null', prompt)

    def test_sandbox_for_role_allows_backend_access_for_worker_roles(self) -> None:
        self.assertEqual(_sandbox_for_role("EXECUTOR"), "danger-full-access")
        self.assertEqual(_sandbox_for_role("REVIEWER"), "danger-full-access")
        with self.assertRaises(CodexWorkerError):
            _sandbox_for_role("ORCHESTRATOR")

    def test_extract_worker_result_requires_reviewer_outcome(self) -> None:
        with self.assertRaises(CodexWorkerError):
            _extract_worker_result(
                content='{"run_id":"r1","role":"REVIEWER","status":"succeeded","summary":"ok","urls":{},"errors":[]}',
                expected_run_id="r1",
                expected_role="REVIEWER",
            )

    def test_extract_worker_result_accepts_reviewer_outcome(self) -> None:
        result = _extract_worker_result(
            content=(
                '{"run_id":"r2","role":"REVIEWER","status":"succeeded",'
                '"outcome":"PASS","summary":"ok","urls":{},"errors":[],"marker_verified":null}'
            ),
            expected_run_id="r2",
            expected_role="REVIEWER",
        )
        self.assertEqual(result.outcome, "PASS")
        self.assertEqual(result.usage, {})

    def test_extract_worker_result_accepts_executor_marker_verified(self) -> None:
        result = _extract_worker_result(
            content=(
                '{"run_id":"r3","role":"EXECUTOR","status":"succeeded",'
                '"summary":"ok","urls":{"pr_url":"https://example.com/pr/1"},'
                '"errors":[],"marker_verified":true}'
            ),
            expected_run_id="r3",
            expected_role="EXECUTOR",
        )
        self.assertEqual(result.marker_verified, True)
        self.assertEqual(result.usage, {})

    def test_extract_worker_result_strips_markdown_fences(self) -> None:
        result = _extract_worker_result(
            content=(
                "```json\n"
                '{"run_id":"r4","role":"REVIEWER","status":"succeeded",'
                '"outcome":"PASS","summary":"ok","urls":{},"errors":[]}\n'
                "```"
            ),
            expected_run_id="r4",
            expected_role="REVIEWER",
        )
        self.assertEqual(result.outcome, "PASS")

    def test_strip_markdown_json_fences_removes_wrappers(self) -> None:
        self.assertEqual(
            _strip_markdown_json_fences("```json\n{\"ok\":true}\n```"),
            "{\"ok\":true}",
        )

    def test_replay_prompt_keeps_required_worker_result_keys(self) -> None:
        prompt = _build_worker_result_replay_prompt()
        self.assertIn("outcome", prompt)
        self.assertIn("marker_verified", prompt)

    def test_run_intent_with_codex_mcp_async_passes_custom_cwd(self) -> None:
        async def run_test() -> None:
            with patch("apps.runner.codex_worker.assert_codex_github_mcp_available", return_value=None):
                with patch("apps.runner.codex_worker._spawn_codex_mcp_server", return_value=_FakeProc()):
                    with patch("apps.runner.codex_worker._AsyncJsonRpcClient", _FakeClient):
                        with patch("apps.runner.codex_worker.asyncio.create_task", side_effect=_fake_create_task):
                            result = await run_intent_with_codex_mcp_async(
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                backend_base_url="http://localhost:4000",
                                role_bundle={"role": "EXECUTOR", "files": []},
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                                cwd="/tmp/agent-worktrees/run-123",
                            )

            self.assertEqual(result.run_id, "run-123")
            self.assertEqual(result.usage, {"input_tokens": 11, "output_tokens": 7})
            tools_call = next(call for call in _FakeClient.instances[0].calls if call[0] == "tools/call")
            self.assertEqual(tools_call[1]["arguments"]["cwd"], "/tmp/agent-worktrees/run-123")

        asyncio.run(run_test())

    def test_run_intent_with_codex_mcp_async_aggregates_usage_across_replay(self) -> None:
        class _ReplayClient:
            def __init__(self, _proc) -> None:  # noqa: ANN001
                self.calls: list[tuple[str, dict | None]] = []

            async def call(self, method: str, params: dict | None = None, *, timeout_s: float = 120.0) -> dict:
                _ = timeout_s
                self.calls.append((method, params))
                if method == "initialize":
                    return {"protocolVersion": _MCP_PROTOCOL_VERSION}
                if method == "tools/list":
                    return {"tools": [{"name": "codex"}]}
                if method == "tools/call":
                    name = str((params or {}).get("name") or "")
                    if name == "codex":
                        return {
                            "structuredContent": {"threadId": "thread-1", "content": "not-json"},
                            "usage": {"input_tokens": 10, "output_tokens": 3},
                        }
                    if name == "codex-reply":
                        return {
                            "structuredContent": {
                                "threadId": "thread-1",
                                "content": json.dumps(
                                    {
                                        "run_id": "run-123",
                                        "role": "EXECUTOR",
                                        "status": "succeeded",
                                        "summary": "ok",
                                        "urls": {},
                                        "errors": [],
                                        "marker_verified": None,
                                    }
                                ),
                            },
                            "_meta": {"usage": {"input_tokens": "2", "output_tokens": 1.0}},
                        }
                return {}

            async def notify(self, method: str, params: dict | None = None) -> None:
                self.calls.append((method, params))

            async def close(self) -> None:
                return None

        async def run_test() -> None:
            with patch("apps.runner.codex_worker.assert_codex_github_mcp_available", return_value=None):
                with patch("apps.runner.codex_worker._spawn_codex_mcp_server", return_value=_FakeProc()):
                    with patch("apps.runner.codex_worker._AsyncJsonRpcClient", _ReplayClient):
                        with patch("apps.runner.codex_worker.asyncio.create_task", side_effect=_fake_create_task):
                            result = await run_intent_with_codex_mcp_async(
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                backend_base_url="http://localhost:4000",
                                role_bundle={"role": "EXECUTOR", "files": []},
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                            )

            self.assertEqual(result.usage, {"input_tokens": 12, "output_tokens": 4})

        asyncio.run(run_test())

    def test_generate_json_with_codex_mcp_async_passes_custom_cwd(self) -> None:
        async def run_test() -> None:
            with patch("apps.runner.codex_worker.assert_codex_github_mcp_available", return_value=None):
                with patch("apps.runner.codex_worker._spawn_codex_mcp_server", return_value=_FakeProc()):
                    with patch("apps.runner.codex_worker._AsyncJsonRpcClient", _FakeClient):
                        with patch("apps.runner.codex_worker.asyncio.create_task", side_effect=_fake_create_task):
                            result = await generate_json_with_codex_mcp_async(
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                role_bundle={"role": "ORCHESTRATOR", "files": []},
                                prompt="json-prompt",
                                developer_instructions="Return JSON.",
                                cwd="/tmp/agent-worktrees/run-456",
                            )

            self.assertEqual(result, {"ok": True})
            tools_call = next(call for call in _FakeClient.instances[0].calls if call[0] == "tools/call")
            self.assertEqual(tools_call[1]["arguments"]["cwd"], "/tmp/agent-worktrees/run-456")

        asyncio.run(run_test())

    def test_run_intent_with_codex_mcp_async_defaults_cwd_to_dot(self) -> None:
        async def run_test() -> None:
            with patch("apps.runner.codex_worker.assert_codex_github_mcp_available", return_value=None):
                with patch("apps.runner.codex_worker._spawn_codex_mcp_server", return_value=_FakeProc()):
                    with patch("apps.runner.codex_worker._AsyncJsonRpcClient", _FakeClient):
                        with patch("apps.runner.codex_worker.asyncio.create_task", side_effect=_fake_create_task):
                            await run_intent_with_codex_mcp_async(
                                codex_bin="codex",
                                codex_mcp_args="mcp-server",
                                backend_base_url="http://localhost:4000",
                                role_bundle={"role": "EXECUTOR", "files": []},
                                intent={
                                    "type": "RUN_INTENT",
                                    "role": "EXECUTOR",
                                    "run_id": "run-123",
                                    "endpoint": "/internal/executor/claim-ready-item",
                                    "body": {"role": "EXECUTOR", "run_id": "run-123", "sprint": "M1"},
                                },
                            )

            tools_call = next(call for call in _FakeClient.instances[0].calls if call[0] == "tools/call")
            self.assertEqual(tools_call[1]["arguments"]["cwd"], ".")

        asyncio.run(run_test())
