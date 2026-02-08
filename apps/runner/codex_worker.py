from __future__ import annotations

from dataclasses import dataclass
import json
import shlex
import subprocess
import threading
import time
import selectors
from typing import Any, Dict, Optional


class CodexWorkerError(Exception):
    def __init__(self, message: str, *, code: str = "codex_worker_error", details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class WorkerResult:
    run_id: str
    role: str
    status: str  # succeeded|failed
    summary: str
    urls: Dict[str, str]
    errors: list[Dict[str, Any]]


_MCP_PROTOCOL_VERSION = "2024-11-05"


class _JsonRpcClient:
    def __init__(self, proc: subprocess.Popen[str]):
        self._proc = proc
        self._lock = threading.Lock()
        self._next_id = 1

    def call(self, method: str, params: Optional[dict[str, Any]] = None, *, timeout_s: float = 120.0) -> dict[str, Any]:
        request_id = self._reserve_id()
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        self._send(payload)

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            message = self._recv_one(timeout_s=max(0.1, deadline - time.time()))
            if message is None:
                continue
            if message.get("id") != request_id:
                # Ignore notifications or unrelated responses.
                continue
            if "error" in message:
                raise CodexWorkerError(
                    "mcp server returned error",
                    code="mcp_error_response",
                    details={"method": method, "error": message.get("error")},
                )
            result = message.get("result")
            if not isinstance(result, dict):
                raise CodexWorkerError(
                    "mcp server returned invalid result type",
                    code="mcp_invalid_result",
                    details={"method": method, "result": result},
                )
            return result

        raise CodexWorkerError("mcp call timed out", code="mcp_timeout", details={"method": method})

    def notify(self, method: str, params: Optional[dict[str, Any]] = None) -> None:
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self._send(payload)

    def _reserve_id(self) -> int:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            return request_id

    def _send(self, obj: dict[str, Any]) -> None:
        if self._proc.stdin is None:
            raise CodexWorkerError("mcp server stdin is not available", code="mcp_stdio_unavailable")
        self._proc.stdin.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
        self._proc.stdin.flush()

    def _recv_one(self, *, timeout_s: float) -> Optional[dict[str, Any]]:
        if self._proc.stdout is None:
            raise CodexWorkerError("mcp server stdout is not available", code="mcp_stdio_unavailable")

        selector = selectors.DefaultSelector()
        try:
            selector.register(self._proc.stdout, selectors.EVENT_READ)
            ready = selector.select(timeout=timeout_s)
        finally:
            try:
                selector.unregister(self._proc.stdout)
            except Exception:
                pass
            selector.close()

        if not ready:
            return None

        line = self._proc.stdout.readline()
        if line == "":
            return None
        line = line.strip()
        if not line:
            return None
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            raise CodexWorkerError("mcp server emitted non-json output", code="mcp_invalid_json", details={"line": line})
        if not isinstance(value, dict):
            raise CodexWorkerError("mcp server emitted non-object json", code="mcp_invalid_json", details={"value": value})
        return value


def _spawn_codex_mcp_server(*, codex_bin: str, codex_mcp_args: str) -> subprocess.Popen[str]:
    argv = [codex_bin, *shlex.split(codex_mcp_args)]
    return subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,  # inherit for visibility; avoids pipe deadlocks
        text=True,
        bufsize=1,
    )


def _extract_worker_result(*, content: str, expected_run_id: str, expected_role: str) -> WorkerResult:
    # Prefer explicit JSON-only output; otherwise scan for a prefixed payload.
    raw = content.strip()
    if "RUNNER_RESULT_JSON:" in raw:
        raw = raw.split("RUNNER_RESULT_JSON:", 1)[1].strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CodexWorkerError(
            "codex output was not valid JSON; worker must output JSON only",
            code="worker_invalid_output",
            details={"error": str(exc), "content": content[:2000]},
        ) from None

    if not isinstance(parsed, dict):
        raise CodexWorkerError("worker result must be a JSON object", code="worker_invalid_output", details={"content": content[:2000]})

    run_id = parsed.get("run_id")
    role = parsed.get("role")
    status = parsed.get("status")
    summary = parsed.get("summary")
    urls = parsed.get("urls")
    errors = parsed.get("errors")

    if run_id != expected_run_id or role != expected_role:
        raise CodexWorkerError(
            "worker result identity mismatch",
            code="worker_identity_mismatch",
            details={"expected": {"run_id": expected_run_id, "role": expected_role}, "actual": {"run_id": run_id, "role": role}},
        )
    if status not in ("succeeded", "failed"):
        raise CodexWorkerError("worker result status must be succeeded|failed", code="worker_invalid_output", details={"status": status})
    if not isinstance(summary, str):
        raise CodexWorkerError("worker result summary must be a string", code="worker_invalid_output")
    if not isinstance(urls, dict):
        urls = {}
    if not isinstance(errors, list):
        errors = []

    return WorkerResult(
        run_id=run_id,
        role=role,
        status=status,
        summary=summary,
        urls={str(k): str(v) for k, v in urls.items()},
        errors=[e if isinstance(e, dict) else {"error": str(e)} for e in errors],
    )


