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


def _normalize_iso(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _minutes_since(start_iso: Any, *, now_iso: str) -> int:
    start_normalized = _normalize_iso(start_iso)
    now_normalized = _normalize_iso(now_iso)
    if not start_normalized or not now_normalized:
        return 0
    start_dt = datetime.fromisoformat(start_normalized.replace("Z", "+00:00"))
    now_dt = datetime.fromisoformat(now_normalized.replace("Z", "+00:00"))
    delta = now_dt - start_dt
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds() // 60)


def _seconds_since(start_iso: Any, *, now_iso: str) -> int:
    start_normalized = _normalize_iso(start_iso)
    now_normalized = _normalize_iso(now_iso)
    if not start_normalized or not now_normalized:
        return 0
    start_dt = datetime.fromisoformat(start_normalized.replace("Z", "+00:00"))
    now_dt = datetime.fromisoformat(now_normalized.replace("Z", "+00:00"))
    delta = now_dt - start_dt
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds())


def _is_after_iso(left_iso: Any, right_iso: Any) -> bool:
    left_normalized = _normalize_iso(left_iso)
    right_normalized = _normalize_iso(right_iso)
    if not left_normalized or not right_normalized:
        return False
    left_dt = datetime.fromisoformat(left_normalized.replace("Z", "+00:00"))
    right_dt = datetime.fromisoformat(right_normalized.replace("Z", "+00:00"))
    return left_dt > right_dt


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


def is_retryable_failure(*, failure_classification: str, error_code: str) -> bool:
    normalized_class = str(failure_classification or "").strip().upper()
    normalized_code = str(error_code or "").strip()
    if normalized_class == "TRANSIENT":
        return True
    return normalized_code in {
        "mcp_timeout",
        "backend_unreachable",
        "mcp_stdio_unavailable",
        "mcp_error_response",
    }


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


