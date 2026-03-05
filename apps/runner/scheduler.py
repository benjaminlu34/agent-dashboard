from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import uuid
from typing import Any, Callable, Dict, Optional


INTENT_TYPE = "RUN_INTENT"


class SchedulerError(Exception):
    def __init__(self, message: str, *, code: str = "scheduler_error"):
        super().__init__(message)
        self.code = code


def _malformed_item_error(message: str) -> SchedulerError:
    return SchedulerError(message, code="malformed_item_data")


def _has_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def _format_iso(dt: datetime) -> str:
    normalized = dt.astimezone(timezone.utc)
    return normalized.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_iso_dt(value: Any) -> Optional[datetime]:
    if not _has_non_empty_string(value):
        return None
    raw = str(value).strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def to_iso_timestamp(value: Any) -> str:
    parsed = _parse_iso_dt(value)
    if parsed is None:
        return ""
    return _format_iso(parsed)


def minutes_between(start_iso: Any, end_iso: Any) -> int:
    start_dt = _parse_iso_dt(start_iso)
    end_dt = _parse_iso_dt(end_iso)
    if start_dt is None or end_dt is None:
        return 0
    diff = end_dt - start_dt
    if diff.total_seconds() <= 0:
        return 0
    return int(diff.total_seconds() // 60)


def is_after_iso(left_iso: Any, right_iso: Any) -> bool:
    left_dt = _parse_iso_dt(left_iso)
    right_dt = _parse_iso_dt(right_iso)
    if left_dt is None or right_dt is None:
        return False
    return left_dt > right_dt


def _assert_positive_int(value: Any, name: str) -> int:
    if not isinstance(value, int) or value <= 0:
        raise SchedulerError(f"{name} must be a positive integer")
    return value


def _normalize_state(previous_state: Any) -> dict[str, Any]:
    if not isinstance(previous_state, dict):
        return {"poll_count": 0, "items": {}}
    poll_count = previous_state.get("poll_count")
    poll_count = poll_count if isinstance(poll_count, int) and poll_count >= 0 else 0
    items = previous_state.get("items")
    items = items if isinstance(items, dict) else {}
    return {"poll_count": poll_count, "items": items}


def _compare_scoped_items(left: dict[str, Any], right: dict[str, Any]) -> int:
    left_issue = left.get("issue_number")
    right_issue = right.get("issue_number")
    if isinstance(left_issue, int) and isinstance(right_issue, int) and left_issue != right_issue:
        return left_issue - right_issue
    return str(left.get("project_item_id") or "").__lt__(str(right.get("project_item_id") or ""))


def _normalize_issue_title(item: dict[str, Any], previous: dict[str, Any]) -> str:
    if _has_non_empty_string(item.get("issue_title")):
        return str(item.get("issue_title") or "").strip()
    if _has_non_empty_string(previous.get("last_seen_issue_title")):
        return str(previous.get("last_seen_issue_title") or "").strip()
    return ""


def _update_seen_state(
    *,
    state_by_item_id: dict[str, dict[str, Any]],
    item: dict[str, Any],
    status: str,
    sprint: str,
    now_iso: str,
    poll_count: int,
) -> dict[str, Any]:
    project_item_id = str(item.get("project_item_id") or "")
    previous = state_by_item_id.get(project_item_id, {})

    issue_title = _normalize_issue_title(item, previous)
    status_changed = previous.get("last_seen_status") != status
    status_since_at = now_iso if status_changed else (to_iso_timestamp(previous.get("status_since_at")) or now_iso)
    status_since_poll = poll_count if status_changed else (
        previous.get("status_since_poll") if isinstance(previous.get("status_since_poll"), int) else poll_count
    )
    last_activity_at = now_iso if status_changed else (to_iso_timestamp(previous.get("last_activity_at")) or status_since_at)
    last_activity_indicator = "status_changed" if status_changed else (previous.get("last_activity_indicator") or "status_unchanged")

    reviewer_dispatches_for_current_status = 0
    if not status_changed and isinstance(previous.get("reviewer_dispatches_for_current_status"), int):
        reviewer_dispatches_for_current_status = int(previous.get("reviewer_dispatches_for_current_status"))

    review_cycle_count = 0
    if (
        not status_changed
        and isinstance(previous.get("review_cycle_count"), int)
        and int(previous.get("review_cycle_count")) >= 0
    ):
        review_cycle_count = int(previous.get("review_cycle_count"))

    last_reviewer_outcome = ""
    if not status_changed and _has_non_empty_string(previous.get("last_reviewer_outcome")):
        last_reviewer_outcome = str(previous.get("last_reviewer_outcome") or "").strip().upper()

    last_reviewer_feedback_at = "" if status_changed else to_iso_timestamp(previous.get("last_reviewer_feedback_at"))
    last_executor_response_at = "" if status_changed else to_iso_timestamp(previous.get("last_executor_response_at"))

    previous_in_review_origin = str(previous.get("in_review_origin") or "").strip() if _has_non_empty_string(previous.get("in_review_origin")) else ""
    if status == "In Review":
        if status_changed:
            in_review_origin = "needs_human_approval" if previous.get("last_seen_status") == "Needs Human Approval" else ""
        else:
            in_review_origin = previous_in_review_origin
    else:
        in_review_origin = ""

    state_by_item_id[project_item_id] = {
        "last_seen_status": status,
        "last_seen_sprint": sprint,
        "last_seen_issue_number": item.get("issue_number"),
        "last_seen_issue_title": issue_title,
        "last_seen_at": now_iso,
        "status_since_at": status_since_at,
        "status_since_poll": status_since_poll,
        "last_activity_at": last_activity_at,
        "last_activity_indicator": last_activity_indicator,
        "last_dispatched_role": str(previous.get("last_dispatched_role") or "") if _has_non_empty_string(previous.get("last_dispatched_role")) else "",
        "last_dispatched_status": str(previous.get("last_dispatched_status") or "") if _has_non_empty_string(previous.get("last_dispatched_status")) else "",
        "last_dispatched_at": to_iso_timestamp(previous.get("last_dispatched_at")),
        "last_dispatched_poll": int(previous.get("last_dispatched_poll"))
        if isinstance(previous.get("last_dispatched_poll"), int) and int(previous.get("last_dispatched_poll")) >= 0
        else 0,
        "last_run_id": str(previous.get("last_run_id") or "") if _has_non_empty_string(previous.get("last_run_id")) else "",
        "reviewer_dispatches_for_current_status": reviewer_dispatches_for_current_status,
        "review_cycle_count": review_cycle_count,
        "last_reviewer_outcome": last_reviewer_outcome,
        "last_reviewer_feedback_at": last_reviewer_feedback_at,
        "last_executor_response_at": last_executor_response_at,
        "in_review_origin": in_review_origin,
    }

    return state_by_item_id[project_item_id]


def _mark_dispatched(*, state_item: dict[str, Any], role: str, status: str, run_id: str, now_iso: str, poll_count: int) -> None:
    state_item["last_dispatched_role"] = role
    state_item["last_dispatched_status"] = status
    state_item["last_dispatched_at"] = now_iso
    state_item["last_dispatched_poll"] = poll_count
    state_item["last_run_id"] = run_id
    if role == "REVIEWER" and status == "In Review":
        state_item["reviewer_dispatches_for_current_status"] = int(state_item.get("reviewer_dispatches_for_current_status") or 0) + 1


def _build_dispatch_body(*, role: str, run_id: str, sprint: str, issue_number: int, endpoint: str) -> dict[str, Any]:
    if role == "EXECUTOR" and endpoint == "/internal/executor/claim-ready-item":
        return {"role": role, "run_id": run_id, "sprint": sprint}
    return {"role": role, "issue_number": issue_number, "run_id": run_id}


@dataclass(frozen=True)
class RunPlan:
    intents: list[dict[str, Any]]
    next_state: dict[str, Any]
    summary: dict[str, Any]
    completed: bool


def build_run_plan(
    *,
    project_items: list[dict[str, Any]],
    allowed_status_options: list[str],
    max_executors: int = 1,
    max_reviewers: int = 1,
    sprint: str,
    previous_state: Optional[dict[str, Any]] = None,
    uuid_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
    now_iso: str,
    stall_minutes: int = 120,
    review_churn_polls: int = 3,
    max_reviewer_dispatches_per_status: int = 1,
    reviewer_retry_polls: int = 0,
    executor_retry_polls: int = 0,
    max_review_cycles: int = 5,
) -> RunPlan:
    if not isinstance(project_items, list):
        raise SchedulerError("project_items must be an array")
    if not isinstance(allowed_status_options, list) or len(allowed_status_options) == 0:
        raise SchedulerError("allowed_status_options must be a non-empty array")
    if not _has_non_empty_string(sprint):
        raise SchedulerError("sprint is required")

    _assert_positive_int(max_executors, "max_executors")
    _assert_positive_int(max_reviewers, "max_reviewers")
    _assert_positive_int(stall_minutes, "stall_minutes")
    _assert_positive_int(review_churn_polls, "review_churn_polls")
    _assert_positive_int(max_reviewer_dispatches_per_status, "max_reviewer_dispatches_per_status")
    _assert_positive_int(max_review_cycles, "max_review_cycles")
    if not isinstance(reviewer_retry_polls, int) or reviewer_retry_polls < 0:
        raise SchedulerError("reviewer_retry_polls must be a non-negative integer")
    if not isinstance(executor_retry_polls, int) or executor_retry_polls < 0:
        raise SchedulerError("executor_retry_polls must be a non-negative integer")

    normalized_now_iso = to_iso_timestamp(now_iso)
    if not normalized_now_iso:
        raise SchedulerError("now_iso must be a valid ISO timestamp")

    normalized_sprint = str(sprint).strip()
    allowed_statuses = set(allowed_status_options)
    previous = _normalize_state(previous_state)
    poll_count = int(previous["poll_count"]) + 1
    next_state = {"poll_count": poll_count, "items": {**previous["items"]}}

    summary: dict[str, Any] = {
        "sprint": normalized_sprint,
        "poll_count": poll_count,
        "in_scope_total": 0,
        "status_counts": {
            "Backlog": 0,
            "Ready": 0,
            "In Progress": 0,
            "In Review": 0,
            "Needs Human Approval": 0,
            "Blocked": 0,
            "Done": 0,
        },
        "intents_emitted": {"EXECUTOR": 0, "REVIEWER": 0, "total": 0},
        "skipped": {"not_in_scope": 0, "dedupe_same_status": 0, "concurrency_limit": 0},
        "needs_attention": {"stalled_in_progress": [], "in_review_churn": []},
        "processed_items": [],
    }

    scoped_items: list[dict[str, Any]] = []

    for item in project_items:
        if not isinstance(item, dict):
            raise _malformed_item_error("project item must be an object")

        issue_number = item.get("issue_number")
        if not isinstance(issue_number, int) or issue_number <= 0:
            raise _malformed_item_error("project item issue_number must be a positive integer")

        project_item_id = item.get("project_item_id")
        if not _has_non_empty_string(project_item_id):
            raise _malformed_item_error(f"project item {issue_number} missing project_item_id")

        item_sprint = item.get("sprint")
        if not _has_non_empty_string(item_sprint):
            fields = item.get("fields") if isinstance(item.get("fields"), dict) else {}
            item_sprint = fields.get("Sprint") if isinstance(fields, dict) else None
        if not _has_non_empty_string(item_sprint):
            raise _malformed_item_error(f"project item {issue_number} missing Sprint")

        if str(item_sprint) != normalized_sprint:
            summary["skipped"]["not_in_scope"] += 1
            continue

        status = item.get("status")
        if not _has_non_empty_string(status):
            fields = item.get("fields") if isinstance(item.get("fields"), dict) else {}
            status = fields.get("Status") if isinstance(fields, dict) else None
        if not _has_non_empty_string(status):
            raise _malformed_item_error(f"project item {issue_number} missing Status")

        status = str(status)
        if status not in allowed_statuses:
            raise _malformed_item_error(f"project item {issue_number} has unknown Status={status}")

        summary["in_scope_total"] += 1
        summary["status_counts"][status] += 1

        _update_seen_state(
            state_by_item_id=next_state["items"],
            item=item,
            status=status,
            sprint=normalized_sprint,
            now_iso=normalized_now_iso,
            poll_count=poll_count,
        )

        scoped_items.append(
            {
                "project_item_id": str(project_item_id),
                "issue_number": issue_number,
                "issue_url": item.get("issue_url"),
                "status": status,
                "sprint": normalized_sprint,
            }
        )

    scoped_items = sorted(
        scoped_items,
        key=lambda entry: (entry.get("issue_number") or 0, str(entry.get("project_item_id") or "")),
    )

    intents: list[dict[str, Any]] = []

    def maybe_dispatch(item: dict[str, Any], role: str, endpoint: str, max_count: int) -> bool:
        state_item = next_state["items"][item["project_item_id"]]
        was_dispatched_for_current_status_since_last_change = (
            state_item.get("last_dispatched_role") == role
            and state_item.get("last_dispatched_status") == item["status"]
            and int(state_item.get("last_dispatched_poll") or 0) >= int(state_item.get("status_since_poll") or 0)
        )

        if was_dispatched_for_current_status_since_last_change:
            can_retry_reviewer = (
                role == "REVIEWER"
                and item["status"] == "In Review"
                and int(state_item.get("reviewer_dispatches_for_current_status") or 0) < max_reviewer_dispatches_per_status
                and poll_count - int(state_item.get("last_dispatched_poll") or 0) >= reviewer_retry_polls
            )
            can_retry_executor = (
                role == "EXECUTOR"
                and item["status"] == "Ready"
                and executor_retry_polls > 0
                and poll_count - int(state_item.get("last_dispatched_poll") or 0) >= executor_retry_polls
            )
            if not can_retry_reviewer and not can_retry_executor:
                summary["skipped"]["dedupe_same_status"] += 1
                return False

        if int(summary["intents_emitted"][role]) >= max_count:
            summary["skipped"]["concurrency_limit"] += 1
            return False

        run_id = uuid_factory()
        body = _build_dispatch_body(
            role=role,
            run_id=run_id,
            sprint=normalized_sprint,
            issue_number=item["issue_number"],
            endpoint=endpoint,
        )

        intents.append({"type": INTENT_TYPE, "role": role, "run_id": run_id, "endpoint": endpoint, "body": body})

        _mark_dispatched(
            state_item=state_item,
            role=role,
            status=item["status"],
            run_id=run_id,
            now_iso=normalized_now_iso,
            poll_count=poll_count,
        )

        summary["intents_emitted"][role] += 1
        summary["intents_emitted"]["total"] += 1
        return True

    for item in scoped_items:
        if item["status"] == "Ready":
            maybe_dispatch(item, "EXECUTOR", "/internal/executor/claim-ready-item", max_executors)
            continue

        if item["status"] == "In Review":
            state_item = next_state["items"][item["project_item_id"]]
            last_outcome = (
                str(state_item.get("last_reviewer_outcome") or "").strip().upper()
                if _has_non_empty_string(state_item.get("last_reviewer_outcome"))
                else ""
            )
            review_cycle_count = int(state_item.get("review_cycle_count") or 0) if isinstance(state_item.get("review_cycle_count"), int) else 0
            in_review_origin = str(state_item.get("in_review_origin") or "").strip() if _has_non_empty_string(state_item.get("in_review_origin")) else ""
            has_executor_response = _has_non_empty_string(state_item.get("last_executor_response_at"))

            if last_outcome == "PASS":
                continue
            if review_cycle_count >= max_review_cycles:
                continue

            if in_review_origin == "needs_human_approval" and not _has_non_empty_string(last_outcome):
                if not has_executor_response:
                    maybe_dispatch(item, "EXECUTOR", "/internal/reviewer/resolve-linked-pr", max_executors)
                else:
                    dispatched = maybe_dispatch(item, "REVIEWER", "/internal/reviewer/resolve-linked-pr", max_reviewers)
                    if dispatched:
                        state_item["in_review_origin"] = ""
                continue

            has_reviewer_feedback = _has_non_empty_string(state_item.get("last_reviewer_feedback_at"))
            executor_responded_after_feedback = (
                has_reviewer_feedback
                and has_executor_response
                and is_after_iso(state_item.get("last_executor_response_at"), state_item.get("last_reviewer_feedback_at"))
            )

            if not _has_non_empty_string(last_outcome):
                maybe_dispatch(item, "REVIEWER", "/internal/reviewer/resolve-linked-pr", max_reviewers)
                continue

            if last_outcome in ("FAIL", "INCOMPLETE"):
                if not executor_responded_after_feedback:
                    maybe_dispatch(item, "EXECUTOR", "/internal/reviewer/resolve-linked-pr", max_executors)
                else:
                    maybe_dispatch(item, "REVIEWER", "/internal/reviewer/resolve-linked-pr", max_reviewers)

    for item in scoped_items:
        state_item = next_state["items"][item["project_item_id"]]
        stuck_minutes = minutes_between(state_item.get("status_since_at"), normalized_now_iso)
        in_review_polls = poll_count - int(state_item.get("status_since_poll") or 0) + 1

        if item["status"] == "In Progress" and stuck_minutes >= stall_minutes:
            summary["needs_attention"]["stalled_in_progress"].append(
                {
                    "issue_number": item["issue_number"],
                    "project_item_id": item["project_item_id"],
                    "stuck_minutes": stuck_minutes,
                    "status_since_at": state_item.get("status_since_at"),
                    "last_activity_indicator": state_item.get("last_activity_indicator"),
                    "last_activity_at": state_item.get("last_activity_at"),
                }
            )

        if (
            item["status"] == "In Review"
            and in_review_polls >= review_churn_polls
            and state_item.get("last_dispatched_role") == "REVIEWER"
            and state_item.get("last_dispatched_status") == "In Review"
        ):
            summary["needs_attention"]["in_review_churn"].append(
                {
                    "issue_number": item["issue_number"],
                    "project_item_id": item["project_item_id"],
                    "in_review_polls": in_review_polls,
                    "last_run_id": state_item.get("last_run_id"),
                    "last_dispatched_at": state_item.get("last_dispatched_at"),
                }
            )

        last_dispatch = None
        if state_item.get("last_dispatched_status") == item["status"] and _has_non_empty_string(state_item.get("last_dispatched_role")):
            last_dispatch = {
                "role": state_item.get("last_dispatched_role"),
                "run_id": state_item.get("last_run_id"),
                "dispatched_at": state_item.get("last_dispatched_at"),
            }

        summary["processed_items"].append(
            {
                "issue_number": item["issue_number"],
                "project_item_id": item["project_item_id"],
                "status": item["status"],
                "last_dispatch": last_dispatch,
                "stall": {
                    "stuck_minutes": stuck_minutes,
                    "is_stalled": stuck_minutes >= stall_minutes,
                }
                if item["status"] == "In Progress"
                else None,
                "in_review_origin": state_item.get("in_review_origin") if item["status"] == "In Review" else "",
            }
        )

    active_count = (
        int(summary["status_counts"]["Ready"])
        + int(summary["status_counts"]["In Progress"])
        + int(summary["status_counts"]["In Review"])
    )
    completed = active_count == 0 and int(summary["status_counts"]["Backlog"]) == 0
    summary["completed"] = completed

    return RunPlan(intents=intents, next_state=next_state, summary=summary, completed=completed)


def merge_runner_managed_item_fields(*, next_item: dict[str, Any], existing_item: dict[str, Any]) -> dict[str, Any]:
    same_status_epoch = (
        next_item.get("last_seen_status") == existing_item.get("last_seen_status")
        and isinstance(next_item.get("status_since_poll"), int)
        and isinstance(existing_item.get("status_since_poll"), int)
        and int(next_item.get("status_since_poll")) == int(existing_item.get("status_since_poll"))
    )
    if not same_status_epoch:
        return next_item

    merged = dict(next_item)

    next_review_cycle_count = int(next_item.get("review_cycle_count") or 0) if isinstance(next_item.get("review_cycle_count"), int) else 0
    disk_review_cycle_count = int(existing_item.get("review_cycle_count") or 0) if isinstance(existing_item.get("review_cycle_count"), int) else 0
    merged["review_cycle_count"] = max(next_review_cycle_count, disk_review_cycle_count)

    next_feedback_at = to_iso_timestamp(next_item.get("last_reviewer_feedback_at"))
    disk_feedback_at = to_iso_timestamp(existing_item.get("last_reviewer_feedback_at"))
    if disk_feedback_at and (not next_feedback_at or is_after_iso(disk_feedback_at, next_feedback_at)):
        merged["last_reviewer_feedback_at"] = disk_feedback_at
        if _has_non_empty_string(existing_item.get("last_reviewer_outcome")):
            merged["last_reviewer_outcome"] = str(existing_item.get("last_reviewer_outcome") or "").strip().upper()
    elif next_feedback_at:
        merged["last_reviewer_feedback_at"] = next_feedback_at
        if _has_non_empty_string(next_item.get("last_reviewer_outcome")):
            merged["last_reviewer_outcome"] = str(next_item.get("last_reviewer_outcome") or "").strip().upper()

    next_executor_at = to_iso_timestamp(next_item.get("last_executor_response_at"))
    disk_executor_at = to_iso_timestamp(existing_item.get("last_executor_response_at"))
    if disk_executor_at and (not next_executor_at or is_after_iso(disk_executor_at, next_executor_at)):
        merged["last_executor_response_at"] = disk_executor_at
    elif next_executor_at:
        merged["last_executor_response_at"] = next_executor_at

    next_origin = str(next_item.get("in_review_origin") or "").strip() if _has_non_empty_string(next_item.get("in_review_origin")) else ""
    disk_origin = str(existing_item.get("in_review_origin") or "").strip() if _has_non_empty_string(existing_item.get("in_review_origin")) else ""
    if next_item.get("last_seen_status") == "In Review":
        merged["in_review_origin"] = next_origin or disk_origin
    else:
        merged["in_review_origin"] = ""

    return merged