def _extract_codex_text_from_tool_result(tool_result: dict[str, Any]) -> str:
    # Official Codex MCP server responses may return `structuredContent` (preferred by modern MCP clients)
    # and/or a legacy `content` array of content blocks.
    structured = tool_result.get("structuredContent")
    if isinstance(structured, dict):
        structured_content = structured.get("content")
        if isinstance(structured_content, str) and structured_content.strip():
            return structured_content

    content = tool_result.get("content")
    if isinstance(content, str) and content.strip():
        return content

    if isinstance(content, list):
        text_chunks: list[str] = []
        for entry in content:
            if isinstance(entry, dict) and entry.get("type") == "text" and isinstance(entry.get("text"), str):
                text_chunks.append(entry["text"])
        joined = "\n".join(text_chunks).strip()
        if joined:
            return joined

    raise CodexWorkerError("codex tool returned no text content", code="worker_invalid_output", details={"result": tool_result})


def _extract_thread_id_from_tool_result(tool_result: dict[str, Any]) -> str:
    structured = tool_result.get("structuredContent")
    if isinstance(structured, dict) and isinstance(structured.get("threadId"), str) and structured["threadId"].strip():
        return structured["threadId"].strip()
    raise CodexWorkerError("codex tool result missing structuredContent.threadId", code="worker_invalid_output")


def _bundle_to_base_instructions(role_bundle: Dict[str, Any]) -> str:
    role = role_bundle.get("role")
    files = role_bundle.get("files")

    if not isinstance(role, str) or not role.strip():
        raise CodexWorkerError("agent context bundle missing role", code="bundle_invalid")
    if not isinstance(files, list):
        raise CodexWorkerError("agent context bundle missing files array", code="bundle_invalid")

    parts: list[str] = []
    parts.append(f"ROLE: {role.strip()}")
    parts.append("BUNDLE_FILES_BEGIN")
    for entry in files:
        path = entry.get("path") if isinstance(entry, dict) else None
        content = entry.get("content") if isinstance(entry, dict) else None
        if not isinstance(path, str) or not path.strip():
            raise CodexWorkerError("bundle file missing path", code="bundle_invalid")
        if not isinstance(content, str):
            raise CodexWorkerError("bundle file missing content", code="bundle_invalid", details={"path": path})
        parts.append(f"FILE_BEGIN {path.strip()}")
        parts.append(content)
        parts.append(f"FILE_END {path.strip()}")
    parts.append("BUNDLE_FILES_END")
    return "\n".join(parts)


def _build_worker_prompt(*, role_bundle: Dict[str, Any], intent: Dict[str, Any], backend_base_url: str) -> str:
    role = str(intent.get("role") or "").strip().upper()
    run_id = str(intent.get("run_id") or "").strip()

    intent_json = json.dumps(intent, ensure_ascii=False, indent=2)

    role_specific_rules = ""
    if role == "REVIEWER":
        role_specific_rules = (
            "Reviewer-specific constraints:\n"
            "- Leave feedback as GitHub ISSUE comments only.\n"
            "- Do NOT call github.pull_request_review_write and do NOT submit approvals.\n"
            "- For findings, use checklist IDs (R1, R2, ...) and include explicit done conditions.\n"
            "- End feedback with: Reviewer: addressed (requesting evidence per item ID).\n"
        )

    return (
        "You are a Codex worker executing exactly one RUN_INTENT.\n"
        "Non-negotiable rules:\n"
        "- Treat the provided bundle as executable contract; do not summarize, rewrite, or omit any content.\n"
        "- Do not merge PRs. Do not close issues. Do not use auto-close keywords.\n"
        "- Never bypass backend policy gates; all state changes must go through backend endpoints.\n"
        "- Do NOT attempt to start or run the backend server; if the backend endpoint is unreachable, fail closed.\n"
        "- Fail closed on ambiguity.\n\n"
        f"Backend base URL: {backend_base_url}\n\n"
        f"{role_specific_rules}\n"
        "RUN_INTENT (verbatim):\n"
        f"{intent_json}\n\n"
        "Execution requirement:\n"
        "- Call the backend endpoint at: <backend base URL> + intent.endpoint with JSON body intent.body.\n"
        "- Then follow the role runbook (from base-instructions) to complete the workflow.\n\n"
        "Return EXACTLY one JSON object and nothing else (no prose, no markdown, no wrappers) with this exact shape:\n"
        "{\n"
        f'  \"run_id\": \"{run_id}\",\n'
        f'  \"role\": \"{role}\",\n'
        '  \"status\": \"succeeded\"|\"failed\",\n'
        '  \"summary\": \"...\",\n'
        '  \"urls\": {\"key\":\"value\"},\n'
        '  \"errors\": [{\"code\":\"...\",\"message\":\"...\"}]\n'
        "}\n"
    )