def isNonEmptyString(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


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
        review_stall_polls: int,
        blocked_retry_minutes: int,
        watchdog_timeout_s: int,
    ):
        self._backend = backend
        self._ledger = ledger
        self._dry_run = dry_run
        self._codex_bin = codex_bin
        self._codex_mcp_args = codex_mcp_args
        self._codex_tools_call_timeout_s = codex_tools_call_timeout_s
        self._orchestrator_state_path = orchestrator_state_path
        self._review_stall_polls = review_stall_polls
        self._blocked_retry_minutes = blocked_retry_minutes
        self._watchdog_timeout_s = watchdog_timeout_s

        self._executor_queue: "queue.Queue[RunIntent]" = queue.Queue()
        self._reviewer_queue: "queue.Queue[RunIntent]" = queue.Queue()

        self._hard_stop_event = threading.Event()
        self._hard_stop_reason: Optional[str] = None

    def _read_orchestrator_state(self) -> Dict[str, Any]:
        try:
            state = _load_json_file(self._orchestrator_state_path)
        except Exception:
            return {"poll_count": 0, "items": {}}
        if not isinstance(state, dict):
            return {"poll_count": 0, "items": {}}
        items = state.get("items")
        if not isinstance(items, dict):
            items = {}
        return {
            "poll_count": state.get("poll_count") if isinstance(state.get("poll_count"), int) else 0,
            "items": items,
        }

    def _resolve_project_state_item(self, project_item_id: str) -> Optional[Dict[str, Any]]:
        state = self._read_orchestrator_state()
        items = state.get("items")
        if not isinstance(items, dict):
            return None
        entry = items.get(project_item_id)
        if not isinstance(entry, dict):
            return None
        return entry

    def _resolve_project_item_id_for_issue(self, issue_number: int) -> Optional[str]:
        state = self._read_orchestrator_state()
        items = state.get("items")
        if not isinstance(items, dict):
            return None
        matches = []
        for project_item_id, entry in items.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("last_seen_issue_number") == issue_number:
                matches.append(project_item_id)
        if len(matches) != 1:
            return None
        return matches[0]

    def _update_orchestrator_state_item(self, project_item_id: str, updates: Dict[str, Any]) -> None:
        state = self._read_orchestrator_state()
        items = state.get("items")
        if not isinstance(items, dict):
            return
        existing = items.get(project_item_id)
        if not isinstance(existing, dict):
            return
        merged = {**existing, **updates}
        items[project_item_id] = merged
        state["items"] = items
        _atomic_write_json(self._orchestrator_state_path, state)

    def _record_reviewer_outcome_state(self, *, issue_number: int, outcome: str, recorded_at: str) -> None:
        project_item_id = self._resolve_project_item_id_for_issue(issue_number)
        if not project_item_id:
            return
        state_item = self._resolve_project_state_item(project_item_id) or {}
        review_cycle_count = state_item.get("review_cycle_count")
        next_cycle_count = review_cycle_count if isinstance(review_cycle_count, int) and review_cycle_count >= 0 else 0
        if outcome in ("FAIL", "INCOMPLETE"):
            next_cycle_count += 1
        self._update_orchestrator_state_item(
            project_item_id,
            {
                "last_reviewer_outcome": outcome,
                "last_reviewer_feedback_at": recorded_at,
                "review_cycle_count": next_cycle_count,
            },
        )

    def _record_executor_response_state(self, *, run_id: str, recorded_at: str) -> None:
        context = self._resolve_run_context(run_id)
        if not context:
            return
        _issue_number, project_item_id, status = context
        if status != "In Review":
            return
        self._update_orchestrator_state_item(
            project_item_id,
            {
                "last_executor_response_at": recorded_at,
            },
        )

    def _resolve_reviewer_pr_linkage(self, *, issue_number: int) -> Dict[str, Any]:
        payload = self._backend.post_json(
            "/internal/reviewer/resolve-linked-pr",
            body={
                "role": "REVIEWER",
                "issue_number": issue_number,
            },
        )
        return payload

    def _transition_reviewer_pass_to_needs_human_approval(
        self,
        *,
        run_id: str,
        issue_number: int,
        project_item_id: str,
        pr_url: str,
        reason: str,
    ) -> Dict[str, Any]:
        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Needs Human Approval",
            "issue_number": issue_number,
            "pr_url": pr_url,
            "checks_performed": [
                "Canonical PR linkage resolved via backend",
                "Reviewer run completed with deterministic outcome",
            ],
            "checks_passed": [
                "No unresolved blocking findings remain",
                "Item is ready for human merge decision",
            ],
            "human_steps": [
                reason,
                "Review linked PR, merge if acceptable, and move item to Done after validation.",
            ],
            "run_id": run_id,
        }
        return self._backend.post_json("/internal/project-item/update-field", body=body)

    def _retry_blocked_item_to_ready(
        self,
        *,
        issue_number: int,
        project_item_id: str,
        run_id: str,
        blocked_minutes: int,
        failure_classification: str,
        error_code: str,
    ) -> Dict[str, Any]:
        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Ready",
            "issue_number": issue_number,
            "retry_reason": "automatic_retry_after_cooldown",
            "failure_classification": failure_classification,
            "failure_error_code": error_code,
            "blocked_minutes": blocked_minutes,
            "run_id": run_id,
            "suggested_next_steps": [
                "Re-run executor for this item.",
                "If failure repeats, inspect logs and keep item Blocked for human triage.",
            ],
        }
        return self._backend.post_json("/internal/project-item/update-field", body=body)

    def _transition_review_cycle_exceeded_to_blocked(
        self,
        *,
        issue_number: int,
        project_item_id: str,
        run_id: str,
        review_cycle_count: int,
    ) -> Dict[str, Any]:
        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Blocked",
            "issue_number": issue_number,
            "failure_classification": "ITEM_STOP",
            "failure_message": "Exceeded review iterations; needs human intervention.",
            "suggested_next_steps": [
                "Human triage required to unblock review loop.",
                "Decide whether to merge, split scope, or adjust acceptance criteria.",
            ],
            "run_id": run_id,
            "review_cycle_count": review_cycle_count,
        }
        return self._backend.post_json("/internal/project-item/update-field", body=body)

    def _handle_review_stall(self, *, summary: Dict[str, Any]) -> None:
        needs_attention = summary.get("needs_attention")
        if not isinstance(needs_attention, dict):
            return
        churn_entries = needs_attention.get("in_review_churn")
        if not isinstance(churn_entries, list):
            return

        for entry in churn_entries:
            if not isinstance(entry, dict):
                continue
            issue_number = entry.get("issue_number")
            project_item_id = entry.get("project_item_id")
            in_review_polls = entry.get("in_review_polls")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            if not isinstance(in_review_polls, int):
                continue
            if in_review_polls <= self._review_stall_polls:
                continue

            _log_stderr(
                {
                    "type": "REVIEW_STALL_DETECTED",
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "in_review_polls": in_review_polls,
                    "threshold": self._review_stall_polls,
                }
            )

            state_item = self._resolve_project_state_item(project_item_id)
            if isinstance(state_item, dict):
                reviewer_feedback_at = state_item.get("last_reviewer_feedback_at")
                executor_response_at = state_item.get("last_executor_response_at")
                if _is_after_iso(executor_response_at, reviewer_feedback_at):
                    continue
            reviewer_dispatches = 0
            if isinstance(state_item, dict):
                dispatches_value = state_item.get("reviewer_dispatches_for_current_status")
                if isinstance(dispatches_value, int):
                    reviewer_dispatches = dispatches_value

            # Escalate only after the bounded second reviewer attempt has already happened.
            if reviewer_dispatches < 2:
                continue

            try:
                linkage = self._resolve_reviewer_pr_linkage(issue_number=issue_number)
                pr_url = linkage.get("pr_url")
                if not isinstance(pr_url, str) or not pr_url.strip():
                    raise HttpError("review linkage missing pr_url", code="backend_invalid_payload", payload=linkage)
                linkage_project_item_id = linkage.get("project_item_id")
                if linkage_project_item_id != project_item_id:
                    raise HttpError(
                        "review linkage project_item_id mismatch",
                        code="backend_invalid_payload",
                        payload={
                            "expected_project_item_id": project_item_id,
                            "actual_project_item_id": linkage_project_item_id,
                        },
                    )

                payload = self._transition_reviewer_pass_to_needs_human_approval(
                    run_id=str(entry.get("last_run_id") or ""),
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    pr_url=pr_url.strip(),
                    reason=(
                        "Escalated by orchestrator after repeated In Review stall; "
                        "manual decision required."
                    ),
                )
                _log_stderr(
                    {
                        "type": "REVIEW_STALL_ESCALATED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "in_review_polls": in_review_polls,
                        "backend_payload": payload,
                    }
                )
            except Exception as exc:
                _log_stderr(
                    {
                        "type": "REVIEW_STALL_ESCALATED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "in_review_polls": in_review_polls,
                        "error": str(exc),
                        "status": "failed",
                    }
                )

    def _handle_blocked_retries(self, *, summary: Dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return

        now_iso = _utc_now_iso()
        for item in processed_items:
            if not isinstance(item, dict):
                continue
            if item.get("status") != "Blocked":
                continue
            issue_number = item.get("issue_number")
            project_item_id = item.get("project_item_id")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue

            state_item = self._resolve_project_state_item(project_item_id)
            if not isinstance(state_item, dict):
                continue
            blocked_minutes = _minutes_since(state_item.get("status_since_at"), now_iso=now_iso)
            if blocked_minutes < self._blocked_retry_minutes:
                continue

            run_id = str(state_item.get("last_run_id") or "")
            if not run_id or not self._ledger:
                continue
            ledger_entry = self._ledger.get(run_id)
            if not isinstance(ledger_entry, dict):
                continue
            result = ledger_entry.get("result")
            if not isinstance(result, dict):
                continue
            failure_classification = str(result.get("failure_classification") or "")
            error_code = str(result.get("error_code") or "")
            if not is_retryable_failure(
                failure_classification=failure_classification,
                error_code=error_code,
            ):
                continue

            try:
                payload = self._retry_blocked_item_to_ready(
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    run_id=run_id,
                    blocked_minutes=blocked_minutes,
                    failure_classification=failure_classification,
                    error_code=error_code,
                )
                _log_stderr(
                    {
                        "type": "BLOCKED_RETRY",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "blocked_minutes": blocked_minutes,
                        "failure_classification": failure_classification,
                        "error_code": error_code,
                        "backend_payload": payload,
                    }
                )
            except Exception as exc:
                _log_stderr(
                    {
                        "type": "BLOCKED_RETRY",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "blocked_minutes": blocked_minutes,
                        "failure_classification": failure_classification,
                        "error_code": error_code,
                        "status": "failed",
                        "error": str(exc),
                    }
                )

    def _handle_in_review_cycle_caps(self, *, summary: Dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return

        for item in processed_items:
            if not isinstance(item, dict):
                continue
            if item.get("status") != "In Review":
                continue
            issue_number = item.get("issue_number")
            project_item_id = item.get("project_item_id")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            state_item = self._resolve_project_state_item(project_item_id)
            if not isinstance(state_item, dict):
                continue
            review_cycle_count = state_item.get("review_cycle_count")
            if not isinstance(review_cycle_count, int) or review_cycle_count < 5:
                continue
            run_id = str(state_item.get("last_run_id") or "")
            try:
                payload = self._transition_review_cycle_exceeded_to_blocked(
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    run_id=run_id,
                    review_cycle_count=review_cycle_count,
                )
                _log_stderr(
                    {
                        "type": "REVIEW_CYCLE_CAP_BLOCKED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "review_cycle_count": review_cycle_count,
                        "backend_payload": payload,
                    }
                )
            except Exception as exc:
                _log_stderr(
                    {
                        "type": "REVIEW_CYCLE_CAP_BLOCKED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "review_cycle_count": review_cycle_count,
                        "status": "failed",
                        "error": str(exc),
                    }
                )

    def _handle_running_watchdog(self, *, summary: Dict[str, Any]) -> None:
        if not self._ledger:
            return
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return
        now_iso = _utc_now_iso()

        for item in processed_items:
            if not isinstance(item, dict):
                continue
            if item.get("status") != "In Progress":
                continue
            issue_number = item.get("issue_number")
            project_item_id = item.get("project_item_id")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            state_item = self._resolve_project_state_item(project_item_id)
            if not isinstance(state_item, dict):
                continue
            run_id = str(state_item.get("last_run_id") or "")
            if not run_id:
                continue
            ledger_entry = self._ledger.get(run_id)
            if not isinstance(ledger_entry, dict) or ledger_entry.get("status") != "running":
                continue
            started_at = ledger_entry.get("running_at") or ledger_entry.get("received_at")
            elapsed_seconds = _seconds_since(started_at, now_iso=now_iso)
            if elapsed_seconds <= self._watchdog_timeout_s:
                continue

            message = f"Worker exceeded watchdog timeout ({self._watchdog_timeout_s}s)."
            self._ledger.mark_result(
                run_id,
                status="failed",
                result={
                    "status": "failed",
                    "summary": message,
                    "urls": {},
                    "errors": [{"code": "watchdog_timeout", "message": message}],
                    "failure_classification": "HARD_STOP",
                    "error_code": "watchdog_timeout",
                },
            )
            _log_stderr(
                {
                    "type": "WORKER_WATCHDOG_TIMEOUT",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "elapsed_s": elapsed_seconds,
                    "timeout_s": self._watchdog_timeout_s,
                }
            )
            self._transition_executor_failure_to_blocked(
                run_id=run_id,
                failure_classification="HARD_STOP",
                failure_message=message,
            )

    def handle_dispatch_summary(self, *, summary: Dict[str, Any]) -> None:
        self._handle_review_stall(summary=summary)
        self._handle_blocked_retries(summary=summary)
        self._handle_in_review_cycle_caps(summary=summary)
        self._handle_running_watchdog(summary=summary)

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
            error_code = exc.code if isinstance(exc, (CodexWorkerError, HttpError, IntentError)) else "unknown_error"
            _log_stderr(
                {
                    "type": "WORKER_FAILED",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "elapsed_s": int(time.time() - started_at),
                    "classification": failure_classification,
                    "error_code": error_code,
                    "error": str(exc),
                }
            )
            if intent.role == "REVIEWER":
                _log_stderr(
                    {
                        "type": "REVIEW_OUTCOME",
                        "role": "REVIEWER",
                        "run_id": intent.run_id,
                        "outcome": "INCOMPLETE",
                        "source": "worker_exception",
                    }
                )
                issue_number = intent.body.get("issue_number")
                if isinstance(issue_number, int) and issue_number > 0:
                    self._record_reviewer_outcome_state(
                        issue_number=issue_number,
                        outcome="INCOMPLETE",
                        recorded_at=_utc_now_iso(),
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
                    result={
                        "status": "failed",
                        "summary": str(exc),
                        "urls": {},
                        "errors": [{"error": str(exc), "code": error_code}],
                        "failure_classification": failure_classification,
                        "error_code": error_code,
                        "reviewer_outcome": "INCOMPLETE" if intent.role == "REVIEWER" else None,
                        "last_reviewer_feedback_at": _utc_now_iso() if intent.role == "REVIEWER" else None,
                        "last_executor_response_at": None,
                    },
                )
            raise

        heartbeat_stop.set()
        reviewer_outcome = result.outcome if intent.role == "REVIEWER" else None
        completed_at = _utc_now_iso()
        review_cycle_count_for_result: Optional[int] = None
        try:
            if intent.role == "REVIEWER":
                if reviewer_outcome not in ("PASS", "FAIL", "INCOMPLETE"):
                    raise CodexWorkerError(
                        "reviewer outcome is required",
                        code="worker_invalid_output",
                        details={"outcome": reviewer_outcome},
                    )
                _log_stderr(
                    {
                        "type": "REVIEW_OUTCOME",
                        "role": "REVIEWER",
                        "run_id": intent.run_id,
                        "outcome": reviewer_outcome,
                        "status": result.status,
                    }
                )
                issue_number = intent.body.get("issue_number")
                if isinstance(issue_number, int) and issue_number > 0:
                    self._record_reviewer_outcome_state(
                        issue_number=issue_number,
                        outcome=reviewer_outcome,
                        recorded_at=completed_at,
                    )
                    project_item_id = self._resolve_project_item_id_for_issue(issue_number)
                    if project_item_id:
                        state_item = self._resolve_project_state_item(project_item_id)
                        if isinstance(state_item, dict) and isinstance(state_item.get("review_cycle_count"), int):
                            review_cycle_count_for_result = state_item.get("review_cycle_count")
                if reviewer_outcome == "PASS":
                    if not isinstance(issue_number, int) or issue_number <= 0:
                        raise HttpError(
                            "reviewer pass requires issue_number in intent body",
                            code="backend_invalid_payload",
                            payload=intent.body,
                        )
                    linkage = self._resolve_reviewer_pr_linkage(issue_number=issue_number)
                    pr_url = linkage.get("pr_url")
                    project_item_id = linkage.get("project_item_id")
                    if not isinstance(pr_url, str) or not pr_url.strip():
                        raise HttpError("review linkage missing pr_url", code="backend_invalid_payload", payload=linkage)
                    if not isinstance(project_item_id, str) or not project_item_id.strip():
                        raise HttpError("review linkage missing project_item_id", code="backend_invalid_payload", payload=linkage)
                    self._transition_reviewer_pass_to_needs_human_approval(
                        run_id=intent.run_id,
                        issue_number=issue_number,
                        project_item_id=project_item_id.strip(),
                        pr_url=pr_url.strip(),
                        reason="Reviewer PASS outcome reached; awaiting human approval.",
                    )
            if intent.role == "EXECUTOR" and result.status == "succeeded":
                if isinstance(result.urls, dict) and isNonEmptyString(result.urls.get("pr_url")):
                    if result.marker_verified is not True:
                        raise CodexWorkerError(
                            "executor must verify canonical PR marker/linkage for PR runs",
                            code="worker_invalid_output",
                            details={"run_id": intent.run_id},
                        )
                self._record_executor_response_state(
                    run_id=intent.run_id,
                    recorded_at=completed_at,
                )
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
                first_error = result.errors[0] if isinstance(result.errors, list) and len(result.errors) > 0 else {}
                error_code = first_error.get("code") if isinstance(first_error, dict) else ""
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
                        "reviewer_outcome": reviewer_outcome,
                        "last_reviewer_feedback_at": completed_at if intent.role == "REVIEWER" else None,
                        "last_executor_response_at": completed_at if intent.role == "EXECUTOR" else None,
                        "review_cycle_count": review_cycle_count_for_result if intent.role == "REVIEWER" else None,
                        "failure_classification": "ITEM_STOP" if result.status != "succeeded" else "",
                        "error_code": str(error_code or ""),
                    },
                )
            if intent.role == "EXECUTOR" and result.status != "succeeded":
                self._transition_executor_failure_to_blocked(
                    run_id=intent.run_id,
                    failure_classification="ITEM_STOP",
                    failure_message=result.summary,
                )
        except Exception as exc:
            failure_classification = classify_failure(exc)
            error_code = exc.code if isinstance(exc, (CodexWorkerError, HttpError, IntentError)) else "unknown_error"
            if intent.role == "REVIEWER":
                _log_stderr(
                    {
                        "type": "REVIEW_OUTCOME",
                        "role": "REVIEWER",
                        "run_id": intent.run_id,
                        "outcome": "INCOMPLETE",
                        "source": "post_processing_exception",
                    }
                )
                issue_number = intent.body.get("issue_number")
                if isinstance(issue_number, int) and issue_number > 0:
                    self._record_reviewer_outcome_state(
                        issue_number=issue_number,
                        outcome="INCOMPLETE",
                        recorded_at=_utc_now_iso(),
                    )
            _log_stderr(
                {
                    "type": "WORKER_FAILED",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "elapsed_s": int(time.time() - started_at),
                    "classification": failure_classification,
                    "error_code": error_code,
                    "error": str(exc),
                }
            )
            if self._ledger:
                self._ledger.mark_result(
                    intent.run_id,
                    status="failed",
                    result={
                        "status": "failed",
                        "summary": str(exc),
                        "urls": {},
                        "errors": [{"error": str(exc), "code": error_code}],
                        "failure_classification": failure_classification,
                        "error_code": error_code,
                        "reviewer_outcome": "INCOMPLETE" if intent.role == "REVIEWER" else None,
                        "last_reviewer_feedback_at": _utc_now_iso() if intent.role == "REVIEWER" else None,
                        "last_executor_response_at": None,
                    },
                )
            if intent.role == "EXECUTOR":
                self._transition_executor_failure_to_blocked(
                    run_id=intent.run_id,
                    failure_classification=failure_classification,
                    failure_message=str(exc),
                )
            raise


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
        review_stall_polls=config.review_stall_polls,
        blocked_retry_minutes=config.blocked_retry_minutes,
        watchdog_timeout_s=config.watchdog_timeout_s,
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
        "2",
    )
    orchestrator_env["ORCHESTRATOR_REVIEWER_RETRY_POLLS"] = os.environ.get(
        "ORCHESTRATOR_REVIEWER_RETRY_POLLS",
        str(config.review_stall_polls),
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
            "review_stall_polls": config.review_stall_polls,
            "blocked_retry_minutes": config.blocked_retry_minutes,
            "watchdog_timeout_s": config.watchdog_timeout_s,
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
                        if not config.dry_run:
                            runner.handle_dispatch_summary(summary=payload)
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
