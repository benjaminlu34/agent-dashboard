from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
import os
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path
import selectors

from .codex_worker import CodexWorkerError, generate_json_with_codex_mcp, run_intent_with_codex_mcp
from .config import load_config
from .http_client import BackendClient, HttpError
from .intents import IntentError, RunIntent, parse_intent, parse_json_line
from .ledger import LedgerEntry, RunLedger
from .kickoff import KickoffError, kickoff_plan_to_plan_apply_draft, validate_kickoff_plan


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def classify_failure(error: Exception) -> str:
    # Returns one of: HARD_STOP, ITEM_STOP, TRANSIENT
    if isinstance(error, IntentError):
        return "HARD_STOP"
    if isinstance(error, HttpError):
        if error.code in ("backend_unreachable",):
            return "TRANSIENT"
        if error.status_code == 409:
            return "ITEM_STOP"
        if error.status_code >= 500:
            return "TRANSIENT"
        # Backend 4xx is treated as fail-closed; caller can inspect payload.
        return "HARD_STOP"
    if isinstance(error, CodexWorkerError):
        if error.code in {
            "mcp_timeout",
            "mcp_error_response",
            "mcp_invalid_result",
            "mcp_invalid_json",
            "worker_invalid_output",
            "worker_identity_mismatch",
            "mcp_stdio_unavailable",
        }:
            return "ITEM_STOP"
        return "HARD_STOP"
    return "HARD_STOP"


def exit_code_for_classification(classification: str) -> int:
    if classification == "TRANSIENT":
        return 4
    if classification == "HARD_STOP":
        return 2
    if classification == "ITEM_STOP":
        return 0
    return 2


def _atomic_write_json(path: str, obj: Dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    temp_path.write_text(json.dumps(obj, ensure_ascii=True, indent=2) + "\n", encoding="utf8")
    temp_path.replace(target)


def _load_json_file(path: str) -> Optional[Dict[str, Any]]:
    try:
        raw = Path(path).read_text(encoding="utf8")
    except FileNotFoundError:
        return None
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _priority_rank(priority: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2}.get(priority, 99)


def _maybe_autopromote_ready(
    *,
    summary: Dict[str, Any],
    sprint_plan: Optional[Dict[str, Any]],
    backend: BackendClient,
    dry_run: bool,
    ready_target: int,
) -> None:
    if int(ready_target) <= 0:
        return

    if sprint_plan and summary.get("sprint") != sprint_plan.get("sprint"):
        return

    processed_items = summary.get("processed_items")
    if not isinstance(processed_items, list):
        return

    status_by_issue: Dict[int, str] = {}
    project_item_id_by_issue: Dict[int, str] = {}
    for entry in processed_items:
        if not isinstance(entry, dict):
            continue
        issue_number = entry.get("issue_number")
        project_item_id = entry.get("project_item_id")
        status = entry.get("status")
        if not isinstance(issue_number, int) or issue_number <= 0:
            continue
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            continue
        if not isinstance(status, str) or not status.strip():
            continue
        status_by_issue[issue_number] = status
        project_item_id_by_issue[issue_number] = project_item_id

    status_counts = summary.get("status_counts")
    current_ready = 0
    if isinstance(status_counts, dict):
        current_ready = int(status_counts.get("Ready") or 0)
    deficit = max(0, int(ready_target) - current_ready)
    if deficit == 0:
        return

    eligible: list[Dict[str, Any]] = []
    if sprint_plan:
        tasks = sprint_plan.get("tasks")
        if not isinstance(tasks, list):
            raise ValueError("sprint plan tasks missing/invalid")

        title_to_issue: Dict[str, int] = {}
        for task in tasks:
            if not isinstance(task, dict):
                continue
            title = task.get("title")
            issue_number = task.get("issue_number")
            if isinstance(title, str) and isinstance(issue_number, int):
                title_to_issue[title] = issue_number

        for task in tasks:
            if not isinstance(task, dict):
                continue
            issue_number = task.get("issue_number")
            title = task.get("title")
            priority = task.get("priority")
            depends = task.get("depends_on_titles") or []
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if status_by_issue.get(issue_number) != "Backlog":
                continue
            if not isinstance(title, str) or not title.strip():
                continue
            if not isinstance(priority, str) or priority not in ("P0", "P1", "P2"):
                raise ValueError("sprint plan task priority missing/invalid")
            if not isinstance(depends, list) or any(not isinstance(d, str) or not d.strip() for d in depends):
                raise ValueError("sprint plan task depends_on_titles missing/invalid")

            deps_ok = True
            for dep_title in depends:
                dep_issue = title_to_issue.get(dep_title)
                if not isinstance(dep_issue, int):
                    raise ValueError("sprint plan dependency title missing mapping")
                dep_status = status_by_issue.get(dep_issue)
                if dep_status not in ("In Review", "Needs Human Approval", "Done"):
                    deps_ok = False
                    break
            if not deps_ok:
                continue

            project_item_id = project_item_id_by_issue.get(issue_number)
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                raise ValueError("missing project_item_id mapping for task")

            eligible.append(
                {
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "title": title,
                    "priority": priority,
                }
            )
    else:
        for entry in processed_items:
            if not isinstance(entry, dict):
                continue
            issue_number = entry.get("issue_number")
            project_item_id = entry.get("project_item_id")
            status = entry.get("status")
            if status != "Backlog":
                continue
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            eligible.append(
                {
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "title": f"#{issue_number}",
                    "priority": "P2",
                }
            )

    eligible.sort(key=lambda t: (_priority_rank(str(t["priority"])), int(t["issue_number"])))
    promote = eligible[:deficit]
    if not promote:
        return

    for item in promote:
        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": item["project_item_id"],
            "field": "Status",
            "value": "Ready",
        }
        if dry_run:
            _log_stderr(
                {
                    "type": "BOARD_PROMOTION",
                    "issue_number": item["issue_number"],
                    "project_item_id": item["project_item_id"],
                    "from": "Backlog",
                    "to": "Ready",
                    "reason": "ready_buffer_low",
                    "dry_run": True,
                    "body": body,
                }
            )
            continue

        payload = backend.post_json("/internal/project-item/update-field", body=body)
        _log_stderr(
            {
                "type": "BOARD_PROMOTION",
                "issue_number": item["issue_number"],
                "project_item_id": item["project_item_id"],
                "from": "Backlog",
                "to": "Ready",
                "reason": "ready_buffer_low",
                "dry_run": False,
                "backend_payload": payload,
            }
        )


