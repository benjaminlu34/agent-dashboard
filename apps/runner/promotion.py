from __future__ import annotations

import copy
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .http_client import BackendClient


def _log_stderr(payload: dict[str, Any]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _priority_rank(priority: str) -> int:
    return {"P0": 0, "P1": 1, "P2": 2}.get(priority, 99)


def _atomic_write_regen_request(path: str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.with_name(f"{target.name}.tmp-{os.getpid()}")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2) + "\n", encoding="utf8")
    tmp_path.replace(target)


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


def extract_scope_plan(sprint_plan: Optional[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
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

    request_path = f"{orchestrator_state_path}.regen-request.json"
    _atomic_write_regen_request(
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


def maybe_autopromote_ready(
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

    scope_plan_raw = extract_scope_plan(sprint_plan)
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

