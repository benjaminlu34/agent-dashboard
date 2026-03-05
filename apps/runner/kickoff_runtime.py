from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from .codex_worker import CodexWorkerError, generate_json_with_codex_mcp
from .http_client import BackendClient, HttpError
from .kickoff import KickoffError, kickoff_plan_to_plan_apply_draft, validate_kickoff_plan
from .promotion import (
    MalformedSprintDataError,
    SanitizationRegenExhaustedError,
    SanitizationRegenHandoffRequestedError,
    maybe_autopromote_ready,
    extract_scope_plan,
)
from .telemetry import publish_transcript_event


def _log_stderr(payload: dict[str, Any]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


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


def build_kickoff_prompt(*, sprint: str, goal_text: str, ready_limit: int) -> Tuple[str, str]:
    schema = (
        "{\n"
        f'  "sprint": "{sprint}",\n'
        '  "goal_issue": {\n'
        f'    "title": "[SPRINT GOAL] {sprint}: <short>",\n'
        '    "body_markdown": "<markdown>",\n'
        '    "labels": ["meta:sprint-goal"],\n'
        f'    "fields": {{"Sprint":"{sprint}","Status":"Backlog","Priority":"P0","Size":"S","Area":"docs"}}\n'
        "  },\n"
        '  "tasks": [\n'
        "    {\n"
        '      "title": "[TASK] <short>",\n'
        '      "body_markdown": "<markdown>",\n'
        '      "priority": "P0|P1|P2",\n'
        '      "size": "S|M|L",\n'
        '      "area": "infra|api|orchestrator|runner|docs|tests",\n'
        '      "depends_on_titles": ["[TASK] ..."],\n'
        '      "initial_status": "Backlog"\n'
        "    }\n"
        "  ],\n"
        '  "ready_set_titles": ["[TASK] ..."],\n'
        '  "prioritization_rationale": "..."\n'
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
        "- Tasks MUST implement goal.txt in code. Do not create process/runbook/template tasks unless goal.txt is about process tooling."
        "Do NOT create meta-process tasks like: defining templates, writing runbooks, creating a backlog map, or drafting reviewer/executor checklists.\n"
        "- Do NOT make the sprint about improving this orchestration system; the sprint is about implementing the goal in the target repository.\n"
        "- The sprint goal issue may touch docs, but sprint tasks should generally touch real product code/assets, not just markdown.\n"
        "- ready_set_titles should include the most dependency-free P0 implementation tasks.\n\n"
        "Product Management Heuristics:\n"
        "- Treat the goal as incomplete; infer and include implied standard features required for a complete user experience.\n"
        "- Anticipate edge cases and non-happy paths and bake them into tasks and acceptance criteria.\n"
        "- Ensure the plan covers any missing CRUD surfaces and lifecycle flows needed for the feature to be usable end-to-end.\n\n"
        "Architectural Best Practices:\n"
        "- Acceptance criteria for each task must reflect senior engineering standards: strict data type safety, clear API/data contracts, validation, security/authorization, observability, and automated tests.\n"
        "- Prefer clean interfaces and separation of concerns; avoid tight coupling and ad hoc one-off logic.\n"
        "- Make failure modes explicit and safe.\n\n"
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


@dataclass(frozen=True)
class KickoffResult:
    run_id: str
    sprint: str
    plan: Dict[str, Any]
    draft: Dict[str, Any]
    apply_result: Dict[str, Any]


def _apply_kickoff_plan(
    *,
    backend: BackendClient,
    plan: Dict[str, Any],
    draft: Dict[str, Any],
    dry_run: bool,
    ready_target: int,
    sanitization_regen_attempts: int,
    orchestrator_state_path: str,
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

    tasks_plan: list[Dict[str, Any]] = []
    tasks_by_title = {t.get("title"): t for t in (plan.get("tasks") or []) if isinstance(t, dict)}
    for idx, issue in enumerate(issues):
        if idx == 0:
            continue
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

    plan_cache: Dict[str, Any] = {
        "version": 1,
        "sprint": draft.get("sprint"),
        "tasks": tasks_plan,
        "ready_set_titles": ready_titles,
        "sprint_plan": sprint_scope_plan,
        "ownership_index": ownership_index,
    }

    promoted: List[Dict[str, Any]] = []
    scope_plan = extract_scope_plan(plan_cache)
    title_to_issue_number = {t.get("title"): t.get("issue_number") for t in tasks_plan if isinstance(t, dict)}
    status_by_issue = {
        t.get("issue_number"): "Backlog" for t in tasks_plan if isinstance(t, dict) and isinstance(t.get("issue_number"), int)
    }
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
        status_by_issue[issue_number] = "Ready"
        if isinstance(meta, dict):
            owns_paths = meta.get("owns_paths") if isinstance(meta.get("owns_paths"), list) else []
            for owned in owns_paths:
                normalized = _normalize_scope_path(owned)
                if normalized:
                    reserved.append((issue_number, normalized))

    if not promoted:
        processed_items: list[dict[str, Any]] = []
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
        maybe_autopromote_ready(
            summary=fallback_summary,
            sprint_plan=plan_cache,
            backend=backend,
            dry_run=False,
            ready_target=int(ready_target),
            sanitization_regen_attempts=int(sanitization_regen_attempts),
            orchestrator_state_path=orchestrator_state_path,
        )

    return {"status": "APPLIED", "plan_apply": apply_payload, "promoted": promoted}


def run_kickoff(
    *,
    backend: BackendClient,
    redis_client: Any,
    repo_root: str,
    codex_bin: str,
    codex_mcp_args: str,
    codex_tools_call_timeout_s: float,
    sprint: str,
    goal_text: str,
    ready_limit: int,
    require_verification: bool,
    dry_run: bool,
    sanitization_regen_attempts: int,
    orchestrator_state_path: str,
) -> KickoffResult:
    normalized_sprint = str(sprint or "").strip()
    if normalized_sprint not in {"M1", "M2", "M3", "M4"}:
        raise KickoffError("sprint must be one of M1, M2, M3, M4", code="kickoff_invalid_sprint", details={"sprint": sprint})
    normalized_goal = str(goal_text or "").strip()
    if not normalized_goal:
        raise KickoffError("kickoff goal is missing", code="kickoff_goal_missing")

    run_id = f"kickoff-{uuid4()}"

    bundle = backend.get_agent_context("ORCHESTRATOR")
    prompt, developer_instructions = build_kickoff_prompt(sprint=normalized_sprint, goal_text=normalized_goal, ready_limit=int(ready_limit))

    def transcript_sink(section: str, content: str) -> None:
        publish_transcript_event(
            redis_client=redis_client,
            run_id=run_id,
            role="ORCHESTRATOR",
            section=section,
            content=content,
        )

    kickoff_raw = generate_json_with_codex_mcp(
        codex_bin=codex_bin,
        codex_mcp_args=codex_mcp_args,
        role_bundle=bundle,
        prompt=prompt,
        developer_instructions=developer_instructions,
        sandbox="read-only",
        approval_policy="never",
        tools_call_timeout_s=codex_tools_call_timeout_s,
        run_id=run_id,
        repo_root=repo_root,
        transcript_event_sink=transcript_sink,
    )

    kickoff_plan = validate_kickoff_plan(kickoff_raw, sprint=normalized_sprint, ready_limit=int(ready_limit))
    draft = kickoff_plan_to_plan_apply_draft(kickoff_plan)
    draft["require_verification"] = bool(require_verification)
    _log_stderr({"type": "KICKOFF_PLAN", "run_id": run_id, "plan": kickoff_plan})
    _log_stderr({"type": "KICKOFF_DRAFT", "run_id": run_id, "draft": draft})

    try:
        apply_result = _apply_kickoff_plan(
            backend=backend,
            plan=kickoff_plan,
            draft=draft,
            dry_run=dry_run,
            ready_target=int(ready_limit),
            sanitization_regen_attempts=int(sanitization_regen_attempts),
            orchestrator_state_path=orchestrator_state_path,
        )
    except HttpError as exc:
        raise KickoffError(
            "kickoff backend request failed",
            code="kickoff_backend_error",
            details={"code": exc.code, "status_code": exc.status_code, "payload": exc.payload},
        ) from None

    _log_stderr({"type": "KICKOFF_RESULT", "run_id": run_id, **apply_result})
    return KickoffResult(run_id=run_id, sprint=normalized_sprint, plan=kickoff_plan, draft=draft, apply_result=apply_result)

