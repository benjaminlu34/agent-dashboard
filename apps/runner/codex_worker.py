from __future__ import annotations

from dataclasses import dataclass
import json
import re
import shlex
import subprocess
import threading
import time
import selectors
from typing import Any, Callable, Dict, Optional


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
    outcome: Optional[str]
    summary: str
    urls: Dict[str, str]
    errors: list[Dict[str, Any]]
    marker_verified: Optional[bool] = None


_MCP_PROTOCOL_VERSION = "2024-11-05"


class _TranscriptWriter:
    def __init__(
        self,
        *,
        repo_root: Optional[str],
        run_id: str,
        transcript_event_sink: Optional[Callable[[str, str], None]] = None,
    ):
        self._lock = threading.Lock()
        self._sink = transcript_event_sink if callable(transcript_event_sink) else None

    def _write(self, section: str, content: str) -> None:
        if not isinstance(content, str) or content == "":
            return
        sink = self._sink
        if sink is None:
            return
        with self._lock:
            try:
                sink(section, content)
            except Exception:
                # Transcript logging must never crash worker execution.
                pass

    def append_message_to_agent(self, prompt_text: str) -> None:
        content = str(prompt_text or "").strip()
        self._write("MESSAGE TO AGENT", content)

    def append_agent_thinking(self, llm_text_content: str) -> None:
        content = str(llm_text_content or "").strip()
        self._write("AGENT THINKING", content)

    def append_system_observation(self, content: str) -> None:
        normalized_content = str(content or "").strip()
        if not normalized_content:
            return
        self._write("SYSTEM OBSERVATION", normalized_content)

    def append_tool_executed(self, tool_name: str) -> None:
        normalized_tool_name = str(tool_name or "").strip() or "unknown"
        self.append_system_observation(f"Tool '{normalized_tool_name}' executed.")

    def close(self) -> None:
        return None


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

        raw_line = self._proc.stdout.readline()
        if raw_line == "":
            return None
        line = raw_line.strip()
        if not line:
            return None
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            raise CodexWorkerError("mcp server emitted non-json output", code="mcp_invalid_json", details={"line": line})
        if not isinstance(value, dict):
            raise CodexWorkerError("mcp server emitted non-object json", code="mcp_invalid_json", details={"value": value})
        return value


def _sandbox_for_role(role: str) -> str:
    normalized = str(role or "").strip().upper()
    if normalized in ("EXECUTOR", "REVIEWER"):
        # Worker roles must reach backend internal endpoints for claim/linkage/transition calls.
        return "danger-full-access"
    raise CodexWorkerError("intent role must be EXECUTOR or REVIEWER", code="worker_invalid_intent")


def _spawn_codex_mcp_server(*, codex_bin: str, codex_mcp_args: str) -> subprocess.Popen[str]:
    argv = [codex_bin, *shlex.split(codex_mcp_args)]
    return subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )


def _close_popen_pipes(proc: subprocess.Popen[str]) -> None:
    for stream in (proc.stdin, proc.stdout, proc.stderr):
        if stream is None:
            continue
        try:
            stream.close()
        except Exception:
            pass


_STDERR_ERROR_HINT_RE = re.compile(r"(error|failed|exception|traceback|timeout|refused|unreachable)", re.IGNORECASE)
_STDERR_COMMAND_HINT_RE = re.compile(
    r"^(?:\$|command:|running command:|run command:)\s*(.+)$",
    re.IGNORECASE,
)


def _clip_text(value: Any, *, max_chars: int = 400) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3].rstrip() + "..."


