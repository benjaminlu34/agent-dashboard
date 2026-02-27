from __future__ import annotations

import argparse
import copy
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
from uuid import uuid4

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


def _empty_orchestrator_state() -> Dict[str, Any]:
    return {
        "poll_count": 0,
        "items": {},
        "sprint_plan": {},
        "ownership_index": {},
    }


def _load_orchestrator_state_for_reconciliation(path: str) -> Dict[str, Any]:
    state_path = Path(path)
    try:
        raw = state_path.read_text(encoding="utf8")
    except FileNotFoundError:
        return _empty_orchestrator_state()

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        backup_path = f"{path}.corrupt-{int(time.time() * 1000)}"
        backup_created = False
        try:
            state_path.rename(backup_path)
            backup_created = True
        except Exception:
            backup_created = False
        _log_stderr(
            {
                "type": "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
                "path": path,
                "backup_path": backup_path if backup_created else "",
                "error": "state file contains invalid JSON",
            }
        )
        return _empty_orchestrator_state()

    if not isinstance(parsed, dict):
        backup_path = f"{path}.corrupt-{int(time.time() * 1000)}"
        backup_created = False
        try:
            state_path.rename(backup_path)
            backup_created = True
        except Exception:
            backup_created = False
        _log_stderr(
            {
                "type": "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
                "path": path,
                "backup_path": backup_path if backup_created else "",
                "error": "state file must be a JSON object",
            }
        )
        return _empty_orchestrator_state()

    items = parsed.get("items")
    sprint_plan = parsed.get("sprint_plan")
    ownership_index = parsed.get("ownership_index")
    return {
        "poll_count": parsed.get("poll_count") if isinstance(parsed.get("poll_count"), int) and parsed.get("poll_count") >= 0 else 0,
        "items": items if isinstance(items, dict) else {},
        "sprint_plan": sprint_plan if isinstance(sprint_plan, dict) else {},
        "ownership_index": ownership_index if isinstance(ownership_index, dict) else {},
    }


def _priority_rank(priority: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2}.get(priority, 99)