class Runner:
    def __init__(
        self,
        *,
        backend: BackendClient,
        ledger: Optional[RunLedger],
        dry_run: bool,
        codex_bin: str,
        codex_mcp_args: str,
        codex_tools_call_timeout_s: float,
        orchestrator_state_path: str,
    ):
        self._backend = backend
        self._ledger = ledger
        self._dry_run = dry_run
        self._codex_bin = codex_bin
        self._codex_mcp_args = codex_mcp_args
        self._codex_tools_call_timeout_s = codex_tools_call_timeout_s
        self._orchestrator_state_path = orchestrator_state_path

        self._executor_queue: "queue.Queue[RunIntent]" = queue.Queue()
        self._reviewer_queue: "queue.Queue[RunIntent]" = queue.Queue()

        self._hard_stop_event = threading.Event()
        self._hard_stop_reason: Optional[str] = None

    def hard_stop(self, reason: str) -> None:
        self._hard_stop_reason = reason
        self._hard_stop_event.set()

    def enqueue(self, intent: RunIntent) -> None:
        if intent.role == "EXECUTOR":
            self._executor_queue.put(intent)
        else:
            self._reviewer_queue.put(intent)

    def should_stop(self) -> bool:
        return self._hard_stop_event.is_set()

    def stop_reason(self) -> str:
        return self._hard_stop_reason or "hard stop"

    def _resolve_run_context(self, run_id: str) -> Optional[Tuple[int, str, str]]:
        try:
            state = _load_json_file(self._orchestrator_state_path)
        except Exception:
            return None
        if not state:
            return None
        items = state.get("items")
        if not isinstance(items, dict):
            return None

        for project_item_id, entry in items.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("last_run_id") != run_id:
                continue
            if entry.get("last_dispatched_role") != "EXECUTOR":
                continue
            issue_number = entry.get("last_seen_issue_number")
            status = entry.get("last_seen_status")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            if not isinstance(status, str) or not status.strip():
                status = ""
            return issue_number, project_item_id, status
        return None

    def _transition_executor_failure_to_blocked(self, *, run_id: str, failure_classification: str, failure_message: str) -> None:
        context = self._resolve_run_context(run_id)
        if not context:
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_SKIPPED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "reason": "run_context_not_found",
                }
            )
            return

        issue_number, project_item_id, status = context
        if status != "In Progress":
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_SKIPPED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "reason": "status_not_in_progress",
                    "status": status,
                }
            )
            return

        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Blocked",
            "issue_number": issue_number,
            "failure_classification": failure_classification,
            "failure_message": failure_message[:1000],
            "suggested_next_steps": [
                "Inspect runner logs and ledger entry for this run_id.",
                "Validate PR linkage and backend policy constraints.",
                "Move item to Ready only after remediation is complete.",
            ],
            "run_id": run_id,
        }
        try:
            payload = self._backend.post_json("/internal/project-item/update-field", body=body)
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_STATUS_UPDATED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "from": "In Progress",
                    "to": "Blocked",
                    "backend_payload": payload,
                }
            )
        except HttpError as exc:
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_FAILED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "error": str(exc),
                    "code": exc.code,
                    "status_code": exc.status_code,
                    "payload": exc.payload,
                }
            )
        except Exception as exc:  # pragma: no cover - defensive fallback
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_FAILED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "error": str(exc),
                }
            )

    def run_worker_loop(self, *, role: str) -> None:
        intent_queue = self._executor_queue if role == "EXECUTOR" else self._reviewer_queue

        while not self.should_stop():
            try:
                intent = intent_queue.get(timeout=0.2)
            except queue.Empty:
                continue

            try:
                self._handle_intent(intent)
            except Exception as exc:
                classification = classify_failure(exc)
                if classification == "ITEM_STOP":
                    _log_stderr({"type": "ITEM_STOP", "role": role, "run_id": intent.run_id, "error": str(exc)})
                else:
                    self.hard_stop(f"{classification}: {exc}")
            finally:
                intent_queue.task_done()

    def _handle_intent(self, intent: RunIntent) -> None:
        if self._dry_run:
            _log_stderr(
                {
                    "type": "DRY_RUN_WOULD_EXECUTE",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "endpoint": intent.endpoint,
                    "body": intent.body,
                }
            )
            return

        started_at = time.time()
        heartbeat_stop = threading.Event()

        def heartbeat() -> None:
            # Avoid the appearance of a dead runner during long Codex calls.
            while not heartbeat_stop.wait(30.0):
                _log_stderr(
                    {
                        "type": "WORKER_HEARTBEAT",
                        "role": intent.role,
                        "run_id": intent.run_id,
                        "elapsed_s": int(time.time() - started_at),
                    }
                )

        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        heartbeat_thread.start()

        if self._ledger:
            existing = self._ledger.get(intent.run_id)
            if existing and existing.get("status") == "succeeded":
                _log_stderr({"type": "LEDGER_SKIP", "run_id": intent.run_id, "reason": "already_succeeded"})
                heartbeat_stop.set()
                return

            if not existing:
                self._ledger.upsert(
                    LedgerEntry(
                        run_id=intent.run_id,
                        role=intent.role,
                        intent_hash=intent.intent_hash,
                        received_at=_utc_now_iso(),
                        status="queued",
                        result=None,
                    )
                )
            self._ledger.mark_running(intent.run_id)

        try:
            _log_stderr(
                {
                    "type": "WORKER_STARTED",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "endpoint": intent.endpoint,
                    "executor_queue_depth": self._executor_queue.qsize(),
                    "reviewer_queue_depth": self._reviewer_queue.qsize(),
                }
            )
            # Bundle injection: fetch verbatim from backend.
            bundle = self._backend.get_agent_context(intent.role)

            # Execute via Codex MCP worker (Codex MCP server is spawned per intent).
            result = run_intent_with_codex_mcp(
                codex_bin=self._codex_bin,
                codex_mcp_args=self._codex_mcp_args,
                backend_base_url=self._backend.base_url,
                role_bundle=bundle,
                intent=intent.raw,
                tools_call_timeout_s=self._codex_tools_call_timeout_s,
            )
        except Exception as exc:
            heartbeat_stop.set()
            failure_classification = classify_failure(exc)
            _log_stderr(
                {
                    "type": "WORKER_FAILED",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "elapsed_s": int(time.time() - started_at),
                    "classification": failure_classification,
                    "error": str(exc),
                }
            )
            if intent.role == "EXECUTOR":
                self._transition_executor_failure_to_blocked(
                    run_id=intent.run_id,
                    failure_classification=failure_classification,
                    failure_message=str(exc),
                )
            if self._ledger:
                self._ledger.mark_result(
                    intent.run_id,
                    status="failed",
                    result={"status": "failed", "summary": str(exc), "urls": {}, "errors": [{"error": str(exc)}]},
                )
            raise

        heartbeat_stop.set()
        _log_stderr(
            {
                "type": "WORKER_FINISHED",
                "role": intent.role,
                "run_id": intent.run_id,
                "elapsed_s": int(time.time() - started_at),
                "status": result.status,
                "summary": result.summary[:500],
                "urls": result.urls,
                "errors_count": len(result.errors),
            }
        )
        if self._ledger:
            self._ledger.mark_result(
                intent.run_id,
                status="succeeded" if result.status == "succeeded" else "failed",
                result={
                    "run_id": result.run_id,
                    "role": result.role,
                    "status": result.status,
                    "summary": result.summary,
                    "urls": result.urls,
                    "errors": result.errors,
                },
            )
        if intent.role == "EXECUTOR" and result.status != "succeeded":
            self._transition_executor_failure_to_blocked(
                run_id=intent.run_id,
                failure_classification="ITEM_STOP",
                failure_message=result.summary,
            )