def _extract_exec_commands_from_payload(payload: Any) -> list[str]:
    commands: list[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            recipient_name = node.get("recipient_name")
            parameters = node.get("parameters")
            cmd = node.get("cmd")

            if (
                isinstance(recipient_name, str)
                and recipient_name in ("functions.exec_command", "exec_command")
                and isinstance(parameters, dict)
                and isinstance(parameters.get("cmd"), str)
                and parameters.get("cmd").strip()
            ):
                commands.append(parameters.get("cmd").strip())

            if isinstance(cmd, str) and cmd.strip():
                tool_name = str(node.get("tool") or node.get("name") or "").strip().lower()
                if tool_name in ("exec_command", "functions.exec_command", "shell", "command"):
                    commands.append(cmd.strip())

            for key in ("tool_uses", "steps", "actions"):
                value = node.get(key)
                if isinstance(value, list):
                    for entry in value:
                        visit(entry)

            for value in node.values():
                if isinstance(value, (dict, list)):
                    visit(value)
        elif isinstance(node, list):
            for entry in node:
                visit(entry)

    visit(payload)

    # Preserve order while deduping.
    seen: set[str] = set()
    deduped: list[str] = []
    for command in commands:
        if command in seen:
            continue
        seen.add(command)
        deduped.append(command)
    return deduped


def _extract_error_message_from_payload(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""

    candidates: list[str] = []

    def append_text(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            candidates.append(value.strip())
        elif isinstance(value, dict):
            for key in ("message", "error", "code", "detail"):
                if isinstance(value.get(key), str) and value.get(key).strip():
                    candidates.append(value.get(key).strip())
        elif isinstance(value, list):
            for entry in value:
                append_text(entry)

    for key in ("error", "message", "msg", "details", "exception"):
        append_text(payload.get(key))

    for candidate in candidates:
        if _STDERR_ERROR_HINT_RE.search(candidate):
            return _clip_text(candidate, max_chars=600)
    return ""


def _extract_transcript_observations_from_stderr_line(line: str) -> list[str]:
    stripped = str(line or "").strip()
    if not stripped:
        return []

    observations: list[str] = []

    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict):
        method = payload.get("method")
        if isinstance(method, str) and method in {"initialize", "tools/list", "shutdown", "notifications/initialized", "exit"}:
            return []

        for command in _extract_exec_commands_from_payload(payload):
            observations.append(f"Command: {_clip_text(command, max_chars=600)}")

        error_message = _extract_error_message_from_payload(payload)
        if error_message:
            observations.append(f"Worker error detail: {error_message}")
        return observations

    command_match = _STDERR_COMMAND_HINT_RE.match(stripped)
    if command_match:
        command = command_match.group(1).strip()
        if command:
            observations.append(f"Command: {_clip_text(command, max_chars=600)}")
            return observations

    if _STDERR_ERROR_HINT_RE.search(stripped):
        observations.append(f"Worker stderr: {_clip_text(stripped, max_chars=600)}")
    return observations


class _CodexStderrMonitor:
    def __init__(self, *, proc: subprocess.Popen[str], transcript_writer: _TranscriptWriter):
        self._proc = proc
        self._transcript_writer = transcript_writer
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._last_observation = ""

    def start(self) -> None:
        stderr = self._proc.stderr
        if stderr is None:
            return
        self._thread = threading.Thread(target=self._run, name="codex-stderr-monitor", daemon=True)
        self._thread.start()

    def stop(self, *, timeout_s: float = 1.0) -> None:
        self._stop_event.set()
        thread = self._thread
        if thread is None:
            return
        thread.join(timeout=timeout_s)

    def _run(self) -> None:
        stderr = self._proc.stderr
        if stderr is None:
            return
        while not self._stop_event.is_set():
            try:
                raw_line = stderr.readline()
            except Exception:
                return
            if raw_line == "":
                return
            for observation in _extract_transcript_observations_from_stderr_line(raw_line):
                if observation == self._last_observation:
                    continue
                self._last_observation = observation
                self._transcript_writer.append_system_observation(observation)


def _extract_worker_result(*, content: str, expected_run_id: str, expected_role: str) -> WorkerResult:
    # Prefer explicit JSON-only output; otherwise scan for a prefixed payload.
    raw = content.strip()
    if "RUNNER_RESULT_JSON:" in raw:
        raw = raw.split("RUNNER_RESULT_JSON:", 1)[1].strip()
    # Strip markdown fences like ```json ... ```
    raw = re.sub(r"^```(?:json)?\s*\n?", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\n?```\s*$", "", raw).strip()
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
    outcome = parsed.get("outcome")
    summary = parsed.get("summary")
    urls = parsed.get("urls")
    errors = parsed.get("errors")
    marker_verified = parsed.get("marker_verified")

    if run_id != expected_run_id or role != expected_role:
        raise CodexWorkerError(
            "worker result identity mismatch",
            code="worker_identity_mismatch",
            details={"expected": {"run_id": expected_run_id, "role": expected_role}, "actual": {"run_id": run_id, "role": role}},
        )
    if status not in ("succeeded", "failed"):
        raise CodexWorkerError("worker result status must be succeeded|failed", code="worker_invalid_output", details={"status": status})
    normalized_outcome: Optional[str] = None
    if outcome is not None:
        if not isinstance(outcome, str):
            raise CodexWorkerError("worker result outcome must be a string when provided", code="worker_invalid_output")
        normalized_outcome = outcome.strip().upper()
    if expected_role == "REVIEWER":
        if normalized_outcome not in ("PASS", "FAIL", "INCOMPLETE"):
            raise CodexWorkerError(
                "reviewer worker must emit outcome PASS|FAIL|INCOMPLETE",
                code="worker_invalid_output",
                details={"outcome": outcome},
            )
    if not isinstance(summary, str):
        raise CodexWorkerError("worker result summary must be a string", code="worker_invalid_output")
    if not isinstance(urls, dict):
        urls = {}
    if not isinstance(errors, list):
        errors = []
    if marker_verified is not None and not isinstance(marker_verified, bool):
        raise CodexWorkerError("worker result marker_verified must be a boolean when provided", code="worker_invalid_output")

    return WorkerResult(
        run_id=run_id,
        role=role,
        status=status,
        outcome=normalized_outcome,
        summary=summary,
        urls={str(k): str(v) for k, v in urls.items()},
        errors=[e if isinstance(e, dict) else {"error": str(e)} for e in errors],
        marker_verified=marker_verified,
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


def _to_transcript_thinking_text(content: str) -> str:
    raw = str(content or "").strip()
    if not raw:
        return ""

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return raw

    if not isinstance(parsed, dict):
        return raw

    lines: list[str] = []
    summary = parsed.get("summary")
    if isinstance(summary, str) and summary.strip():
        lines.append(summary.strip())

    status = parsed.get("status")
    if isinstance(status, str) and status.strip():
        lines.append(f"Status: {status.strip()}")

    outcome = parsed.get("outcome")
    if isinstance(outcome, str) and outcome.strip():
        lines.append(f"Outcome: {outcome.strip()}")

    urls = parsed.get("urls")
    if isinstance(urls, dict) and len(urls) > 0:
        lines.append("Linked URLs:")
        for key in sorted(urls.keys()):
            value = urls.get(key)
            if isinstance(value, str) and value.strip():
                lines.append(f"- {key}: {value.strip()}")

    errors = parsed.get("errors")
    if isinstance(errors, list) and len(errors) > 0:
        lines.append("Errors:")
        for entry in errors:
            if isinstance(entry, dict):
                message = entry.get("message") or entry.get("error") or entry.get("code")
                if isinstance(message, str) and message.strip():
                    lines.append(f"- {message.strip()}")
                    continue
            lines.append(f"- {str(entry)}")

    return "\n".join(lines) if len(lines) > 0 else raw


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
            "- Do NOT change project status directly; runner handles status transition on PASS.\n"
            "- For findings, use checklist IDs (R1, R2, ...) with explicit done conditions.\n"
            "- Do NOT demand videos, screenshots, or other human-only artifacts.\n"
            "- Prefer verification via tests and deterministic manual steps.\n"
            "- If CI/checks are missing or pending with zero checks, treat that as N/A (not a standalone failure).\n"
            "- Canonical linkage note: the EXECUTOR_RUN_V1 marker is often an HTML comment and will be hidden in rendered views. Trust backend /internal/reviewer/resolve-linked-pr; do not claim the marker is missing if the backend resolved the PR.\n"
            "- If executable behavior changed and there are no tests and no deterministic manual verification steps, FAIL with a concrete request.\n"
        )
    elif role == "EXECUTOR":
        role_specific_rules = (
            "Executor-specific constraints:\n"
            "- For any created/updated PR, enforce canonical linkage in PR body and issue comment.\n"
            "- After opening or updating PR, re-fetch PR body and patch it if marker/linkage is missing.\n"
            "- This check must be idempotent.\n"
            "- IMPORTANT: If you output any PR URL in urls (pr_url/pull_request/pr/resolved_pr), you MUST set marker_verified=true.\n"
            "- If intent.endpoint is /internal/reviewer/resolve-linked-pr, this is an In Review fixup run:\n"
            "  - Do NOT open a new PR.\n"
            "  - Use the backend response (pr_number/pr_url/head_ref/head_sha) to check out the existing PR head branch and push new commits to it.\n"
            "  - New commits must descend from head_sha (no history rewrite).\n"
            "  - Do not force-push.\n"
            "- Only modify files within the task's Allowed touch paths (see the issue's ## Scope section). "
            "If you need to modify files outside scope, comment on the issue requesting scope expansion "
            "and stop the run.\n"
        )

    return (
        "You are a Codex worker executing exactly one RUN_INTENT.\n"
        "Non-negotiable rules:\n"
        "- Treat the provided bundle as executable contract; do not summarize, rewrite, or omit any content.\n"
        "- Do not merge PRs. Do not close issues. Do not use auto-close keywords.\n"
        "- Never bypass backend policy gates; all state changes must go through backend endpoints.\n"
        "- Do NOT attempt to start or run the backend server; if the backend endpoint is unreachable, fail closed.\n"
        "- Do not read or write files outside the repository workspace. Never use /tmp or home-directory paths.\n"
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
        '  \"outcome\": null|\"PASS\"|\"FAIL\"|\"INCOMPLETE\",\n'
        '  \"summary\": \"...\",\n'
        '  \"urls\": {\"key\":\"value\"},\n'
        '  \"errors\": [{\"code\":\"...\",\"message\":\"...\"}],\n'
        '  \"marker_verified\": true|false|null\n'
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
    repo_root: Optional[str] = None,
    transcript_event_sink: Optional[Callable[[str, str], None]] = None,
) -> WorkerResult:
    """Execute one intent by spawning `codex mcp-server` and calling the `codex` tool via MCP (stdio).

    This implements line-delimited JSON-RPC 2.0 messages over stdio (MCP stdio transport).
    """
    expected_role = str(intent.get("role") or "").strip().upper()
    expected_run_id = str(intent.get("run_id") or "").strip()
    if expected_role not in ("EXECUTOR", "REVIEWER"):
        raise CodexWorkerError("intent role must be EXECUTOR or REVIEWER", code="worker_invalid_intent")
    sandbox_mode = _sandbox_for_role(expected_role)
    if not expected_run_id:
        raise CodexWorkerError("intent run_id is required", code="worker_invalid_intent")

    transcript_writer = _TranscriptWriter(
        repo_root=repo_root,
        run_id=expected_run_id,
        transcript_event_sink=transcript_event_sink,
    )
    proc = _spawn_codex_mcp_server(codex_bin=codex_bin, codex_mcp_args=codex_mcp_args)
    client = _JsonRpcClient(proc)
    stderr_monitor = _CodexStderrMonitor(proc=proc, transcript_writer=transcript_writer)
    stderr_monitor.start()
    try:
        transcript_writer.append_system_observation("Initializing Codex MCP session.")
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
        transcript_writer.append_message_to_agent(prompt)
        transcript_writer.append_system_observation("Dispatching task to agent.")
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
                        "Do not read or write outside the repository workspace. "
                        "Never merge PRs or close issues. Fail closed on ambiguity."
                    ),
                    "cwd": ".",
                    "sandbox": sandbox_mode,
                    "approval-policy": "never",
                },
            },
            timeout_s=tools_call_timeout_s,
        )
        transcript_writer.append_tool_executed("codex")
        transcript_writer.append_system_observation("Agent response received.")

        thread_id = _extract_thread_id_from_tool_result(tool_result)
        text = _extract_codex_text_from_tool_result(tool_result)
        transcript_writer.append_agent_thinking(_to_transcript_thinking_text(text))
        try:
            return _extract_worker_result(content=text, expected_run_id=expected_run_id, expected_role=expected_role)
        except CodexWorkerError:
            # One strict re-ask to remove ambiguity about output shape.
            transcript_writer.append_system_observation("Initial agent response was not valid JSON; requesting strict JSON replay.")
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
            transcript_writer.append_tool_executed("codex-reply")
            transcript_writer.append_system_observation("Received strict JSON replay from agent.")
            text2 = _extract_codex_text_from_tool_result(tool_result_2)
            transcript_writer.append_agent_thinking(_to_transcript_thinking_text(text2))
            return _extract_worker_result(content=text2, expected_run_id=expected_run_id, expected_role=expected_role)
    except Exception as exc:
        if isinstance(exc, CodexWorkerError):
            transcript_writer.append_system_observation(
                f"Worker failure ({exc.code}): {_clip_text(exc, max_chars=700)}"
            )
        else:
            transcript_writer.append_system_observation(f"Worker failure: {_clip_text(exc, max_chars=700)}")
        raise
    finally:
        stderr_monitor.stop(timeout_s=0.5)
        try:
            client.call("shutdown", {}, timeout_s=5.0)
            client.notify("exit", {})
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            proc.kill()
        except Exception:
            pass
        _close_popen_pipes(proc)
        transcript_writer.close()


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
    run_id: Optional[str] = None,
    repo_root: Optional[str] = None,
    transcript_event_sink: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    """Spawn `codex mcp-server` and ask Codex to output a single JSON object (no prose)."""
    if not isinstance(prompt, str) or not prompt.strip():
        raise CodexWorkerError("prompt is required", code="codex_invalid_prompt")
    if not isinstance(developer_instructions, str) or not developer_instructions.strip():
        raise CodexWorkerError("developer_instructions is required", code="codex_invalid_prompt")

    transcript_writer = _TranscriptWriter(
        repo_root=repo_root,
        run_id=str(run_id or "").strip(),
        transcript_event_sink=transcript_event_sink,
    )
    proc = _spawn_codex_mcp_server(codex_bin=codex_bin, codex_mcp_args=codex_mcp_args)
    client = _JsonRpcClient(proc)
    stderr_monitor = _CodexStderrMonitor(proc=proc, transcript_writer=transcript_writer)
    stderr_monitor.start()
    try:
        transcript_writer.append_system_observation("Initializing Codex MCP session.")
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
        transcript_writer.append_message_to_agent(prompt)
        transcript_writer.append_system_observation("Dispatching task to agent.")
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
        transcript_writer.append_tool_executed("codex")
        transcript_writer.append_system_observation("Agent response received.")

        thread_id = _extract_thread_id_from_tool_result(tool_result)
        text = _extract_codex_text_from_tool_result(tool_result)
        transcript_writer.append_agent_thinking(_to_transcript_thinking_text(text))
        raw = text.strip()
        # Strip markdown fences like ```json ... ```
        raw = re.sub(r"^```(?:json)?\s*\n?", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\n?```\s*$", "", raw).strip()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            transcript_writer.append_system_observation("Initial agent response was not valid JSON; requesting strict JSON replay.")
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
            transcript_writer.append_tool_executed("codex-reply")
            transcript_writer.append_system_observation("Received strict JSON replay from agent.")
            text2 = _extract_codex_text_from_tool_result(tool_result_2)
            transcript_writer.append_agent_thinking(_to_transcript_thinking_text(text2))
            raw = text2.strip()
            # Strip markdown fences like ```json ... ```
            raw = re.sub(r"^```(?:json)?\s*\n?", "", raw, flags=re.IGNORECASE)
            raw = re.sub(r"\n?```\s*$", "", raw).strip()
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise CodexWorkerError(
                    "codex output was not valid JSON",
                    code="worker_invalid_output",
                    details={"error": str(exc), "content": text2[:2000]},
                ) from None

        if not isinstance(parsed, dict):
            raise CodexWorkerError("codex kickoff output must be a JSON object", code="worker_invalid_output")

        return parsed
    except Exception as exc:
        if isinstance(exc, CodexWorkerError):
            transcript_writer.append_system_observation(
                f"Worker failure ({exc.code}): {_clip_text(exc, max_chars=700)}"
            )
        else:
            transcript_writer.append_system_observation(f"Worker failure: {_clip_text(exc, max_chars=700)}")
        raise
    finally:
        stderr_monitor.stop(timeout_s=0.5)
        try:
            client.call("shutdown", {}, timeout_s=5.0)
            client.notify("exit", {})
        except Exception:
            pass
        try:
            proc.terminate()
            proc.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            proc.kill()
        except Exception:
            pass
        _close_popen_pipes(proc)
        transcript_writer.close()
