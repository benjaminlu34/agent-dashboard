from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


VALID_SPRINTS = {"M1", "M2", "M3", "M4"}
VALID_PRIORITIES = {"P0", "P1", "P2"}
VALID_SIZES = {"S", "M", "L"}
VALID_TASK_AREAS = {"infra", "api", "orchestrator", "runner", "docs", "tests"}
VALID_POLICY_AREAS = {"db", "api", "web", "providers", "infra", "docs"}

_AUTO_CLOSE_RE = re.compile(r"\b(?:closes|closed|fixes|fixed|resolves|resolved)\s*#\d+\b", re.IGNORECASE)
_TASK_TITLE_RE = re.compile(r"^\[TASK\]\s+\S")
_GOAL_TITLE_RE = re.compile(r"^\[SPRINT GOAL\]\s+(M1|M2|M3|M4):\s+\S")


class KickoffError(Exception):
    def __init__(self, message: str, *, code: str = "kickoff_invalid", details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class ParsedIssueBody:
    goal: str
    non_goals: List[str]
    acceptance_criteria: List[str]
    files_likely_touched: List[str]
    definition_of_done: List[str]


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _require_non_empty_string(value: Any, *, field: str) -> str:
    if not _is_non_empty_string(value):
        raise KickoffError(f"{field} must be a non-empty string", code="kickoff_invalid_field", details={"field": field})
    return value.strip()


def _require_string_list(value: Any, *, field: str, allow_empty: bool = False) -> List[str]:
    if not isinstance(value, list):
        raise KickoffError(f"{field} must be an array of strings", code="kickoff_invalid_field", details={"field": field})
    out: List[str] = []
    for idx, entry in enumerate(value):
        if not _is_non_empty_string(entry):
            raise KickoffError(
                f"{field}[{idx}] must be a non-empty string",
                code="kickoff_invalid_field",
                details={"field": field, "index": idx},
            )
        out.append(entry.strip())
    if not allow_empty and not out:
        raise KickoffError(f"{field} must be a non-empty array", code="kickoff_invalid_field", details={"field": field})
    return out


def _assert_no_autoclose(text: str, *, where: str) -> None:
    match = _AUTO_CLOSE_RE.search(text)
    if match:
        raise KickoffError(
            "auto-close keyword detected (forbidden)",
            code="kickoff_forbidden_autoclose",
            details={"where": where, "match": match.group(0)},
        )


def _split_markdown_sections(markdown: str) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {}
    current: Optional[str] = None

    for raw_line in markdown.splitlines():
        line = raw_line.rstrip()
        if line.startswith("## "):
            current = line[3:].strip().lower()
            sections.setdefault(current, [])
            continue
        if current is None:
            continue
        sections[current].append(line)

    return sections


def _parse_list_items(lines: Sequence[str]) -> List[str]:
    items: List[str] = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("- [ ] "):
            items.append(line[len("- [ ] ") :].strip())
        elif line.startswith("- [x] ") or line.startswith("- [X] "):
            items.append(line[len("- [x] ") :].strip())
        elif line.startswith("- "):
            items.append(line[len("- ") :].strip())
        elif line.startswith("* "):
            items.append(line[len("* ") :].strip())
    return [item for item in items if item]


def parse_issue_body_markdown(body_markdown: str) -> ParsedIssueBody:
    if not _is_non_empty_string(body_markdown):
        raise KickoffError("body_markdown must be a non-empty string", code="kickoff_invalid_body_markdown")

    sections = _split_markdown_sections(body_markdown)

    def require_section(name: str) -> List[str]:
        key = name.lower()
        if key not in sections:
            raise KickoffError(
                f"body_markdown missing required section: {name}",
                code="kickoff_body_markdown_missing_section",
                details={"section": name},
            )
        return sections[key]

    goal_lines = require_section("Goal")
    goal = "\n".join([line for line in goal_lines]).strip()
    if not goal:
        raise KickoffError("body_markdown Goal section must not be empty", code="kickoff_body_markdown_invalid")

    non_goals = _parse_list_items(require_section("Non-goals"))
    acceptance = _parse_list_items(require_section("Acceptance Criteria"))
    files = _parse_list_items(require_section("Files Likely Touched"))
    dod = _parse_list_items(require_section("Definition of Done"))

    for field_name, items in (
        ("Non-goals", non_goals),
        ("Acceptance Criteria", acceptance),
        ("Files Likely Touched", files),
        ("Definition of Done", dod),
    ):
        if not items:
            raise KickoffError(
                f"body_markdown section must have at least one list item: {field_name}",
                code="kickoff_body_markdown_invalid",
                details={"section": field_name},
            )

    return ParsedIssueBody(
        goal=goal,
        non_goals=non_goals,
        acceptance_criteria=acceptance,
        files_likely_touched=files,
        definition_of_done=dod,
    )


def map_task_area_to_policy_area(area: str) -> str:
    normalized = area.strip().lower()
    if normalized in ("infra", "orchestrator", "runner", "tests"):
        return "infra"
    if normalized in ("api", "docs"):
        return normalized
    raise KickoffError(
        "task area is not supported",
        code="kickoff_invalid_area",
        details={"area": area, "allowed": sorted(VALID_TASK_AREAS)},
    )


def validate_kickoff_plan(plan: Any, *, sprint: str, ready_limit: int) -> Dict[str, Any]:
    if sprint not in VALID_SPRINTS:
        raise KickoffError("sprint must be one of M1, M2, M3, M4", code="kickoff_invalid_sprint", details={"sprint": sprint})
    if not isinstance(ready_limit, int) or ready_limit < 1 or ready_limit > 3:
        raise KickoffError(
            "ready_limit must be an integer between 1 and 3",
            code="kickoff_invalid_ready_limit",
            details={"ready_limit": ready_limit},
        )

    if not isinstance(plan, dict):
        raise KickoffError("kickoff plan must be a JSON object", code="kickoff_invalid")

    plan_sprint = _require_non_empty_string(plan.get("sprint"), field="sprint")
    if plan_sprint != sprint:
        raise KickoffError(
            "kickoff plan sprint mismatch",
            code="kickoff_sprint_mismatch",
            details={"expected": sprint, "actual": plan_sprint},
        )

    goal_issue = plan.get("goal_issue")
    if not isinstance(goal_issue, dict):
        raise KickoffError("goal_issue must be an object", code="kickoff_invalid_field", details={"field": "goal_issue"})

    goal_title = _require_non_empty_string(goal_issue.get("title"), field="goal_issue.title")
    if not _GOAL_TITLE_RE.match(goal_title):
        raise KickoffError(
            "goal_issue.title must match '[SPRINT GOAL] Mx: <short>'",
            code="kickoff_invalid_goal_title",
            details={"title": goal_title},
        )

    goal_body_markdown = _require_non_empty_string(goal_issue.get("body_markdown"), field="goal_issue.body_markdown")
    goal_labels = _require_string_list(goal_issue.get("labels"), field="goal_issue.labels", allow_empty=False)
    if "meta:sprint-goal" not in {label.strip() for label in goal_labels}:
        raise KickoffError(
            "goal_issue.labels must include meta:sprint-goal",
            code="kickoff_missing_goal_label",
            details={"labels": goal_labels},
        )

    goal_fields = goal_issue.get("fields")
    if not isinstance(goal_fields, dict):
        raise KickoffError("goal_issue.fields must be an object", code="kickoff_invalid_field", details={"field": "goal_issue.fields"})

    expected_goal_fields = {"Sprint": sprint, "Status": "Backlog", "Priority": "P0", "Size": "S", "Area": "docs"}
    for key, expected in expected_goal_fields.items():
        actual = goal_fields.get(key)
        if actual != expected:
            raise KickoffError(
                "goal_issue.fields mismatch",
                code="kickoff_invalid_goal_fields",
                details={"field": key, "expected": expected, "actual": actual},
            )

    tasks = plan.get("tasks")
    if not isinstance(tasks, list):
        raise KickoffError("tasks must be an array", code="kickoff_invalid_field", details={"field": "tasks"})
    if len(tasks) < 3 or len(tasks) > 25:
        raise KickoffError(
            "tasks length must be between 3 and 25",
            code="kickoff_invalid_task_count",
            details={"count": len(tasks)},
        )

    normalized_tasks: List[Dict[str, Any]] = []
    task_titles: List[str] = []

    for idx, task in enumerate(tasks):
        if not isinstance(task, dict):
            raise KickoffError("task must be an object", code="kickoff_invalid_task", details={"index": idx})

        title = _require_non_empty_string(task.get("title"), field=f"tasks[{idx}].title")
        if not _TASK_TITLE_RE.match(title):
            raise KickoffError(
                "task title must start with '[TASK] '",
                code="kickoff_invalid_task_title",
                details={"index": idx, "title": title},
            )

        body_markdown = _require_non_empty_string(task.get("body_markdown"), field=f"tasks[{idx}].body_markdown")

        priority = _require_non_empty_string(task.get("priority"), field=f"tasks[{idx}].priority")
        if priority not in VALID_PRIORITIES:
            raise KickoffError(
                "task priority must be P0, P1, or P2",
                code="kickoff_invalid_priority",
                details={"index": idx, "priority": priority},
            )

        size = _require_non_empty_string(task.get("size"), field=f"tasks[{idx}].size")
        if size not in VALID_SIZES:
            raise KickoffError("task size must be S, M, or L", code="kickoff_invalid_size", details={"index": idx, "size": size})

        area = _require_non_empty_string(task.get("area"), field=f"tasks[{idx}].area").lower()
        if area not in VALID_TASK_AREAS:
            raise KickoffError(
                "task area is invalid",
                code="kickoff_invalid_area",
                details={"index": idx, "area": area, "allowed": sorted(VALID_TASK_AREAS)},
            )

        depends = _require_string_list(task.get("depends_on_titles", []), field=f"tasks[{idx}].depends_on_titles", allow_empty=True)
        initial_status = _require_non_empty_string(task.get("initial_status"), field=f"tasks[{idx}].initial_status")
        if initial_status != "Backlog":
            raise KickoffError(
                "tasks must start in Backlog",
                code="kickoff_invalid_initial_status",
                details={"index": idx, "initial_status": initial_status},
            )

        task_titles.append(title)
        normalized_tasks.append(
            {
                "title": title,
                "body_markdown": body_markdown,
                "priority": priority,
                "size": size,
                "area": area,
                "depends_on_titles": depends,
                "initial_status": initial_status,
            }
        )

    if len(set(task_titles)) != len(task_titles):
        raise KickoffError("task titles must be unique", code="kickoff_title_collision")

    titles_set = set(task_titles)
    for idx, task in enumerate(normalized_tasks):
        for dep_title in task["depends_on_titles"]:
            if dep_title not in titles_set:
                raise KickoffError(
                    "dependency title not found in tasks",
                    code="kickoff_unknown_dependency",
                    details={"index": idx, "depends_on_title": dep_title},
                )
            if dep_title == task["title"]:
                raise KickoffError("task cannot depend on itself", code="kickoff_invalid_dependency", details={"index": idx})

    ready_set_titles = _require_string_list(plan.get("ready_set_titles", []), field="ready_set_titles", allow_empty=True)
    if len(ready_set_titles) > ready_limit:
        raise KickoffError(
            "ready_set_titles length exceeds ready_limit",
            code="kickoff_ready_set_too_large",
            details={"ready_limit": ready_limit, "count": len(ready_set_titles)},
        )
    if len(set(ready_set_titles)) != len(ready_set_titles):
        raise KickoffError("ready_set_titles must be unique", code="kickoff_ready_set_duplicate")

    task_by_title = {task["title"]: task for task in normalized_tasks}
    for title in ready_set_titles:
        if title not in task_by_title:
            raise KickoffError(
                "ready_set_titles references an unknown task title",
                code="kickoff_ready_set_unknown_title",
                details={"title": title},
            )
        task = task_by_title[title]
        if task["depends_on_titles"]:
            raise KickoffError(
                "ready_set_titles must reference dependency-free tasks only",
                code="kickoff_ready_set_has_dependencies",
                details={"title": title, "depends_on_titles": task["depends_on_titles"]},
            )
        if task["priority"] != "P0":
            raise KickoffError(
                "ready_set_titles must reference P0 tasks only",
                code="kickoff_ready_set_not_p0",
                details={"title": title, "priority": task["priority"]},
            )

    prioritization_rationale = _require_non_empty_string(plan.get("prioritization_rationale"), field="prioritization_rationale")

    # Auto-close keyword rejection (global).
    _assert_no_autoclose(goal_title, where="goal_issue.title")
    _assert_no_autoclose(goal_body_markdown, where="goal_issue.body_markdown")
    for idx, task in enumerate(normalized_tasks):
        _assert_no_autoclose(task["title"], where=f"tasks[{idx}].title")
        _assert_no_autoclose(task["body_markdown"], where=f"tasks[{idx}].body_markdown")
    _assert_no_autoclose(prioritization_rationale, where="prioritization_rationale")

    return {
        "sprint": plan_sprint,
        "goal_issue": {
            "title": goal_title,
            "body_markdown": goal_body_markdown,
            "labels": goal_labels,
            "fields": dict(goal_fields),
        },
        "tasks": normalized_tasks,
        "ready_set_titles": ready_set_titles,
        "prioritization_rationale": prioritization_rationale,
    }


def kickoff_plan_to_plan_apply_draft(plan: Dict[str, Any]) -> Dict[str, Any]:
    sprint = plan["sprint"]

    goal_issue = plan["goal_issue"]
    goal_parsed = parse_issue_body_markdown(goal_issue["body_markdown"])

    issues: List[Dict[str, Any]] = [
        {
            "title": goal_issue["title"],
            "goal": goal_parsed.goal,
            "non_goals": goal_parsed.non_goals,
            "acceptance_criteria": goal_parsed.acceptance_criteria,
            "files_likely_touched": goal_parsed.files_likely_touched,
            "definition_of_done": goal_parsed.definition_of_done,
            "size": goal_issue["fields"]["Size"],
            "area": goal_issue["fields"]["Area"],
            "priority": goal_issue["fields"]["Priority"],
            "initial_status": "Backlog",
            "labels": goal_issue["labels"],
        }
    ]

    for task in plan["tasks"]:
        parsed = parse_issue_body_markdown(task["body_markdown"])
        issues.append(
            {
                "title": task["title"],
                "goal": parsed.goal,
                "non_goals": parsed.non_goals,
                "acceptance_criteria": parsed.acceptance_criteria,
                "files_likely_touched": parsed.files_likely_touched,
                "definition_of_done": parsed.definition_of_done,
                "size": task["size"],
                "area": map_task_area_to_policy_area(task["area"]),
                "priority": task["priority"],
                "initial_status": task["initial_status"],
            }
        )

    # Runner-level sanity check: ensure all resulting areas conform to the backend policy contract.
    for idx, issue in enumerate(issues):
        area = issue.get("area")
        if area not in VALID_POLICY_AREAS:
            raise KickoffError(
                "draft issue area is not allowed by backend policy",
                code="kickoff_invalid_policy_area",
                details={"index": idx, "area": area, "allowed": sorted(VALID_POLICY_AREAS)},
            )

    return {
        "sprint": sprint,
        "issues": issues,
    }