def isNonEmptyString(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _extract_pr_url(urls: Any) -> str:
    if not isinstance(urls, dict):
        return ""
    for key in ("pr_url", "pull_request", "pr", "resolved_pr"):
        value = urls.get(key)
        if isNonEmptyString(value):
            return str(value).strip()
    return ""


def _normalize_scope_path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    normalized = value.strip().replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    while normalized.startswith("/"):
        normalized = normalized[1:]
    while normalized.endswith("/") and len(normalized) > 1:
        normalized = normalized[:-1]
    return normalized


def _paths_overlap(left: Any, right: Any) -> bool:
    left_norm = _normalize_scope_path(left)
    right_norm = _normalize_scope_path(right)
    if not left_norm or not right_norm:
        return False
    if left_norm == right_norm:
        return True
    if left_norm.startswith(f"{right_norm}/"):
        return True
    if right_norm.startswith(f"{left_norm}/"):
        return True
    return False


class MalformedSprintDataError(ValueError):
    pass


class SanitizationRegenExhaustedError(MalformedSprintDataError):
    def __init__(self, message: str, *, history: list[Dict[str, Any]]) -> None:
        super().__init__(message)
        self.history = history
        self.exit_code = 5


class SanitizationRegenHandoffRequestedError(MalformedSprintDataError):
    def __init__(self, message: str, *, history: list[Dict[str, Any]], request_path: str) -> None:
        super().__init__(message)
        self.history = history
        self.request_path = request_path
        self.exit_code = 6


def _scope_plan_to_items(scope_plan: Dict[int, Dict[str, Any]]) -> list[Dict[str, Any]]:
    items: list[Dict[str, Any]] = []
    for issue_number in sorted(scope_plan.keys()):
        meta = scope_plan.get(issue_number)
        if not isinstance(meta, dict):
            continue
        entry = copy.deepcopy(meta)
        entry["number"] = issue_number
        if not isinstance(entry.get("depends_on"), list):
            entry["depends_on"] = []
        if not isinstance(entry.get("owns_paths"), list):
            entry["owns_paths"] = []
        if not isinstance(entry.get("touch_paths"), list):
            entry["touch_paths"] = []
        items.append(entry)
    return items


def _items_to_scope_plan(items: list[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    scope_plan: Dict[int, Dict[str, Any]] = {}
    for item in items:
        number = item.get("number")
        if not isinstance(number, int) or number <= 0:
            continue
        cloned = copy.deepcopy(item)
        cloned.pop("number", None)
        if not isinstance(cloned.get("depends_on"), list):
            cloned["depends_on"] = []
        if not isinstance(cloned.get("owns_paths"), list):
            cloned["owns_paths"] = []
        if not isinstance(cloned.get("touch_paths"), list):
            cloned["touch_paths"] = []
        scope_plan[number] = cloned
    return scope_plan


def _sanitize_dependency_items(items: list[Dict[str, Any]]) -> Dict[str, Any]:
    scope_plan = _items_to_scope_plan(items)
    sanitized_scope, report, error = _sanitize_dependency_graph(scope_plan)
    return {
        "items": _scope_plan_to_items(sanitized_scope),
        "report": report,
        "error": error,
    }


def _is_doc_path(path_value: Any) -> bool:
    normalized = _normalize_scope_path(path_value).lower()
    if not normalized:
        return False
    if normalized.endswith(".md") or normalized.endswith(".txt") or normalized.endswith(".rst"):
        return True
    if normalized.startswith("docs/") or "/docs/" in normalized or normalized.endswith("/docs"):
        return True
    return False


def _is_doc_only_item_scope(meta: Dict[str, Any]) -> bool:
    touch_paths = meta.get("touch_paths")
    if not isinstance(touch_paths, list) or len(touch_paths) == 0:
        return False
    return all(_is_doc_path(path) for path in touch_paths)


def _normalize_owns_paths(meta: Dict[str, Any]) -> list[str]:
    owns_paths = meta.get("owns_paths")
    if not isinstance(owns_paths, list):
        return []
    normalized: list[str] = []
    for entry in owns_paths:
        path = _normalize_scope_path(entry)
        if path:
            normalized.append(path)
    return normalized


def _detect_dependency_cycles(scope_plan: Dict[int, Dict[str, Any]]) -> list[list[int]]:
    adjacency: Dict[int, list[int]] = {}
    issue_numbers = sorted(scope_plan.keys())
    for issue_number in issue_numbers:
        meta = scope_plan.get(issue_number)
        depends = meta.get("depends_on") if isinstance(meta, dict) else []
        deps: list[int] = []
        if isinstance(depends, list):
            for dep in depends:
                if isinstance(dep, int) and dep in scope_plan:
                    deps.append(dep)
        adjacency[issue_number] = deps

    index = 0
    index_by_issue: Dict[int, int] = {}
    lowlink_by_issue: Dict[int, int] = {}
    stack: list[int] = []
    on_stack: set[int] = set()
    components: list[list[int]] = []

    def strong_connect(issue_number: int) -> None:
        nonlocal index
        index_by_issue[issue_number] = index
        lowlink_by_issue[issue_number] = index
        index += 1
        stack.append(issue_number)
        on_stack.add(issue_number)

        for dep in adjacency.get(issue_number, []):
            if dep not in index_by_issue:
                strong_connect(dep)
                lowlink_by_issue[issue_number] = min(lowlink_by_issue[issue_number], lowlink_by_issue[dep])
            elif dep in on_stack:
                lowlink_by_issue[issue_number] = min(lowlink_by_issue[issue_number], index_by_issue[dep])

        if lowlink_by_issue[issue_number] != index_by_issue[issue_number]:
            return

        component: list[int] = []
        while len(stack) > 0:
            current = stack.pop()
            on_stack.discard(current)
            component.append(current)
            if current == issue_number:
                break
        component.sort()
        components.append(component)

    for issue_number in issue_numbers:
        if issue_number not in index_by_issue:
            strong_connect(issue_number)

    cycles: list[list[int]] = []
    for component in components:
        if len(component) > 1:
            cycles.append(component)
            continue
        issue = component[0]
        if issue in adjacency.get(issue, []):
            cycles.append(component)

    cycles.sort(key=lambda cycle: cycle[0] if len(cycle) > 0 else 0)
    return cycles


def _sanitize_dependency_graph(scope_plan: Dict[int, Dict[str, Any]]) -> tuple[Dict[int, Dict[str, Any]], Dict[str, Any], Optional[Dict[str, Any]]]:
    """
    Apply deterministic dependency sanitization before promotion logic.

    Assumption: depends_on exists only to sequence conflicting ownership paths.
    Ordering-only dependencies with no ownership overlap are pruned.
    """

    dropped_edges: list[Dict[str, Any]] = []
    issue_numbers = set(scope_plan.keys())
    doc_only_by_issue: Dict[int, bool] = {issue: _is_doc_only_item_scope(meta) for issue, meta in scope_plan.items()}

    sanitized: Dict[int, Dict[str, Any]] = {}
    for issue_number, meta in scope_plan.items():
        next_meta = dict(meta)
        depends = meta.get("depends_on")
        depends_list = depends if isinstance(depends, list) else []
        current_owns = _normalize_owns_paths(meta)
        current_doc_only = doc_only_by_issue.get(issue_number, False)

        sanitized_depends: list[int] = []
        for dep in depends_list:
            if not isinstance(dep, int) or dep not in issue_numbers:
                dropped_edges.append({"from": issue_number, "to": dep, "reason": "DEAD_REF"})
                continue

            dep_meta = scope_plan.get(dep)
            if not isinstance(dep_meta, dict):
                dropped_edges.append({"from": issue_number, "to": dep, "reason": "DEAD_REF"})
                continue

            dep_doc_only = doc_only_by_issue.get(dep, False)
            if dep_doc_only and not current_doc_only:
                dropped_edges.append({"from": issue_number, "to": dep, "reason": "DOC_BLOCKER"})
                continue

            dep_owns = _normalize_owns_paths(dep_meta)
            if len(current_owns) > 0 and len(dep_owns) > 0:
                overlaps = False
                for own in current_owns:
                    for dep_own in dep_owns:
                        if _paths_overlap(own, dep_own):
                            overlaps = True
                            break
                    if overlaps:
                        break
                if not overlaps:
                    dropped_edges.append({"from": issue_number, "to": dep, "reason": "NO_OVERLAP"})
                    continue

            sanitized_depends.append(dep)

        next_meta["depends_on"] = sanitized_depends
        sanitized[issue_number] = next_meta

    cycles = _detect_dependency_cycles(sanitized)
    report: Dict[str, Any] = {"droppedEdges": dropped_edges, "cycles": cycles if len(cycles) > 0 else None}
    if len(cycles) > 0:
        return sanitized, report, {"cycles": cycles}
    return sanitized, report, None


def _extract_scope_plan(sprint_plan: Optional[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    if not isinstance(sprint_plan, dict):
        return {}
    raw = sprint_plan.get("sprint_plan")
    if isinstance(raw, dict):
        out: Dict[int, Dict[str, Any]] = {}
        for key, value in raw.items():
            try:
                issue_number = int(key)
            except (TypeError, ValueError):
                continue
            if issue_number <= 0 or not isinstance(value, dict):
                continue
            out[issue_number] = value
        if out:
            return out

    tasks = sprint_plan.get("tasks")
    if not isinstance(tasks, list):
        return {}
    out2: Dict[int, Dict[str, Any]] = {}
    for task in tasks:
        if not isinstance(task, dict):
            continue
        issue_number = task.get("issue_number")
        scope = task.get("scope")
        if not isinstance(issue_number, int) or issue_number <= 0:
            continue
        if not isinstance(scope, dict):
            continue
        out2[issue_number] = scope
    return out2


def _attempt_sanitization_regen(
    *,
    sanitization_result: Dict[str, Any],
    attempt_history: list[Dict[str, Any]],
    attempt_number: int,
    current_items: list[Dict[str, Any]],
    original_sprint_plan: Dict[str, Any],
    orchestrator_state_path: str,
) -> Dict[str, Any]:
    cycles_targeted = sanitization_result.get("error", {}).get("cycles") if isinstance(sanitization_result.get("error"), dict) else []
    cycles_list = copy.deepcopy(cycles_targeted) if isinstance(cycles_targeted, list) else []
    deterministic_patched_items = copy.deepcopy(current_items)
    edges_removed: list[Dict[str, int]] = []

    item_by_issue: Dict[int, Dict[str, Any]] = {}
    for item in deterministic_patched_items:
        issue_number = item.get("number")
        if isinstance(issue_number, int) and issue_number > 0:
            item_by_issue[issue_number] = item

    for cycle in cycles_list:
        if not isinstance(cycle, list) or len(cycle) == 0:
            continue
        from_issue = cycle[-1]
        to_issue = cycle[0]
        if not isinstance(from_issue, int) or not isinstance(to_issue, int):
            continue
        item = item_by_issue.get(from_issue)
        if not isinstance(item, dict):
            continue
        depends = item.get("depends_on")
        if not isinstance(depends, list):
            continue
        next_depends = [dep for dep in depends if dep != to_issue]
        if len(next_depends) == len(depends):
            continue
        item["depends_on"] = next_depends
        edges_removed.append({"from": from_issue, "to": to_issue})

    if attempt_number == 0 and len(edges_removed) > 0:
        return {
            "attempt": attempt_number,
            "tier": "DETERMINISTIC_PATCH",
            "cycles_targeted": cycles_list,
            "edges_removed": edges_removed,
            "sanitization_report": copy.deepcopy(sanitization_result.get("report")),
            "cycle_error": copy.deepcopy(sanitization_result.get("error")),
            "patched_items": deterministic_patched_items,
        }

    context_sent = {
        "previous_sprint_plan": copy.deepcopy(original_sprint_plan),
        "sanitization_report": copy.deepcopy(sanitization_result.get("report")),
        "cycle_error": copy.deepcopy(sanitization_result.get("error")),
        "attempt_history": copy.deepcopy(attempt_history),
        "instruction": (
            "The depends_on graph for this sprint contains cycles or invalid edges that survived automated patching. "
            "Revise the scope metadata for the affected issues only. Do not change unaffected issues."
        ),
    }

    # Planner regeneration handoff contract:
    # - Runner writes context to `{ORCHESTRATOR_STATE_PATH}.regen-request.json`.
    # - External automation/CI re-invokes planning and updates sprint plan data.
    # - Runner is restarted after external planner writes updated scope metadata.
    request_path = f"{orchestrator_state_path}.regen-request.json"
    _atomic_write_json(
        request_path,
        {
            "requested_at": _utc_now_iso(),
            "attempt": attempt_number,
            "tier": "PLANNER_REGEN",
            "context": context_sent,
            "deterministic_patch_probe": {
                "cycles_targeted": cycles_list,
                "edges_removed": edges_removed,
            },
        },
    )

    return {
        "attempt": attempt_number,
        "tier": "PLANNER_REGEN",
        "cycles_targeted": cycles_list,
        "edges_removed": edges_removed,
        "sanitization_report": copy.deepcopy(sanitization_result.get("report")),
        "cycle_error": copy.deepcopy(sanitization_result.get("error")),
        "context_sent": context_sent,
        "request_path": request_path,
        "handoff_requested": True,
        "patched_items": deterministic_patched_items,
    }


def _maybe_autopromote_ready(
    *,
    summary: Dict[str, Any],
    sprint_plan: Optional[Dict[str, Any]],
    backend: BackendClient,
    dry_run: bool,
    ready_target: int,
    sanitization_regen_attempts: int = 2,
    orchestrator_state_path: str = "./.orchestrator-state.json",
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

    scope_plan_raw = _extract_scope_plan(sprint_plan)
    original_items = _scope_plan_to_items(scope_plan_raw)
    current_items = copy.deepcopy(original_items)
    max_attempts = int(sanitization_regen_attempts)
    if max_attempts < 0:
        max_attempts = 0
    attempt_history: list[Dict[str, Any]] = []
    attempts = 0

    while True:
        sanitization_result = _sanitize_dependency_items(current_items)
        _log_stderr({"type": "DEPENDENCY_GRAPH_SANITIZED", "report": sanitization_result.get("report")})
        sanitize_error = sanitization_result.get("error")
        if not sanitize_error:
            if len(attempt_history) > 0:
                _log_stderr(
                    {
                        "type": "sanitization_regen_succeeded",
                        "attempts": attempts,
                        "history": attempt_history,
                    }
                )
            scope_plan = _items_to_scope_plan(sanitization_result.get("items") if isinstance(sanitization_result.get("items"), list) else [])
            break

        if max_attempts == 0:
            _log_stderr({"type": "DEPENDENCY_CYCLE_DETECTED", "cycles": sanitize_error.get("cycles") if isinstance(sanitize_error, dict) else []})
            raise MalformedSprintDataError("dependency graph contains cycle(s); manual fix required")

        if attempts >= max_attempts:
            final_history = [
                *attempt_history,
                {
                    "attempt": attempts,
                    "tier": "FINAL_SANITIZATION_FAILED",
                    "sanitization_report": copy.deepcopy(sanitization_result.get("report")),
                    "cycle_error": copy.deepcopy(sanitize_error),
                },
            ]
            _log_stderr(
                {
                    "type": "sanitization_regen_exhausted",
                    "attempts": attempts,
                    "history": final_history,
                }
            )
            raise SanitizationRegenExhaustedError(
                "dependency graph regeneration exhausted",
                history=final_history,
            )

        patch_result = _attempt_sanitization_regen(
            sanitization_result=sanitization_result,
            attempt_history=attempt_history,
            attempt_number=attempts,
            current_items=current_items,
            original_sprint_plan=sprint_plan if isinstance(sprint_plan, dict) else {},
            orchestrator_state_path=orchestrator_state_path,
        )
        attempt_history.append(patch_result)
        current_items = copy.deepcopy(patch_result.get("patched_items") if isinstance(patch_result.get("patched_items"), list) else current_items)
        attempts += 1

        if patch_result.get("handoff_requested") is True:
            _log_stderr(
                {
                    "type": "sanitization_regen_handoff_requested",
                    "attempts": attempts,
                    "history": attempt_history,
                    "request_path": patch_result.get("request_path"),
                }
            )
            raise SanitizationRegenHandoffRequestedError(
                "planner regeneration handoff requested",
                history=attempt_history,
                request_path=str(patch_result.get("request_path") or ""),
            )

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
                if dep_status != "Done":
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
    if not eligible:
        return

    # Determine which owned paths are already reserved by Ready/active items.
    reserved: list[tuple[int, str]] = []
    for issue_number, status in status_by_issue.items():
        if status not in ("Ready", "In Progress", "In Review", "Needs Human Approval"):
            continue
        meta = scope_plan.get(issue_number)
        if not isinstance(meta, dict):
            continue
        owns = meta.get("owns_paths")
        if not isinstance(owns, list):
            continue
        for path in owns:
            normalized = _normalize_scope_path(path)
            if normalized:
                reserved.append((issue_number, normalized))

    promoted_count = 0
    for item in eligible:
        if promoted_count >= deficit:
            break
        issue_number = int(item["issue_number"])
        meta = scope_plan.get(issue_number)
        if isinstance(meta, dict):
            isolation_mode = str(meta.get("isolation_mode") or "").strip().upper()
            owns_paths = meta.get("owns_paths") if isinstance(meta.get("owns_paths"), list) else []

            if isolation_mode == "CHAINED":
                depends = meta.get("depends_on") if isinstance(meta.get("depends_on"), list) else []
                blocked_dep = None
                for dep in depends:
                    if not isinstance(dep, int) or dep <= 0:
                        continue
                    dep_status = status_by_issue.get(dep)
                    if dep_status != "Done":
                        blocked_dep = (dep, dep_status)
                        break
                if blocked_dep is not None:
                    dep_issue, dep_status = blocked_dep
                    _log_stderr(
                        {
                            "type": "BOARD_PROMOTION_SKIPPED_DEPENDENCY",
                            "issue_number": issue_number,
                            "depends_on": dep_issue,
                            "depends_on_status": dep_status or "",
                        }
                    )
                    continue

            conflict = None
            for owned in owns_paths:
                for other_issue, other_path in reserved:
                    if other_issue == issue_number:
                        continue
                    # CHAINED tasks are allowed to overlap prerequisites once they reach
                    # Done. Keep blocking overlaps with work
                    # that is still being actively executed/reviewed.
                    if isolation_mode == "CHAINED" and status_by_issue.get(other_issue) == "Done":
                        continue
                    if _paths_overlap(owned, other_path):
                        conflict = (other_issue, _normalize_scope_path(owned), other_path)
                        break
                if conflict:
                    break
            if conflict is not None:
                other_issue, owned_path, other_path = conflict
                _log_stderr(
                    {
                        "type": "BOARD_PROMOTION_SKIPPED_CONFLICT",
                        "issue_number": issue_number,
                        "conflict_issue_number": other_issue,
                        "path": owned_path,
                        "conflict_path": other_path,
                    }
                )
                continue

        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": item["project_item_id"],
            "field": "Status",
            "value": "Ready",
        }
        if dry_run:
            _log_stderr(
                {
                    "type": "BOARD_PROMOTION_APPLIED",
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
                "type": "BOARD_PROMOTION_APPLIED",
                "issue_number": item["issue_number"],
                "project_item_id": item["project_item_id"],
                "from": "Backlog",
                "to": "Ready",
                "reason": "ready_buffer_low",
                "dry_run": False,
                "backend_payload": payload,
            }
        )
        promoted_count += 1
        if isinstance(meta, dict):
            owns_paths = meta.get("owns_paths") if isinstance(meta.get("owns_paths"), list) else []
            for owned in owns_paths:
                normalized = _normalize_scope_path(owned)
                if normalized:
                    reserved.append((issue_number, normalized))


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

        # Prevent concurrent EXECUTOR/REVIEWER work on the same issue. Orchestrator can emit
        # reviewer intents while an executor run is still finishing its PR updates; this
        # gate forces per-issue serialization to avoid racey reviews.
        self._in_flight_lock = threading.Lock()
        self._in_flight_cond = threading.Condition(self._in_flight_lock)
        self._in_flight_by_issue: Dict[int, Dict[str, str]] = {}

    def reconcile_startup_state(self, *, sprint: str) -> Dict[str, Any]:
        try:
            payload = self._backend.get_project_items_metadata(role="ORCHESTRATOR", sprint=sprint)
        except Exception as exc:
            result = {
                "status": "SKIPPED",
                "reason": "remote_fetch_failed",
                "error": str(exc),
            }
            _log_stderr({"type": "STARTUP_RECONCILED", **result})
            return result

        remote_items = payload.get("items")
        if not isinstance(remote_items, list):
            result = {
                "status": "SKIPPED",
                "reason": "invalid_payload",
                "error": "metadata payload missing items list",
            }
            _log_stderr({"type": "STARTUP_RECONCILED", **result})
            return result

        synced_at = _normalize_iso(payload.get("as_of")) or _utc_now_iso()
        local_state = _load_orchestrator_state_for_reconciliation(self._orchestrator_state_path)
        local_items = local_state.get("items") if isinstance(local_state.get("items"), dict) else {}
        local_item_count = len(local_items)
        poll_count = local_state.get("poll_count") if isinstance(local_state.get("poll_count"), int) and local_state.get("poll_count") >= 0 else 0
        next_items: Dict[str, Dict[str, Any]] = {}

        dropped_remote = 0
        preserved_epoch_count = 0
        carried_review_state_count = 0
        reset_dispatch_count = 0

        for raw_item in remote_items:
            if not isinstance(raw_item, dict):
                dropped_remote += 1
                continue
            project_item_id = str(raw_item.get("project_item_id") or "").strip()
            issue_number = raw_item.get("issue_number")
            status = str(raw_item.get("status") or "").strip()
            if not project_item_id or not isinstance(issue_number, int) or issue_number <= 0 or not status:
                dropped_remote += 1
                continue

            issue_title = str(raw_item.get("issue_title") or "").strip()
            issue_url = str(raw_item.get("issue_url") or "").strip()
            item_sprint = str(raw_item.get("sprint") or "").strip() or sprint
            existing = local_items.get(project_item_id)
            previous = existing if isinstance(existing, dict) else {}

            same_issue = previous.get("last_seen_issue_number") == issue_number
            same_status_epoch = same_issue and previous.get("last_seen_status") == status
            if same_status_epoch:
                preserved_epoch_count += 1

            status_since_at = _normalize_iso(previous.get("status_since_at")) if same_status_epoch else ""
            if not status_since_at:
                status_since_at = synced_at
            status_since_poll = (
                previous.get("status_since_poll")
                if same_status_epoch and isinstance(previous.get("status_since_poll"), int) and previous.get("status_since_poll") >= 0
                else poll_count
            )
            last_activity_at = _normalize_iso(previous.get("last_activity_at")) if same_status_epoch else ""
            if not last_activity_at:
                last_activity_at = status_since_at
            last_activity_indicator = str(previous.get("last_activity_indicator") or "").strip() if same_status_epoch else ""
            if not last_activity_indicator:
                last_activity_indicator = "status_unchanged" if same_status_epoch else "startup_rehydrated"

            review_cycle_count = 0
            last_reviewer_outcome = ""
            last_reviewer_feedback_at = ""
            last_executor_response_at = ""
            in_review_origin = ""
            if status == "In Review" and same_status_epoch:
                cycle_value = previous.get("review_cycle_count")
                review_cycle_count = cycle_value if isinstance(cycle_value, int) and cycle_value >= 0 else 0
                outcome = str(previous.get("last_reviewer_outcome") or "").strip().upper()
                if outcome in ("PASS", "FAIL", "INCOMPLETE"):
                    last_reviewer_outcome = outcome
                last_reviewer_feedback_at = _normalize_iso(previous.get("last_reviewer_feedback_at"))
                last_executor_response_at = _normalize_iso(previous.get("last_executor_response_at"))
                in_review_origin = str(previous.get("in_review_origin") or "").strip()
                if review_cycle_count > 0 or last_reviewer_outcome or last_reviewer_feedback_at or last_executor_response_at:
                    carried_review_state_count += 1
            elif status == "In Review" and previous.get("last_seen_status") == "Needs Human Approval":
                in_review_origin = "needs_human_approval"

            last_run_id = str(previous.get("last_run_id") or "").strip() if same_issue else ""
            had_dispatch_state = (
                isNonEmptyString(previous.get("last_dispatched_role"))
                or isNonEmptyString(previous.get("last_dispatched_status"))
                or isNonEmptyString(previous.get("last_dispatched_at"))
                or (
                    isinstance(previous.get("last_dispatched_poll"), int)
                    and previous.get("last_dispatched_poll") > 0
                )
            )
            if had_dispatch_state:
                reset_dispatch_count += 1

            next_items[project_item_id] = {
                "last_seen_status": status,
                "last_seen_sprint": item_sprint,
                "last_seen_issue_number": issue_number,
                "last_seen_issue_title": issue_title,
                "last_seen_issue_url": issue_url,
                "last_seen_at": synced_at,
                "status_since_at": status_since_at,
                "status_since_poll": status_since_poll,
                "last_activity_at": last_activity_at,
                "last_activity_indicator": last_activity_indicator,
                "last_dispatched_role": "",
                "last_dispatched_status": "",
                "last_dispatched_at": "",
                "last_dispatched_poll": 0,
                "last_run_id": last_run_id,
                "reviewer_dispatches_for_current_status": 0,
                "review_cycle_count": review_cycle_count,
                "last_reviewer_outcome": last_reviewer_outcome,
                "last_reviewer_feedback_at": last_reviewer_feedback_at,
                "last_executor_response_at": last_executor_response_at,
                "in_review_origin": in_review_origin if status == "In Review" else "",
            }

        next_state = {
            "poll_count": poll_count,
            "items": next_items,
            "sprint_plan": local_state.get("sprint_plan") if isinstance(local_state.get("sprint_plan"), dict) else {},
            "ownership_index": local_state.get("ownership_index") if isinstance(local_state.get("ownership_index"), dict) else {},
        }
        pruned_items = len([project_item_id for project_item_id in local_items.keys() if project_item_id not in next_items])
        changed = local_state != next_state

        result = {
            "status": "APPLIED",
            "sprint": sprint,
            "dry_run": self._dry_run,
            "remote_items": len(next_items),
            "dropped_remote_items": dropped_remote,
            "local_items_before": local_item_count,
            "pruned_local_items": pruned_items,
            "preserved_status_epochs": preserved_epoch_count,
            "carried_review_state": carried_review_state_count,
            "reset_dispatch_state": reset_dispatch_count,
            "state_changed": changed,
            "as_of": synced_at,
        }

        if changed and not self._dry_run:
            _atomic_write_json(self._orchestrator_state_path, next_state)
        _log_stderr({"type": "STARTUP_RECONCILED", **result})
        return result

    def _resolve_issue_number_for_intent(self, intent: RunIntent) -> int:
        issue_number = intent.body.get("issue_number")
        if isinstance(issue_number, int) and issue_number > 0:
            return issue_number
        if intent.role != "EXECUTOR":
            return 0

        # Claim-ready-item intents do not include issue_number. Resolve via orchestrator state.
        deadline = time.time() + 5.0
        while time.time() < deadline and not self.should_stop():
            context = self._resolve_run_context(intent.run_id)
            if context:
                return int(context[0])
            time.sleep(0.05)
        return 0

    def _reserve_issue_slot(self, *, issue_number: int, run_id: str, role: str) -> None:
        if issue_number <= 0:
            return
        if not run_id:
            return

        waited_s = 0.0
        with self._in_flight_cond:
            while not self.should_stop():
                current = self._in_flight_by_issue.get(issue_number)
                if not isinstance(current, dict):
                    current = None
                if not current:
                    self._in_flight_by_issue[issue_number] = {"run_id": run_id, "role": role}
                    return
                if current.get("run_id") == run_id:
                    return

                if waited_s >= 5.0 and int(waited_s) % 5 == 0:
                    _log_stderr(
                        {
                            "type": "WORKER_WAITING",
                            "issue_number": issue_number,
                            "run_id": run_id,
                            "role": role,
                            "blocked_by_role": current.get("role"),
                            "blocked_by_run_id": current.get("run_id"),
                            "waited_s": int(waited_s),
                        }
                    )
                self._in_flight_cond.wait(timeout=0.5)
                waited_s += 0.5

    def _release_issue_slot(self, *, issue_number: int, run_id: str) -> None:
        if issue_number <= 0 or not run_id:
            return
        with self._in_flight_cond:
            current = self._in_flight_by_issue.get(issue_number)
            if isinstance(current, dict) and current.get("run_id") == run_id:
                del self._in_flight_by_issue[issue_number]
                self._in_flight_cond.notify_all()

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
        state["poll_count"] = state.get("poll_count") if isinstance(state.get("poll_count"), int) else 0
        state["items"] = items
        return state

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
        matches: list[tuple[str, str, str]] = []
        for project_item_id, entry in items.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("last_seen_issue_number") != issue_number:
                continue
            # State files can retain stale entries across repeated local runs. Prefer the
            # most recently seen project item for this issue number.
            last_seen_at = _normalize_iso(entry.get("last_seen_at"))
            status_since_at = _normalize_iso(entry.get("status_since_at"))
            matches.append((last_seen_at, status_since_at, project_item_id))
        if not matches:
            return None
        # ISO timestamps sort lexicographically when normalized; break ties deterministically.
        matches.sort()
        return matches[-1][2]

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

    def _recover_lost_in_review_reviewer_dispatches(self, *, summary: Dict[str, Any]) -> None:
        if not self._ledger:
            return
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return
        poll_count_value = summary.get("poll_count")
        current_poll = poll_count_value if isinstance(poll_count_value, int) and poll_count_value >= 0 else None
        now_iso = _utc_now_iso()

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
            if state_item.get("last_dispatched_role") != "REVIEWER":
                continue
            if state_item.get("last_dispatched_status") != "In Review":
                continue
            if isNonEmptyString(state_item.get("last_reviewer_outcome")):
                continue
            last_dispatched_poll_value = state_item.get("last_dispatched_poll")
            last_dispatched_poll = (
                last_dispatched_poll_value if isinstance(last_dispatched_poll_value, int) and last_dispatched_poll_value >= 0 else 0
            )
            # Do not recover within the same orchestrator poll epoch that emitted this dispatch.
            if current_poll is not None and last_dispatched_poll >= current_poll:
                continue
            stale_run_id = str(state_item.get("last_run_id") or "").strip()
            if not stale_run_id:
                continue

            elapsed_seconds = _seconds_since(state_item.get("last_dispatched_at"), now_iso=now_iso)

            ledger_entry = self._ledger.get(stale_run_id)
            if isinstance(ledger_entry, dict):
                ledger_status = str(ledger_entry.get("status") or "").strip().lower()
                if ledger_status == "running":
                    continue
                result = ledger_entry.get("result")
                reviewer_outcome = ""
                if isinstance(result, dict):
                    outcome_value = result.get("reviewer_outcome")
                    if isNonEmptyString(outcome_value):
                        reviewer_outcome = str(outcome_value).strip().upper()
                if reviewer_outcome in ("PASS", "FAIL", "INCOMPLETE"):
                    continue
                recovery_reason = f"ledger_status_{ledger_status or 'unknown'}_without_outcome"
            else:
                recovery_reason = "ledger_entry_missing"

            self._update_orchestrator_state_item(
                project_item_id,
                {
                    "last_dispatched_role": "",
                    "last_dispatched_status": "",
                    "last_dispatched_at": "",
                    "last_dispatched_poll": 0,
                },
            )
            _log_stderr(
                {
                    "type": "REVIEW_DISPATCH_RECOVERED",
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "stale_run_id": stale_run_id,
                    "elapsed_s": elapsed_seconds,
                    "reason": recovery_reason,
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
            if item.get("status") not in ("In Progress", "In Review"):
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
        self._recover_lost_in_review_reviewer_dispatches(summary=summary)
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
        if status not in ("In Progress", "In Review"):
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_SKIPPED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "reason": "status_not_recoverable",
                    "status": status,
                }
            )
            return

        if status == "In Review":
            suggested_next_steps = [
                "Inspect reviewer feedback and linked PR comments for unresolved items.",
                "Resume work on the existing linked PR branch (do not open a new PR).",
                "Move item back to In Review only after updates are pushed and verified.",
            ]
        else:
            suggested_next_steps = [
                "Inspect runner logs and ledger entry for this run_id.",
                "Validate PR linkage and backend policy constraints.",
                "Move item to Ready only after remediation is complete.",
            ]

        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Blocked",
            "issue_number": issue_number,
            "failure_classification": failure_classification,
            "failure_message": failure_message[:1000],
            "suggested_next_steps": suggested_next_steps,
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
                    "from": status,
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

        issue_number = self._resolve_issue_number_for_intent(intent)
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

        self._reserve_issue_slot(issue_number=issue_number, run_id=intent.run_id, role=intent.role)
        slot_released = False

        def release_issue_slot_once() -> None:
            nonlocal slot_released
            if slot_released:
                return
            self._release_issue_slot(issue_number=issue_number, run_id=intent.run_id)
            slot_released = True

        try:
            _log_stderr(
                {
                    "type": "WORKER_STARTED",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "endpoint": intent.endpoint,
                    "issue_number": issue_number if issue_number > 0 else None,
                    "executor_queue_depth": self._executor_queue.qsize(),
                    "reviewer_queue_depth": self._reviewer_queue.qsize(),
                }
            )
            # Bundle injection: fetch verbatim from backend.
            bundle = self._backend.get_agent_context(intent.role)

            def _intent_transcript_sink(section: str, content: str) -> None:
                _emit_live_transcript_event(
                    backend=self._backend,
                    run_id=intent.run_id,
                    role=intent.role,
                    section=section,
                    content=content,
                )

            # Execute via Codex MCP worker (Codex MCP server is spawned per intent).
            result = run_intent_with_codex_mcp(
                codex_bin=self._codex_bin,
                codex_mcp_args=self._codex_mcp_args,
                backend_base_url=self._backend.base_url,
                role_bundle=bundle,
                intent=intent.raw,
                tools_call_timeout_s=self._codex_tools_call_timeout_s,
                transcript_event_sink=_intent_transcript_sink,
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
            release_issue_slot_once()
            raise
        finally:
            heartbeat_stop.set()

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
                if _extract_pr_url(result.urls):
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
        finally:
            release_issue_slot_once()


def _log_stderr(obj: Dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stderr.flush()


_TRANSCRIPT_EVENT_QUEUE_MAX = 1024
_transcript_event_queue: "queue.Queue[Tuple[Any, Dict[str, str]]]" = queue.Queue(maxsize=_TRANSCRIPT_EVENT_QUEUE_MAX)
_transcript_sender_started = False
_transcript_sender_lock = threading.Lock()


def _post_live_transcript_event(*, backend: Any, body: Dict[str, str]) -> None:
    try:
        if isinstance(backend, BackendClient):
            timeout_s = max(0.75, min(backend.timeout_s, 2.0))
            backend.post_json("/internal/logs/events", body=body, timeout_s=timeout_s)
            return
        post_json = getattr(backend, "post_json", None)
        if callable(post_json):
            post_json("/internal/logs/events", body=body)
    except Exception:
        # Live transcript streaming must never interrupt orchestrator/runner execution.
        pass


def _transcript_sender_worker() -> None:
    while True:
        try:
            backend, body = _transcript_event_queue.get()
        except Exception:
            continue
        try:
            _post_live_transcript_event(backend=backend, body=body)
        finally:
            try:
                _transcript_event_queue.task_done()
            except Exception:
                pass


def _ensure_transcript_sender_started() -> None:
    global _transcript_sender_started
    if _transcript_sender_started:
        return
    with _transcript_sender_lock:
        if _transcript_sender_started:
            return
        thread = threading.Thread(target=_transcript_sender_worker, daemon=True, name="transcript-sender")
        thread.start()
        _transcript_sender_started = True


def _emit_live_transcript_event(
    *,
    backend: Any,
    run_id: str,
    role: str,
    section: str,
    content: str,
) -> None:
    normalized_run_id = str(run_id or "").strip()
    normalized_role = str(role or "").strip().upper()
    normalized_section = str(section or "").strip().upper()
    normalized_content = str(content or "").strip()
    if not normalized_run_id or not normalized_role or not normalized_section or not normalized_content:
        return

    if not callable(getattr(backend, "post_json", None)):
        return

    body = {
        "run_id": normalized_run_id,
        "role": normalized_role,
        "section": normalized_section,
        "content": normalized_content,
    }

    try:
        _ensure_transcript_sender_started()
        _transcript_event_queue.put_nowait((backend, body))
    except queue.Full:
        # Prefer newer transcript chunks over stale backlog to keep UI current.
        try:
            _transcript_event_queue.get_nowait()
            _transcript_event_queue.task_done()
        except Exception:
            pass
        try:
            _transcript_event_queue.put_nowait((backend, body))
        except Exception:
            pass
    except Exception:
        # Live transcript streaming must never interrupt orchestrator/runner execution.
        pass


class _RunTranscriptWriter:
    def __init__(self, *, repo_root: str, run_id: str, backend: Any = None, role: str = "ORCHESTRATOR"):
        _ = repo_root
        self._lock = threading.Lock()
        self._backend = backend
        self._run_id = str(run_id or "").strip()
        self._role = str(role or "").strip().upper()

    def _write(self, title: str, text: str) -> None:
        if not isinstance(text, str) or text == "":
            return
        with self._lock:
            try:
                _emit_live_transcript_event(
                    backend=self._backend,
                    run_id=self._run_id,
                    role=self._role,
                    section=str(title or "").strip().upper() or "SYSTEM OBSERVATION",
                    content=text,
                )
            except Exception:
                # Transcript streaming must never interrupt orchestration.
                pass

    def _append_section(self, *, title: str, content: str) -> None:
        normalized_content = str(content or "").strip()
        if not normalized_content:
            return
        normalized_title = str(title or "").strip()
        if not normalized_title:
            normalized_title = "SYSTEM OBSERVATION"
        self._write(normalized_title, normalized_content)

    def append_message_to_agent(self, content: str) -> None:
        self._append_section(title="MESSAGE TO AGENT", content=content)

    def append_agent_thinking(self, content: str) -> None:
        self._append_section(title="AGENT THINKING", content=content)

    def append_system_observation(self, content: str) -> None:
        self._append_section(title="SYSTEM OBSERVATION", content=content)

    def close(self) -> None:
        return None


def _safe_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _format_orchestrator_poll_summary(summary: Dict[str, Any]) -> str:
    sprint = str(summary.get("sprint") or "").strip() or "Unknown"
    poll_count = _safe_int(summary.get("poll_count"), 0)
    status_counts = summary.get("status_counts") if isinstance(summary.get("status_counts"), dict) else {}
    intents_emitted = summary.get("intents_emitted") if isinstance(summary.get("intents_emitted"), dict) else {}
    skipped = summary.get("skipped") if isinstance(summary.get("skipped"), dict) else {}
    needs_attention = summary.get("needs_attention") if isinstance(summary.get("needs_attention"), dict) else {}

    backlog = _safe_int(status_counts.get("Backlog"), 0)
    ready = _safe_int(status_counts.get("Ready"), 0)
    in_progress = _safe_int(status_counts.get("In Progress"), 0)
    in_review = _safe_int(status_counts.get("In Review"), 0)
    needs_human = _safe_int(status_counts.get("Needs Human Approval"), 0)
    blocked = _safe_int(status_counts.get("Blocked"), 0)
    done = _safe_int(status_counts.get("Done"), 0)

    executor_dispatches = _safe_int(intents_emitted.get("EXECUTOR"), 0)
    reviewer_dispatches = _safe_int(intents_emitted.get("REVIEWER"), 0)
    total_dispatches = _safe_int(intents_emitted.get("total"), executor_dispatches + reviewer_dispatches)
    stalled_items = needs_attention.get("stalled_in_progress") if isinstance(needs_attention, dict) else []
    churn_items = needs_attention.get("in_review_churn") if isinstance(needs_attention, dict) else []
    stalled_in_progress = len(stalled_items) if isinstance(stalled_items, list) else 0
    in_review_churn = len(churn_items) if isinstance(churn_items, list) else 0

    lines = [
        f"Poll #{poll_count} for sprint {sprint}.",
        (
            "Board status: "
            f"Backlog={backlog}, Ready={ready}, In Progress={in_progress}, In Review={in_review}, "
            f"Needs Human Approval={needs_human}, Blocked={blocked}, Done={done}"
        ),
        f"Dispatch decisions: Executor={executor_dispatches}, Reviewer={reviewer_dispatches}, Total={total_dispatches}",
        (
            "Skipped: "
            f"not_in_scope={_safe_int(skipped.get('not_in_scope'), 0)}, "
            f"dedupe_same_status={_safe_int(skipped.get('dedupe_same_status'), 0)}, "
            f"concurrency_limit={_safe_int(skipped.get('concurrency_limit'), 0)}"
        ),
        f"Attention flags: stalled_in_progress={stalled_in_progress}, in_review_churn={in_review_churn}",
    ]

    if total_dispatches == 0:
        lines.append("No new agent dispatches this poll.")
    if bool(summary.get("completed")):
        lines.append("Sprint completion condition reached: no active or backlog items remain.")

    return "\n".join(lines)


def _format_orchestrator_intent_observation(intent: RunIntent) -> str:
    issue_number = intent.body.get("issue_number")
    if isinstance(issue_number, int) and issue_number > 0:
        return (
            f"Dispatched {intent.role} run {intent.run_id} for issue #{issue_number}. "
            f"Endpoint: {intent.endpoint}"
        )
    return f"Dispatched {intent.role} run {intent.run_id}. Endpoint: {intent.endpoint}"


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
        "You are drafting sprint issues for EXECUTOR/REVIEWER runs. You are not implementing the work yourself.\n"
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
        "Quality constraints (non-negotiable):\n"
        "- Tasks MUST be direct, executable engineering work that implements the goal.\n"
        "- Tasks MUST implement goal.txt in code. Do not create process/runbook/template tasks unless goal.txt is about process tooling.Do NOT create meta-process tasks like: defining templates, writing runbooks, creating a backlog map, or drafting reviewer/executor checklists.\n"
        "- Do NOT make the sprint about improving this orchestration system; the sprint is about implementing the goal in the target repository.\n"
        "- The sprint goal issue may touch docs, but sprint tasks should generally touch real product code/assets, not just markdown.\n"
        "- ready_set_titles should include the most dependency-free P0 implementation tasks.\n\n"
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
    ready_target: int,
    sanitization_regen_attempts: int = 2,
    orchestrator_state_path: str = "./.orchestrator-state.json",
) -> Dict[str, Any]:
    ready_titles: list[str] = list(plan.get("ready_set_titles") or [])

    if dry_run:
        _log_stderr({"type": "KICKOFF_DRY_RUN", "ready_set_titles": ready_titles})
        return {"status": "DRY_RUN", "ready_set_titles": ready_titles}

    apply_payload = backend.post_json("/internal/plan-apply", body={"role": "ORCHESTRATOR", "draft": draft})
    if apply_payload.get("status") != "APPLIED":
        raise KickoffError("plan-apply did not return APPLIED", code="kickoff_plan_apply_failed", details={"payload": apply_payload})

    sprint_scope_plan = apply_payload.get("sprint_plan") if isinstance(apply_payload.get("sprint_plan"), dict) else {}
    ownership_index = apply_payload.get("ownership_index") if isinstance(apply_payload.get("ownership_index"), dict) else {}

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
                "scope": sprint_scope_plan.get(str(issue_number)) if sprint_scope_plan else None,
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
        "sprint_plan": sprint_scope_plan,
        "ownership_index": ownership_index,
    }
    _atomic_write_json(sprint_plan_path, plan_cache)
    _log_stderr({"type": "SPRINT_PLAN_SAVED", "path": sprint_plan_path, "sprint": plan_cache.get("sprint")})

    promoted: List[Dict[str, Any]] = []
    scope_plan = _extract_scope_plan(plan_cache)
    title_to_issue_number = {t.get("title"): t.get("issue_number") for t in tasks_plan if isinstance(t, dict)}
    status_by_issue = {t.get("issue_number"): "Backlog" for t in tasks_plan if isinstance(t, dict) and isinstance(t.get("issue_number"), int)}
    reserved: list[tuple[int, str]] = []

    for title in ready_titles:
        project_item_id = title_to_project_item_id.get(title)
        if not project_item_id:
            raise KickoffError(
                "ready_set task not found in plan-apply results",
                code="kickoff_ready_set_missing_mapping",
                details={"title": title},
            )

        issue_number = title_to_issue_number.get(title)
        if not isinstance(issue_number, int) or issue_number <= 0:
            raise KickoffError(
                "ready_set task missing issue_number mapping",
                code="kickoff_ready_set_missing_mapping",
                details={"title": title},
            )

        meta = scope_plan.get(issue_number)
        if isinstance(meta, dict):
            isolation_mode = str(meta.get("isolation_mode") or "").strip().upper()
            owns_paths = meta.get("owns_paths") if isinstance(meta.get("owns_paths"), list) else []
            if isolation_mode == "CHAINED":
                depends = meta.get("depends_on") if isinstance(meta.get("depends_on"), list) else []
                blocked_dep = None
                for dep in depends:
                    if not isinstance(dep, int) or dep <= 0:
                        continue
                    dep_status = status_by_issue.get(dep)
                    if dep_status != "Done":
                        blocked_dep = (dep, dep_status)
                        break
                if blocked_dep is not None:
                    dep_issue, dep_status = blocked_dep
                    _log_stderr(
                        {
                            "type": "BOARD_PROMOTION_SKIPPED_DEPENDENCY",
                            "issue_number": issue_number,
                            "depends_on": dep_issue,
                            "depends_on_status": dep_status or "",
                            "reason": "kickoff_ready_set",
                        }
                    )
                    continue

            conflict = None
            for owned in owns_paths:
                for other_issue, other_path in reserved:
                    if _paths_overlap(owned, other_path):
                        conflict = (other_issue, _normalize_scope_path(owned), other_path)
                        break
                if conflict:
                    break
            if conflict is not None:
                other_issue, owned_path, other_path = conflict
                _log_stderr(
                    {
                        "type": "BOARD_PROMOTION_SKIPPED_CONFLICT",
                        "issue_number": issue_number,
                        "conflict_issue_number": other_issue,
                        "path": owned_path,
                        "conflict_path": other_path,
                        "reason": "kickoff_ready_set",
                    }
                )
                continue

        update_payload = backend.post_json(
            "/internal/project-item/update-field",
            body={"role": "ORCHESTRATOR", "project_item_id": project_item_id, "field": "Status", "value": "Ready"},
        )
        promoted.append({"title": title, "project_item_id": project_item_id, "update_payload": update_payload})
        _log_stderr(
            {
                "type": "BOARD_PROMOTION_APPLIED",
                "issue_number": issue_number,
                "project_item_id": project_item_id,
                "from": "Backlog",
                "to": "Ready",
                "reason": "kickoff_ready_set",
                "backend_payload": update_payload,
            }
        )
        status_by_issue[issue_number] = "Ready"
        if isinstance(meta, dict):
            owns_paths = meta.get("owns_paths") if isinstance(meta.get("owns_paths"), list) else []
            for owned in owns_paths:
                normalized = _normalize_scope_path(owned)
                if normalized:
                    reserved.append((issue_number, normalized))

    if not promoted:
        # Defensive: if ready_set titles are blocked by ownership chaining, fall back
        # to auto-promoting the earliest eligible tasks so the sprint can start.
        processed_items = []
        for task in tasks_plan:
            if not isinstance(task, dict):
                continue
            issue_number = task.get("issue_number")
            project_item_id = task.get("project_item_id")
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            processed_items.append({"issue_number": issue_number, "project_item_id": project_item_id, "status": "Backlog"})

        fallback_summary = {
            "type": "DISPATCH_SUMMARY",
            "sprint": str(plan_cache.get("sprint") or ""),
            "status_counts": {"Ready": 0, "Backlog": len(processed_items)},
            "processed_items": processed_items,
        }
        _log_stderr({"type": "KICKOFF_READY_SET_EMPTY", "ready_set_titles": ready_titles, "fallback_ready_target": int(ready_target)})
        _maybe_autopromote_ready(
            summary=fallback_summary,
            sprint_plan=plan_cache,
            backend=backend,
            dry_run=False,
            ready_target=int(ready_target),
            sanitization_regen_attempts=int(sanitization_regen_attempts),
            orchestrator_state_path=orchestrator_state_path,
        )

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
    repo_root = str(Path(__file__).resolve().parents[2])
    try:
        config = load_config(
            dry_run_flag=args.dry_run,
            once_flag=args.once,
            orchestrator_sprint_override=sprint_override,
            cwd=repo_root,
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

    ledger: Optional[RunLedger] = None
    if not config.dry_run:
        ledger = RunLedger(config.ledger_path)

    if args.kickoff:
        kickoff_run_id = f"kickoff-{uuid4()}"
        if ledger:
            ledger.upsert(
                LedgerEntry(
                    run_id=kickoff_run_id,
                    role="ORCHESTRATOR",
                    intent_hash=f"kickoff:{config.orchestrator_sprint}",
                    received_at=_utc_now_iso(),
                    status="queued",
                    result=None,
                )
            )
            ledger.mark_running(kickoff_run_id)

        def _mark_kickoff_result(*, status: str, summary: str, errors: Optional[List[Dict[str, Any]]] = None, details: Optional[Dict[str, Any]] = None) -> None:
            if not ledger:
                return
            payload: Dict[str, Any] = {
                "run_id": kickoff_run_id,
                "role": "ORCHESTRATOR",
                "status": status,
                "summary": summary,
                "urls": {},
                "errors": errors or [],
                "completed_at": _utc_now_iso(),
            }
            if details:
                payload["details"] = details
            ledger.mark_result(kickoff_run_id, status="succeeded" if status == "succeeded" else "failed", result=payload)

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

            def _kickoff_transcript_sink(section: str, content: str) -> None:
                _emit_live_transcript_event(
                    backend=backend,
                    run_id=kickoff_run_id,
                    role="ORCHESTRATOR",
                    section=section,
                    content=content,
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
                run_id=kickoff_run_id,
                repo_root=repo_root,
                transcript_event_sink=_kickoff_transcript_sink,
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
                    ready_target=ready_limit,
                    sanitization_regen_attempts=config.orchestrator_sanitization_regen_attempts,
                    orchestrator_state_path=config.orchestrator_state_path,
                )
            except HttpError as exc:
                # Treat any kickoff write failure as hard stop (including 409 preflight/policy failures).
                raise KickoffError(
                    "kickoff backend request failed",
                    code="kickoff_backend_error",
                    details={"code": exc.code, "status_code": exc.status_code, "payload": exc.payload},
                ) from None
            _log_stderr({"type": "KICKOFF_RESULT", **apply_result})
            _mark_kickoff_result(
                status="succeeded",
                summary="Kickoff planning completed.",
                details={
                    "sprint": sprint,
                    "ready_limit": ready_limit,
                    "apply_status": apply_result.get("status"),
                    "promoted_count": len(apply_result.get("promoted") or []),
                },
            )
        except SanitizationRegenHandoffRequestedError as exc:
            _mark_kickoff_result(
                status="failed",
                summary=str(exc),
                errors=[{"code": "sanitization_regen_handoff_requested", "message": str(exc)}],
                details={"request_path": exc.request_path},
            )
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "sanitization_regen_handoff_requested",
                    "error": str(exc),
                    "request_path": exc.request_path,
                    "history": exc.history,
                }
            )
            return 6
        except SanitizationRegenExhaustedError as exc:
            _mark_kickoff_result(
                status="failed",
                summary=str(exc),
                errors=[{"code": "sanitization_regen_exhausted", "message": str(exc)}],
            )
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "sanitization_regen_exhausted",
                    "error": str(exc),
                    "history": exc.history,
                }
            )
            return 5
        except MalformedSprintDataError as exc:
            _mark_kickoff_result(
                status="failed",
                summary=str(exc),
                errors=[{"code": "malformed_item_data", "message": str(exc)}],
            )
            _log_stderr({"type": "HARD_STOP", "reason": "malformed_item_data", "error": str(exc)})
            return 3
        except (KickoffError, CodexWorkerError) as exc:
            _mark_kickoff_result(
                status="failed",
                summary=str(exc),
                errors=[{"code": getattr(exc, "code", "kickoff_failed"), "message": str(exc)}],
                details=getattr(exc, "details", {}),
            )
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

    try:
        runner.reconcile_startup_state(sprint=config.orchestrator_sprint)
    except Exception as exc:
        _log_stderr(
            {
                "type": "STARTUP_RECONCILED",
                "status": "SKIPPED",
                "reason": "unexpected_error",
                "error": str(exc),
            }
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

    orchestrator_loop_run_id = f"orchestrator-loop-{uuid4()}"
    orchestrator_poll_summaries_seen = 0
    orchestrator_dispatches_seen = 0
    orchestrator_transcript = _RunTranscriptWriter(
        repo_root=repo_root,
        run_id=orchestrator_loop_run_id,
        backend=backend,
        role="ORCHESTRATOR",
    )
    orchestrator_poll_interval_ms = _safe_int(orchestrator_env.get("ORCHESTRATOR_POLL_INTERVAL_MS"), 15000)
    if orchestrator_poll_interval_ms <= 0:
        orchestrator_poll_interval_ms = 15000

    if ledger:
        ledger.upsert(
            LedgerEntry(
                run_id=orchestrator_loop_run_id,
                role="ORCHESTRATOR",
                intent_hash=f"orchestrator-loop:{config.orchestrator_sprint}",
                received_at=_utc_now_iso(),
                status="queued",
                result=None,
            )
        )
        ledger.mark_running(orchestrator_loop_run_id)

    def _mark_orchestrator_loop_result(
        *,
        status: str,
        summary: str,
        errors: Optional[List[Dict[str, Any]]] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not ledger:
            return
        result_payload: Dict[str, Any] = {
            "run_id": orchestrator_loop_run_id,
            "role": "ORCHESTRATOR",
            "status": status,
            "summary": summary,
            "urls": {},
            "errors": errors or [],
            "completed_at": _utc_now_iso(),
            "poll_summaries_seen": orchestrator_poll_summaries_seen,
            "dispatches_seen": orchestrator_dispatches_seen,
        }
        if details:
            result_payload["details"] = details
        ledger.mark_result(
            orchestrator_loop_run_id,
            status="succeeded" if status == "succeeded" else "failed",
            result=result_payload,
        )

    orchestrator_transcript.append_message_to_agent(
        (
            "Role: ORCHESTRATOR\n"
            f"Mode: {'once' if config.once else 'loop'}\n"
            f"Sprint: {config.orchestrator_sprint}\n"
            f"Polling interval: {int(orchestrator_poll_interval_ms / 1000)}s\n"
            "Goal: Monitor sprint board status, choose eligible work, and dispatch EXECUTOR/REVIEWER runs."
        )
    )

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
            "sanitization_regen_attempts": config.orchestrator_sanitization_regen_attempts,
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

                    payload: Optional[Dict[str, Any]] = None
                    try:
                        parsed = parse_json_line(stripped)
                        if isinstance(parsed, dict):
                            payload = parsed
                    except IntentError:
                        payload = None

                    if payload is None:
                        # Preserve plain errors while suppressing raw schema noise in UI.
                        if not stripped.startswith("{"):
                            lowered = stripped.lower()
                            if "fetch failed" in lowered:
                                orchestrator_transcript.append_system_observation(
                                    "Network request failed while orchestrator was polling GitHub/backend (fetch failed)."
                                )
                            else:
                                orchestrator_transcript.append_system_observation(stripped[:2000])
                        continue

                    payload_type = str(payload.get("type") or "").strip().upper()
                    if payload_type == "DISPATCH_SUMMARY":
                        orchestrator_poll_summaries_seen += 1
                        intents_emitted_payload = payload.get("intents_emitted")
                        if not isinstance(intents_emitted_payload, dict):
                            intents_emitted_payload = {}
                        dispatch_total = _safe_int(intents_emitted_payload.get("total"), 0)
                        if dispatch_total > 0:
                            orchestrator_dispatches_seen += dispatch_total
                        orchestrator_transcript.append_agent_thinking(_format_orchestrator_poll_summary(payload))

                        try:
                            if config.autopromote:
                                _maybe_autopromote_ready(
                                    summary=payload,
                                    sprint_plan=sprint_plan,
                                    backend=backend,
                                    dry_run=config.dry_run,
                                    ready_target=config.runner_ready_buffer,
                                    sanitization_regen_attempts=config.orchestrator_sanitization_regen_attempts,
                                    orchestrator_state_path=config.orchestrator_state_path,
                                )
                        except SanitizationRegenHandoffRequestedError as exc:
                            _mark_orchestrator_loop_result(
                                status="failed",
                                summary=str(exc),
                                errors=[{"code": "sanitization_regen_handoff_requested", "message": str(exc)}],
                                details={"request_path": exc.request_path},
                            )
                            _log_stderr(
                                {
                                    "type": "HARD_STOP",
                                    "reason": "sanitization_regen_handoff_requested",
                                    "error": str(exc),
                                    "request_path": exc.request_path,
                                    "history": exc.history,
                                }
                            )
                            return 6
                        except SanitizationRegenExhaustedError as exc:
                            _mark_orchestrator_loop_result(
                                status="failed",
                                summary=str(exc),
                                errors=[{"code": "sanitization_regen_exhausted", "message": str(exc)}],
                            )
                            _log_stderr(
                                {
                                    "type": "HARD_STOP",
                                    "reason": "sanitization_regen_exhausted",
                                    "error": str(exc),
                                    "history": exc.history,
                                }
                            )
                            return 5
                        except MalformedSprintDataError as exc:
                            _mark_orchestrator_loop_result(
                                status="failed",
                                summary=str(exc),
                                errors=[{"code": "malformed_item_data", "message": str(exc)}],
                            )
                            _log_stderr({"type": "HARD_STOP", "reason": "malformed_item_data", "error": str(exc)})
                            return 3
                        if config.autopromote and not config.dry_run:
                            runner.handle_dispatch_summary(summary=payload)
                    elif payload_type == "END_OF_SPRINT_SUMMARY":
                        awaiting_humans = str(payload.get("awaiting_humans") or "").strip()
                        if awaiting_humans:
                            orchestrator_transcript.append_agent_thinking(awaiting_humans)
                    elif payload_type == "ORCHESTRATOR_CYCLE_TRANSIENT_ERROR":
                        retry_in_ms = _safe_int(payload.get("retry_in_ms"), 0)
                        retry_in_s = int(retry_in_ms / 1000) if retry_in_ms > 0 else 0
                        orchestrator_transcript.append_system_observation(
                            (
                                f"Transient orchestrator cycle error: {str(payload.get('error') or 'Unknown error')}\n"
                                f"Retry in: {retry_in_s}s\n"
                                "Action: monitor this terminal; if retries continue for several polls, verify backend/network connectivity."
                            )
                        )
                    elif payload_type == "ORCHESTRATOR_STATE_RESET_INVALID_JSON":
                        orchestrator_transcript.append_system_observation(
                            (
                                "Detected invalid orchestrator state JSON and reset state file.\n"
                                f"Path: {str(payload.get('path') or '')}"
                            )
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
                orchestrator_transcript.append_system_observation(_format_orchestrator_intent_observation(intent))

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
        orchestrator_transcript.close()

    if runner.should_stop():
        orchestrator_transcript.append_system_observation(
            (
                f"Runner hard-stopped the loop.\nReason: {runner.stop_reason()}\n"
                "Action: inspect this terminal and restart the runner loop after fixing the underlying issue."
            )
        )
        _mark_orchestrator_loop_result(
            status="failed",
            summary=runner.stop_reason(),
            errors=[{"code": "runner_hard_stop", "message": runner.stop_reason()}],
        )
        _log_stderr({"type": "HARD_STOP", "reason": runner.stop_reason()})
        return 2

    rc = proc.wait(timeout=5)
    if rc != 0:
        orchestrator_transcript.append_system_observation(
            (
                f"Orchestrator process exited with code {rc}.\n"
                "Action: review the latest error details above, then restart Runner Loop from the UI."
            )
        )
        _mark_orchestrator_loop_result(
            status="failed",
            summary=f"orchestrator exited with code {rc}",
            errors=[{"code": "orchestrator_nonzero_exit", "message": f"exit code {rc}"}],
        )
        _log_stderr({"type": "HARD_STOP", "reason": "orchestrator_nonzero_exit", "exit_code": rc})
        return rc if rc in (2, 3, 4) else 2

    _mark_orchestrator_loop_result(
        status="succeeded",
        summary="orchestrator loop finished cleanly",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