def _log_stderr(obj: Dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stderr.flush()


def _spawn_orchestrator(cmd: str, *, env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        cmd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        bufsize=1,
    )


def _assert_codex_github_mcp_available(*, codex_bin: str) -> None:
    # Fail closed if Codex CLI isn't configured to expose GitHub MCP tools (github + github_projects).
    # Worker runbooks rely on these tools for PR/issue/project operations.
    try:
        completed = subprocess.run(
            [codex_bin, "mcp", "list"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexWorkerError("failed to check codex mcp configuration", code="codex_mcp_check_failed") from exc

    output = (completed.stdout or "") + "\n" + (completed.stderr or "")
    if completed.returncode != 0:
        raise CodexWorkerError(
            "codex mcp list failed",
            code="codex_mcp_check_failed",
            details={"exit_code": completed.returncode, "output": output.strip()[:2000]},
        )

    def has_enabled(name: str) -> bool:
        for line in output.splitlines():
            if line.strip().startswith(name):
                return "enabled" in line
        return False

    missing = [name for name in ("github", "github_projects") if not has_enabled(name)]
    if missing:
        raise CodexWorkerError(
            "required codex mcp servers are not enabled",
            code="codex_mcp_servers_missing",
            details={"missing": missing, "hint": "Run `codex mcp login github` and ensure GITHUB_PAT is set."},
        )


def _build_kickoff_prompt(*, sprint: str, goal_text: str, ready_limit: int) -> tuple[str, str]:
    schema = (
        "{\n"
        f'  \"sprint\": \"{sprint}\",\n'
        '  \"goal_issue\": {\n'
        f'    \"title\": \"[SPRINT GOAL] {sprint}: <short>\",\n'
        "    \"body_markdown\": \"<markdown>\",\n"
        "    \"labels\": [\"meta:sprint-goal\"],\n"
        f'    \"fields\": {{\"Sprint\":\"{sprint}\",\"Status\":\"Backlog\",\"Priority\":\"P0\",\"Size\":\"S\",\"Area\":\"docs\"}}\n'
        "  },\n"
        "  \"tasks\": [\n"
        "    {\n"
        "      \"title\": \"[TASK] <short>\",\n"
        "      \"body_markdown\": \"<markdown>\",\n"
        "      \"priority\": \"P0|P1|P2\",\n"
        "      \"size\": \"S|M|L\",\n"
        "      \"area\": \"infra|api|orchestrator|runner|docs|tests\",\n"
        "      \"depends_on_titles\": [\"[TASK] ...\"],\n"
        "      \"initial_status\": \"Backlog\"\n"
        "    }\n"
        "  ],\n"
        "  \"ready_set_titles\": [\"[TASK] ...\"],\n"
        "  \"prioritization_rationale\": \"...\"\n"
        "}\n"
    )

    markdown_requirements = (
        "For every body_markdown (goal + tasks), you MUST use this exact section structure with these exact headings:\n"
        "## Goal\n"
        "<one or more lines>\n"
        "## Non-goals\n"
        "- <bullet>\n"
        "## Acceptance Criteria\n"
        "- [ ] <checkbox item>\n"
        "## Files Likely Touched\n"
        "- <path>\n"
        "## Definition of Done\n"
        "- [ ] <checkbox item>\n"
    )

    prompt = (
        "You are ORCHESTRATOR (kickoff-only). Your output is a machine-validated JSON plan.\n"
        "Return JSON only. No prose. No markdown code fences.\n"
        "Do not use auto-close keywords (Closes/Fixes/Resolves #N).\n\n"
        f"Sprint: {sprint}\n"
        f"Ready limit: {ready_limit} (ready_set_titles length must be <= {ready_limit} and <= 3)\n\n"
        "Goal text (verbatim):\n"
        f"{goal_text.strip()}\n\n"
        "Hard constraints:\n"
        "- tasks length must be between 3 and 25\n"
        "- Every task must set initial_status=Backlog\n"
        "- depends_on_titles must reference exact task titles (including [TASK] prefix)\n"
        "- ready_set_titles must reference existing tasks with zero dependencies and priority=P0 only\n"
        "- goal_issue.labels must include meta:sprint-goal\n"
        "- goal_issue.fields must be exactly: Sprint=sprint, Status=Backlog, Priority=P0, Size=S, Area=docs\n\n"
        f"Output schema (exact keys):\n{schema}\n"
        f"\n{markdown_requirements}\n"
        "Notes:\n"
        "- Task count should be intelligently sized for the goal (within bounds).\n"
        "- Prefer dependency-light P0 tasks in ready_set_titles.\n"
    )

    developer_instructions = (
        "Return JSON only (single object) matching the provided schema exactly. "
        "Do not include any additional keys. "
        "No prose, no markdown, no code fences. "
        "Do not use auto-close keywords. "
        "Ensure body_markdown uses the required headings and list formats."
    )

    return prompt, developer_instructions


def _read_goal_text(*, goal: Optional[str], goal_file: Optional[str]) -> str:
    if goal_file:
        raw = Path(goal_file).read_text(encoding="utf8")
        if not raw.strip():
            raise KickoffError("goal file is empty", code="kickoff_goal_missing", details={"path": goal_file})
        return raw.strip()
    if goal is not None:
        if not goal.strip():
            raise KickoffError("--goal must be non-empty", code="kickoff_goal_missing")
        return goal.strip()
    raise KickoffError("kickoff requires --goal or --goal-file", code="kickoff_goal_missing")


def _apply_kickoff_plan(
    *,
    backend: BackendClient,
    plan: Dict[str, Any],
    draft: Dict[str, Any],
    dry_run: bool,
    sprint_plan_path: str,
) -> Dict[str, Any]:
    ready_titles: list[str] = list(plan.get("ready_set_titles") or [])

    if dry_run:
        _log_stderr({"type": "KICKOFF_DRY_RUN", "ready_set_titles": ready_titles})
        return {"status": "DRY_RUN", "ready_set_titles": ready_titles}

    apply_payload = backend.post_json("/internal/plan-apply", body={"role": "ORCHESTRATOR", "draft": draft})
    if apply_payload.get("status") != "APPLIED":
        raise KickoffError("plan-apply did not return APPLIED", code="kickoff_plan_apply_failed", details={"payload": apply_payload})

    created = apply_payload.get("created")
    if not isinstance(created, list) or len(created) != len(draft.get("issues") or []):
        raise KickoffError(
            "plan-apply response created list mismatch",
            code="kickoff_plan_apply_failed",
            details={"created_count": len(created) if isinstance(created, list) else None},
        )

    title_to_project_item_id: Dict[str, str] = {}
    issues = list(draft.get("issues") or [])
    for idx, issue in enumerate(issues):
        title = issue.get("title")
        if not isinstance(title, str) or not title.strip():
            raise KickoffError("draft issue missing title", code="kickoff_invalid_draft")
        if title in title_to_project_item_id:
            raise KickoffError("title collision exists in draft issues", code="kickoff_title_collision", details={"title": title})

        created_entry = created[idx] if idx < len(created) else None
        project_item_id = created_entry.get("project_item_id") if isinstance(created_entry, dict) else None
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            raise KickoffError("plan-apply response missing project_item_id", code="kickoff_plan_apply_failed", details={"index": idx})
        title_to_project_item_id[title] = project_item_id

    # Persist a local sprint plan cache (dependencies + created ids) so runner can
    # deterministically auto-promote dependency-free tasks as earlier tasks reach In Review.
    tasks_plan: list[Dict[str, Any]] = []
    tasks_by_title = {t.get("title"): t for t in (plan.get("tasks") or []) if isinstance(t, dict)}
    for idx, issue in enumerate(issues):
        if idx == 0:
            continue  # goal issue; never auto-promote
        title = issue.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        task_src = tasks_by_title.get(title)
        if not isinstance(task_src, dict):
            raise KickoffError("plan cache missing task metadata", code="kickoff_plan_cache_failed", details={"title": title})
        created_entry = created[idx] if idx < len(created) else None
        issue_number = created_entry.get("issue_number") if isinstance(created_entry, dict) else None
        project_item_id = created_entry.get("project_item_id") if isinstance(created_entry, dict) else None
        if not isinstance(issue_number, int) or issue_number <= 0:
            raise KickoffError("plan cache missing issue_number", code="kickoff_plan_cache_failed", details={"title": title})
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            raise KickoffError("plan cache missing project_item_id", code="kickoff_plan_cache_failed", details={"title": title})
        tasks_plan.append(
            {
                "title": title,
                "issue_number": issue_number,
                "project_item_id": project_item_id,
                "priority": task_src.get("priority"),
                "depends_on_titles": task_src.get("depends_on_titles") or [],
            }
        )

    plan_cache = {
        "version": 1,
        "sprint": draft.get("sprint"),
        "generated_at": _utc_now_iso(),
        "goal": {
            "title": issues[0].get("title") if issues else None,
            "issue_number": created[0].get("issue_number") if isinstance(created[0], dict) else None,
            "project_item_id": created[0].get("project_item_id") if isinstance(created[0], dict) else None,
        },
        "tasks": tasks_plan,
        "ready_set_titles": ready_titles,
    }
    _atomic_write_json(sprint_plan_path, plan_cache)
    _log_stderr({"type": "SPRINT_PLAN_SAVED", "path": sprint_plan_path, "sprint": plan_cache.get("sprint")})

    promoted: List[Dict[str, Any]] = []
    for title in ready_titles:
        project_item_id = title_to_project_item_id.get(title)
        if not project_item_id:
            raise KickoffError(
                "ready_set task not found in plan-apply results",
                code="kickoff_ready_set_missing_mapping",
                details={"title": title},
            )

        update_payload = backend.post_json(
            "/internal/project-item/update-field",
            body={"role": "ORCHESTRATOR", "project_item_id": project_item_id, "field": "Status", "value": "Ready"},
        )
        promoted.append({"title": title, "project_item_id": project_item_id, "update_payload": update_payload})

    return {"status": "APPLIED", "plan_apply": apply_payload, "promoted": promoted}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="runner")
    parser.add_argument("--dry-run", action="store_true", help="do not call backend write endpoints or execute worker intents")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="run orchestrator once and exit")
    mode.add_argument("--loop", action="store_true", help="run orchestrator loop (default for non-kickoff)")
    parser.add_argument("--kickoff", action="store_true", help="generate and apply a sprint plan before running orchestrator")
    parser.add_argument("--sprint", type=str, help="sprint value M1..M4 (overrides ORCHESTRATOR_SPRINT)")
    goal_group = parser.add_mutually_exclusive_group()
    goal_group.add_argument("--goal", type=str, help="kickoff goal text")
    goal_group.add_argument("--goal-file", type=str, help="path to kickoff goal text file")
    parser.add_argument("--ready-limit", type=int, default=3, help="max dependency-free tasks to auto-promote to Ready (max 3)")
    args = parser.parse_args(argv)

    if (args.goal is not None or args.goal_file is not None) and not args.kickoff:
        _log_stderr({"type": "CONFIG_ERROR", "error": "--goal/--goal-file requires --kickoff"})
        return 2

    if args.kickoff and args.goal is None and args.goal_file is None:
        _log_stderr({"type": "CONFIG_ERROR", "error": "--kickoff requires --goal or --goal-file"})
        return 2

    sprint_override = args.sprint.strip() if isinstance(args.sprint, str) else None
    try:
        config = load_config(
            dry_run_flag=args.dry_run,
            once_flag=args.once,
            orchestrator_sprint_override=sprint_override,
        )
    except ValueError as exc:
        _log_stderr({"type": "CONFIG_ERROR", "error": str(exc)})
        return 2

    backend = BackendClient(base_url=config.backend_base_url, timeout_s=config.backend_timeout_s)

    # Preflight gate.
    try:
        preflight = backend.preflight_orchestrator()
    except HttpError as exc:
        classification = classify_failure(exc)
        _log_stderr(
            {
                "type": classification,
                "reason": "backend_preflight_failed",
                "error": str(exc),
                "code": exc.code,
                "status_code": exc.status_code,
                "payload": exc.payload,
            }
        )
        return exit_code_for_classification(classification)

    if preflight.get("status") != "PASS":
        _log_stderr({"type": "HARD_STOP", "reason": "preflight_fail", "payload": preflight})
        return 2

    if args.kickoff:
        try:
            sprint = config.orchestrator_sprint
            goal_text = _read_goal_text(goal=args.goal, goal_file=args.goal_file)
            ready_limit = int(args.ready_limit)
            bundle = backend.get_agent_context("ORCHESTRATOR")
            prompt, developer_instructions = _build_kickoff_prompt(
                sprint=sprint,
                goal_text=goal_text,
                ready_limit=ready_limit,
            )
            kickoff_raw = generate_json_with_codex_mcp(
                codex_bin=config.codex_bin,
                codex_mcp_args=config.codex_mcp_args,
                role_bundle=bundle,
                prompt=prompt,
                developer_instructions=developer_instructions,
                sandbox="read-only",
                approval_policy="never",
                tools_call_timeout_s=config.codex_tools_call_timeout_s,
            )
            kickoff_plan = validate_kickoff_plan(kickoff_raw, sprint=sprint, ready_limit=ready_limit)
            draft = kickoff_plan_to_plan_apply_draft(kickoff_plan)
            _log_stderr({"type": "KICKOFF_PLAN", "plan": kickoff_plan})
            _log_stderr({"type": "KICKOFF_DRAFT", "draft": draft})

            try:
                apply_result = _apply_kickoff_plan(
                    backend=backend,
                    plan=kickoff_plan,
                    draft=draft,
                    dry_run=config.dry_run,
                    sprint_plan_path=config.sprint_plan_path,
                )
            except HttpError as exc:
                # Treat any kickoff write failure as hard stop (including 409 preflight/policy failures).
                raise KickoffError(
                    "kickoff backend request failed",
                    code="kickoff_backend_error",
                    details={"code": exc.code, "status_code": exc.status_code, "payload": exc.payload},
                ) from None
            _log_stderr({"type": "KICKOFF_RESULT", **apply_result})
        except (KickoffError, CodexWorkerError) as exc:
            _log_stderr({"type": "HARD_STOP", "reason": "kickoff_failed", "code": getattr(exc, "code", "kickoff_failed"), "details": getattr(exc, "details", {}), "error": str(exc)})
            return 2

        # In kickoff mode, we only run the scheduler if explicitly requested.
        if not (args.once or args.loop):
            return 0

    if not config.dry_run:
        try:
            _assert_codex_github_mcp_available(codex_bin=config.codex_bin)
        except CodexWorkerError as exc:
            _log_stderr({"type": "HARD_STOP", "reason": "codex_mcp_missing", "code": exc.code, "details": exc.details})
            return 2

    ledger: Optional[RunLedger] = None
    if not config.dry_run:
        ledger = RunLedger(config.ledger_path)

    runner = Runner(
        backend=backend,
        ledger=ledger,
        dry_run=config.dry_run,
        codex_bin=config.codex_bin,
        codex_mcp_args=config.codex_mcp_args,
        codex_tools_call_timeout_s=config.codex_tools_call_timeout_s,
        orchestrator_state_path=config.orchestrator_state_path,
    )

    # Spawn worker threads.
    workers: list[threading.Thread] = []
    for _ in range(config.runner_max_executors):
        thread = threading.Thread(target=runner.run_worker_loop, kwargs={"role": "EXECUTOR"}, daemon=True)
        thread.start()
        workers.append(thread)
    for _ in range(config.runner_max_reviewers):
        thread = threading.Thread(target=runner.run_worker_loop, kwargs={"role": "REVIEWER"}, daemon=True)
        thread.start()
        workers.append(thread)

    # Spawn orchestrator process. Runner passes through required sprint + backend url.
    orchestrator_env = dict(os.environ)
    orchestrator_env["ORCHESTRATOR_SPRINT"] = config.orchestrator_sprint
    orchestrator_env["ORCHESTRATOR_BACKEND_BASE_URL"] = config.backend_base_url
    orchestrator_env["ORCHESTRATOR_STATE_PATH"] = config.orchestrator_state_path
    # By default, keep orchestrator emission aligned with runner concurrency.
    orchestrator_env.setdefault("ORCHESTRATOR_MAX_EXECUTORS", str(config.runner_max_executors))
    orchestrator_env.setdefault("ORCHESTRATOR_MAX_REVIEWERS", str(config.runner_max_reviewers))
    # Allow bounded reviewer retries without manual state-file resets.
    orchestrator_env["ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS"] = os.environ.get(
        "ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS",
        "3",
    )
    orchestrator_env["ORCHESTRATOR_REVIEWER_RETRY_POLLS"] = os.environ.get(
        "ORCHESTRATOR_REVIEWER_RETRY_POLLS",
        "10",
    )
    if config.once:
        if "--loop" in config.orchestrator_cmd:
            orchestrator_cmd = config.orchestrator_cmd.replace("--loop", "--once")
        elif "--once" in config.orchestrator_cmd:
            orchestrator_cmd = config.orchestrator_cmd
        else:
            orchestrator_cmd = f"{config.orchestrator_cmd} --once"
    else:
        orchestrator_cmd = config.orchestrator_cmd

    sprint_plan: Optional[Dict[str, Any]] = None
    if config.autopromote:
        try:
            sprint_plan = _load_json_file(config.sprint_plan_path)
            if sprint_plan and sprint_plan.get("sprint") != config.orchestrator_sprint:
                sprint_plan = None
        except Exception as exc:
            _log_stderr({"type": "HARD_STOP", "reason": "sprint_plan_invalid", "error": str(exc), "path": config.sprint_plan_path})
            return 2

    proc = _spawn_orchestrator(orchestrator_cmd, env=orchestrator_env)
    assert proc.stdout is not None
    assert proc.stderr is not None

    _log_stderr(
        {
            "type": "RUNNER_STARTED",
            "dry_run": config.dry_run,
            "orchestrator_cmd": orchestrator_cmd,
            "ready_buffer": config.runner_ready_buffer,
            "autopromote": config.autopromote,
            "reviewer_retry": {
                "max_dispatches_per_status": orchestrator_env["ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS"],
                "retry_polls": orchestrator_env["ORCHESTRATOR_REVIEWER_RETRY_POLLS"],
            },
        }
    )

    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, data="stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, data="stderr")

    # Read intents from orchestrator stdout JSONL and summaries from stderr JSONL.
    try:
        while True:
            if runner.should_stop():
                break
            if proc.poll() is not None:
                break

            for key, _ in selector.select(timeout=0.2):
                stream = key.fileobj
                channel = key.data
                line = stream.readline()
                if line == "":
                    continue
                stripped = line.strip()
                if not stripped:
                    continue

                if channel == "stderr":
                    sys.stderr.write(line)
                    sys.stderr.flush()

                    if not config.autopromote:
                        continue
                    try:
                        payload = parse_json_line(stripped)
                    except IntentError:
                        continue
                    if payload.get("type") == "DISPATCH_SUMMARY":
                        _maybe_autopromote_ready(
                            summary=payload,
                            sprint_plan=sprint_plan,
                            backend=backend,
                            dry_run=config.dry_run,
                            ready_target=config.runner_ready_buffer,
                        )
                    continue

                try:
                    value = parse_json_line(stripped)
                    intent = parse_intent(value)
                except IntentError as exc:
                    runner.hard_stop(f"intent_error: {exc.code}: {exc}")
                    break

                _log_stderr(
                    {
                        "type": "INTENT_RECEIVED",
                        "role": intent.role,
                        "run_id": intent.run_id,
                        "endpoint": intent.endpoint,
                        "intent_hash": intent.intent_hash,
                    }
                )

                if ledger and ledger.get(intent.run_id) and ledger.get(intent.run_id).get("status") == "succeeded":
                    _log_stderr({"type": "LEDGER_SKIP", "run_id": intent.run_id, "reason": "already_succeeded"})
                    continue

                if ledger:
                    ledger.upsert(
                        LedgerEntry(
                            run_id=intent.run_id,
                            role=intent.role,
                            intent_hash=intent.intent_hash,
                            received_at=_utc_now_iso(),
                            status="queued",
                            result=None,
                        )
                    )

                runner.enqueue(intent)
    finally:
        try:
            selector.close()
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass

    if runner.should_stop():
        _log_stderr({"type": "HARD_STOP", "reason": runner.stop_reason()})
        return 2

    rc = proc.wait(timeout=5)
    if rc != 0:
        _log_stderr({"type": "HARD_STOP", "reason": "orchestrator_nonzero_exit", "exit_code": rc})
        return rc if rc in (2, 3, 4) else 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