def run_intent_with_codex_mcp(
    *,
    codex_bin: str,
    codex_mcp_args: str,
    backend_base_url: str,
    role_bundle: Dict[str, Any],
    intent: Dict[str, Any],
    tools_call_timeout_s: float = 600.0,
) -> WorkerResult:
    """Execute one intent by spawning `codex mcp-server` and calling the `codex` tool via MCP (stdio).

    This implements line-delimited JSON-RPC 2.0 messages over stdio (MCP stdio transport).
    """
    expected_role = str(intent.get("role") or "").strip().upper()
    expected_run_id = str(intent.get("run_id") or "").strip()
    if expected_role not in ("EXECUTOR", "REVIEWER"):
        raise CodexWorkerError("intent role must be EXECUTOR or REVIEWER", code="worker_invalid_intent")
    if not expected_run_id:
        raise CodexWorkerError("intent run_id is required", code="worker_invalid_intent")

    proc = _spawn_codex_mcp_server(codex_bin=codex_bin, codex_mcp_args=codex_mcp_args)
    client = _JsonRpcClient(proc)
    try:
        init = client.call(
            "initialize",
            {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "agent-swarm-runner", "version": "0.1.0"},
            },
            timeout_s=30.0,
        )
        if init.get("protocolVersion") != _MCP_PROTOCOL_VERSION:
            raise CodexWorkerError(
                "mcp protocol version mismatch",
                code="mcp_protocol_mismatch",
                details={"expected": _MCP_PROTOCOL_VERSION, "actual": init.get("protocolVersion")},
            )

        client.notify("notifications/initialized", {})

        tools = client.call("tools/list", {}, timeout_s=30.0).get("tools")
        if not isinstance(tools, list):
            raise CodexWorkerError("mcp tools/list returned invalid tools", code="mcp_invalid_tools")

        codex_tool = next((t for t in tools if isinstance(t, dict) and t.get("name") == "codex"), None)
        if not codex_tool:
            raise CodexWorkerError("codex tool not available on mcp server", code="mcp_missing_codex_tool")

        if not isinstance(backend_base_url, str) or not backend_base_url.strip():
            raise CodexWorkerError("backend_base_url is required", code="worker_invalid_intent")

        prompt = _build_worker_prompt(role_bundle=role_bundle, intent=intent, backend_base_url=backend_base_url.strip())
        bundle_instructions = _bundle_to_base_instructions(role_bundle)
        tool_result = client.call(
            "tools/call",
            {
                "name": "codex",
                "arguments": {
                    "prompt": prompt,
                    # Inject the bundle verbatim as base instructions.
                    "base-instructions": bundle_instructions,
                    # Runner-level guardrails (bundle remains source-of-truth).
                    "developer-instructions": (
                        "Treat base-instructions as executable contract. Do not rewrite or summarize it. "
                        "Do not attempt to start the backend server. "
                        "Never merge PRs or close issues. Fail closed on ambiguity."
                    ),
                    "cwd": ".",
                    # Codex sandbox restrictions can prevent reaching a locally running backend on localhost.
                    # Worker must be able to call the backend endpoints to claim/transition safely.
                    "sandbox": "danger-full-access",
                    "approval-policy": "never",
                },
            },
            timeout_s=tools_call_timeout_s,
        )

        thread_id = _extract_thread_id_from_tool_result(tool_result)
        text = _extract_codex_text_from_tool_result(tool_result)
        try:
            return _extract_worker_result(content=text, expected_run_id=expected_run_id, expected_role=expected_role)
        except CodexWorkerError:
            # One strict re-ask to remove ambiguity about output shape.
            tool_result_2 = client.call(
                "tools/call",
                {
                    "name": "codex-reply",
                    "arguments": {
                        "threadId": thread_id,
                        "prompt": (
                            "Re-output the final result as JSON only with keys: run_id, role, status, summary, urls, errors. "
                            "No prose."
                        ),
                    },
                },
                timeout_s=180.0,
            )
            text2 = _extract_codex_text_from_tool_result(tool_result_2)
            return _extract_worker_result(content=text2, expected_run_id=expected_run_id, expected_role=expected_role)
    finally:
        try:
            client.call("shutdown", {}, timeout_s=5.0)
            client.notify("exit", {})
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass


def generate_json_with_codex_mcp(
    *,
    codex_bin: str,
    codex_mcp_args: str,
    role_bundle: Dict[str, Any],
    prompt: str,
    developer_instructions: str,
    sandbox: str = "read-only",
    approval_policy: str = "never",
    tools_call_timeout_s: float = 600.0,
) -> Dict[str, Any]:
    """Spawn `codex mcp-server` and ask Codex to output a single JSON object (no prose)."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise CodexWorkerError("prompt is required", code="codex_invalid_prompt")
    if not isinstance(developer_instructions, str) or not developer_instructions.strip():
        raise CodexWorkerError("developer_instructions is required", code="codex_invalid_prompt")

    proc = _spawn_codex_mcp_server(codex_bin=codex_bin, codex_mcp_args=codex_mcp_args)
    client = _JsonRpcClient(proc)
    try:
        init = client.call(
            "initialize",
            {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "agent-swarm-runner", "version": "0.1.0"},
            },
            timeout_s=30.0,
        )
        if init.get("protocolVersion") != _MCP_PROTOCOL_VERSION:
            raise CodexWorkerError(
                "mcp protocol version mismatch",
                code="mcp_protocol_mismatch",
                details={"expected": _MCP_PROTOCOL_VERSION, "actual": init.get("protocolVersion")},
            )

        client.notify("notifications/initialized", {})

        tools = client.call("tools/list", {}, timeout_s=30.0).get("tools")
        if not isinstance(tools, list):
            raise CodexWorkerError("mcp tools/list returned invalid tools", code="mcp_invalid_tools")

        codex_tool = next((t for t in tools if isinstance(t, dict) and t.get("name") == "codex"), None)
        if not codex_tool:
            raise CodexWorkerError("codex tool not available on mcp server", code="mcp_missing_codex_tool")

        bundle_instructions = _bundle_to_base_instructions(role_bundle)
        tool_result = client.call(
            "tools/call",
            {
                "name": "codex",
                "arguments": {
                    "prompt": prompt,
                    "base-instructions": bundle_instructions,
                    "developer-instructions": developer_instructions,
                    "cwd": ".",
                    "sandbox": sandbox,
                    "approval-policy": approval_policy,
                },
            },
            timeout_s=tools_call_timeout_s,
        )

        thread_id = _extract_thread_id_from_tool_result(tool_result)
        text = _extract_codex_text_from_tool_result(tool_result)
        try:
            parsed = json.loads(text.strip())
        except json.JSONDecodeError:
            tool_result_2 = client.call(
                "tools/call",
                {
                    "name": "codex-reply",
                    "arguments": {
                        "threadId": thread_id,
                        "prompt": "Re-output the final result as JSON only. No prose. No markdown.",
                    },
                },
                timeout_s=180.0,
            )
            text2 = _extract_codex_text_from_tool_result(tool_result_2)
            try:
                parsed = json.loads(text2.strip())
            except json.JSONDecodeError as exc:
                raise CodexWorkerError(
                    "codex output was not valid JSON",
                    code="worker_invalid_output",
                    details={"error": str(exc), "content": text2[:2000]},
                ) from None

        if not isinstance(parsed, dict):
            raise CodexWorkerError("codex kickoff output must be a JSON object", code="worker_invalid_output")

        return parsed
    finally:
        try:
            client.call("shutdown", {}, timeout_s=5.0)
            client.notify("exit", {})
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass
