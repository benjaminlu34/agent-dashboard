from __future__ import annotations

import json
import os
import random
import time
from dataclasses import asdict
from multiprocessing import get_context
from pathlib import Path
from typing import Any, Optional

from .codex_worker import CodexWorkerError, WorkerResult, run_intent_with_codex_mcp
from .daemon import create_redis_client
from .failure import classify_failure, error_code_for_exception
from .http_client import BackendClient, HttpError
from .in_flight import acquire_in_flight_lock, release_in_flight_lock
from .intents import IntentError, RunIntent, parse_intent
from .ledger import LedgerEntry, LedgerError, RunLedger
from .redis_keys import orchestrator_intents_queue_key
from .state_store import RedisStateStore
from .telemetry import publish_transcript_event
from .workspace import setup_worktree, teardown_worktree

_PREEMPTION_POLL_INTERVAL_S = 5.0
_ACTIVE_TASK_STATUSES = frozenset({"In Progress", "In Review"})


def _log_stderr(payload: dict[str, Any]) -> None:
    try:
        import sys

        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


def _decode_redis_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return str(value)


def _utc_now_iso_ms() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime()) + f"{int((time.time() % 1) * 1000):03d}Z"


def _stop_process(proc: Any) -> None:
    proc.terminate()
    proc.join(timeout=2.0)
    if proc.is_alive():
        proc.kill()
        proc.join(timeout=2.0)


def _resolve_run_context_by_run_id(items: dict[str, dict[str, Any]], run_id: str) -> Optional[tuple[int, str, str]]:
    normalized_run_id = str(run_id or "").strip()
    if not normalized_run_id:
        return None
    for project_item_id, state_item in items.items():
        if not isinstance(state_item, dict):
            continue
        if str(state_item.get("last_run_id") or "").strip() != normalized_run_id:
            continue
        issue_number = state_item.get("last_seen_issue_number")
        status = str(state_item.get("last_seen_status") or "").strip()
        if isinstance(issue_number, int) and issue_number > 0:
            return issue_number, project_item_id, status
    return None


def _resolve_project_item_id_for_issue(items: dict[str, dict[str, Any]], issue_number: int) -> str:
    if issue_number <= 0:
        return ""
    matches: list[tuple[str, str, str]] = []
    for project_item_id, entry in items.items():
        if not isinstance(entry, dict):
            continue
        if entry.get("last_seen_issue_number") != issue_number:
            continue
        last_seen_at = str(entry.get("last_seen_at") or "").strip()
        status_since_at = str(entry.get("status_since_at") or "").strip()
        matches.append((last_seen_at, status_since_at, project_item_id))
    if not matches:
        return ""
    matches.sort()
    return matches[-1][2]


def _record_reviewer_outcome_state(
    *,
    state_store: RedisStateStore,
    repo_key: str,
    items: dict[str, dict[str, Any]],
    issue_number: int,
    outcome: str,
    recorded_at: str,
) -> None:
    project_item_id = _resolve_project_item_id_for_issue(items, issue_number)
    if not project_item_id:
        return
    state_item = items.get(project_item_id) if isinstance(items.get(project_item_id), dict) else {}
    review_cycle_count = state_item.get("review_cycle_count")
    next_cycle_count = int(review_cycle_count) if isinstance(review_cycle_count, int) and review_cycle_count >= 0 else 0
    if outcome in ("FAIL", "INCOMPLETE"):
        next_cycle_count += 1
    updated = dict(state_item)
    updated.update(
        {
            "last_reviewer_outcome": outcome,
            "last_reviewer_feedback_at": recorded_at,
            "review_cycle_count": next_cycle_count,
        }
    )
    state_store.set_item(repo_key, project_item_id, updated)


def _record_executor_response_state(
    *,
    state_store: RedisStateStore,
    repo_key: str,
    items: dict[str, dict[str, Any]],
    run_id: str,
    recorded_at: str,
) -> None:
    context = _resolve_run_context_by_run_id(items, run_id)
    if not context:
        return
    _issue_number, project_item_id, status = context
    if status != "In Review":
        return
    state_item = items.get(project_item_id)
    if not isinstance(state_item, dict):
        return
    updated = dict(state_item)
    updated["last_executor_response_at"] = recorded_at
    state_store.set_item(repo_key, project_item_id, updated)


def _transition_executor_failure_to_blocked(
    *,
    backend: BackendClient,
    items: dict[str, dict[str, Any]],
    run_id: str,
    failure_classification: str,
    failure_message: str,
) -> None:
    context = _resolve_run_context_by_run_id(items, run_id)
    if not context:
        _log_stderr({"type": "WORKER_RECOVERY_SKIPPED", "role": "EXECUTOR", "run_id": run_id, "reason": "run_context_not_found"})
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
        "failure_message": str(failure_message or "")[:1000],
        "suggested_next_steps": suggested_next_steps,
        "run_id": run_id,
    }
    try:
        payload = backend.post_json("/internal/project-item/update-field", body=body)
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


def _resolve_reviewer_pr_linkage(*, backend: BackendClient, issue_number: int) -> dict[str, Any]:
    return backend.post_json("/internal/reviewer/resolve-linked-pr", body={"role": "REVIEWER", "issue_number": issue_number})


def _transition_reviewer_pass_to_needs_human_approval(
    *,
    backend: BackendClient,
    run_id: str,
    issue_number: int,
    project_item_id: str,
    pr_url: str,
    reason: str,
) -> dict[str, Any]:
    body = {
        "role": "ORCHESTRATOR",
        "project_item_id": project_item_id,
        "field": "Status",
        "value": "Needs Human Approval",
        "issue_number": issue_number,
        "run_id": run_id,
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
    }
    return backend.post_json("/internal/project-item/update-field", body=body)


def _extract_pr_url_from_result(result: WorkerResult) -> str:
    pr_url = result.urls.get("pr_url") or result.urls.get("pull_request") or result.urls.get("pull_request_url") or ""
    return str(pr_url or "").strip()


def _intent_child_main(
    *,
    redis_url: str,
    backend_base_url: str,
    backend_timeout_s: float,
    codex_bin: str,
    codex_mcp_args: str,
    codex_tools_call_timeout_s: float,
    intent: dict[str, Any],
    result_queue: Any,
) -> None:
    redis_client = None
    try:
        redis_client = create_redis_client(redis_url)
        backend = BackendClient(base_url=backend_base_url, timeout_s=backend_timeout_s)
        role = str(intent.get("role") or "").strip().upper()
        run_id = str(intent.get("run_id") or "").strip()
        repo_root = str(Path(__file__).resolve().parents[2])
        bundle = backend.get_agent_context(role)

        def sink(section: str, content: str) -> None:
            if redis_client is None:
                return
            publish_transcript_event(
                redis_client=redis_client,
                run_id=run_id,
                role=role,
                section=section,
                content=content,
            )

        worktree_path: Optional[str] = None
        try:
            worktree_path = setup_worktree(repo_root=repo_root, run_id=run_id)
            result = run_intent_with_codex_mcp(
                codex_bin=codex_bin,
                codex_mcp_args=codex_mcp_args,
                backend_base_url=backend_base_url,
                role_bundle=bundle,
                intent=intent,
                tools_call_timeout_s=codex_tools_call_timeout_s,
                cwd=worktree_path,
                transcript_event_sink=sink,
            )
        finally:
            if worktree_path:
                teardown_worktree(repo_root=repo_root, worktree_path=worktree_path)

        payload = asdict(result)
        result_queue.put(payload)
    except Exception as exc:
        error_code = error_code_for_exception(exc)
        role = str(intent.get("role") or "").strip().upper()
        run_id = str(intent.get("run_id") or "").strip()
        outcome = "INCOMPLETE" if role == "REVIEWER" else None
        payload = {
            "run_id": run_id,
            "role": role,
            "status": "failed",
            "outcome": outcome,
            "summary": str(exc),
            "urls": {},
            "errors": [{"code": error_code, "message": str(exc)}],
            "marker_verified": None,
        }
        try:
            result_queue.put(payload)
        except Exception:
            pass
        return
    finally:
        try:
            if redis_client is not None and hasattr(redis_client, "close"):
                redis_client.close()
        except Exception:
            pass


def run_supervisor_loop(
    *,
    role: str,
    repo_key: str,
    redis_url: str,
    backend_base_url: str,
    backend_timeout_s: float,
    codex_bin: str,
    codex_mcp_args: str,
    codex_tools_call_timeout_s: float,
    watchdog_timeout_s: int,
    in_flight_ttl_s: int = 3600,
) -> None:
    normalized_role = str(role or "").strip().upper()
    if normalized_role not in {"EXECUTOR", "REVIEWER"}:
        raise ValueError("role must be EXECUTOR or REVIEWER")

    redis_client = create_redis_client(redis_url)
    backend = BackendClient(base_url=backend_base_url, timeout_s=backend_timeout_s)
    state_store = RedisStateStore(redis_client)
    ledger = RunLedger(redis_client, repo_key)
    queue_key = orchestrator_intents_queue_key(role=normalized_role, repo_key=repo_key)

    ctx = get_context("spawn")

    while True:
        result = redis_client.blpop(queue_key, timeout=0)
        if not result:
            continue
        _key, raw_message = result
        raw_json = _decode_redis_value(raw_message)
        try:
            intent_raw = json.loads(raw_json)
        except json.JSONDecodeError:
            _log_stderr({"type": "WORKER_INTENT_INVALID_JSON", "role": normalized_role, "raw": raw_json[:2000]})
            continue

        try:
            intent_obj = parse_intent(intent_raw)
        except IntentError as exc:
            _log_stderr({"type": "WORKER_INTENT_INVALID", "role": normalized_role, "error": str(exc), "code": exc.code})
            continue

        items_snapshot = state_store.get_all_items(repo_key)
        issue_number = intent_obj.body.get("issue_number")
        if not isinstance(issue_number, int) or issue_number <= 0:
            if intent_obj.role == "EXECUTOR":
                context = _resolve_run_context_by_run_id(items_snapshot, intent_obj.run_id)
                issue_number = context[0] if context else 0
            else:
                issue_number = 0

        lock_acquired = acquire_in_flight_lock(
            redis_client=redis_client,
            repo_key=repo_key,
            issue_number=int(issue_number or 0),
            run_id=intent_obj.run_id,
            role=intent_obj.role,
            ttl_s=in_flight_ttl_s,
        )
        if not lock_acquired:
            redis_client.rpush(queue_key, raw_json)
            time.sleep(random.uniform(0.25, 0.75))
            continue

        proc = None
        child_result_queue: Any = ctx.Queue(maxsize=1)
        timed_out = False
        preempted = False
        task_project_item_id = ""
        try:
            existing = ledger.get(intent_obj.run_id)
            if not existing:
                ledger.upsert(
                    LedgerEntry(
                        run_id=intent_obj.run_id,
                        role=intent_obj.role,
                        intent_hash=intent_obj.intent_hash,
                        received_at=_utc_now_iso_ms(),
                        status="queued",
                        result=None,
                    )
                )
            try:
                ledger.mark_running(intent_obj.run_id)
            except LedgerError:
                pass
            if isinstance(issue_number, int) and issue_number > 0:
                task_project_item_id = _resolve_project_item_id_for_issue(items_snapshot, int(issue_number))
                if task_project_item_id:
                    try:
                        ledger.touch_task_last_activity(task_project_item_id, at_iso=_utc_now_iso_ms())
                    except Exception:
                        pass

            proc = ctx.Process(
                target=_intent_child_main,
                kwargs={
                    "redis_url": redis_url,
                    "backend_base_url": backend_base_url,
                    "backend_timeout_s": backend_timeout_s,
                    "codex_bin": codex_bin,
                    "codex_mcp_args": codex_mcp_args,
                    "codex_tools_call_timeout_s": codex_tools_call_timeout_s,
                    "intent": intent_raw,
                    "result_queue": child_result_queue,
                },
            )
            proc.start()
            deadline = time.time() + float(watchdog_timeout_s)
            while time.time() < deadline and proc.is_alive():
                proc.join(timeout=_PREEMPTION_POLL_INTERVAL_S)
                if not proc.is_alive():
                    break
                if task_project_item_id:
                    current_state = state_store.get_item(repo_key, task_project_item_id) or {}
                    current_status = str(current_state.get("last_seen_status") or "").strip()
                    if not current_status or current_status not in _ACTIVE_TASK_STATUSES:
                        preempted = True
                        _stop_process(proc)
                        break

            if not preempted and proc.is_alive():
                timed_out = True
                _stop_process(proc)

            if preempted:
                ledger.mark_result(
                    intent_obj.run_id,
                    status="failed",
                    result={
                        "status": "failed",
                        "summary": "worker canceled because the tracked item moved out of scope externally",
                        "urls": {},
                        "errors": [
                            {
                                "code": "preempted",
                                "message": "tracked item moved to a non-active state or was removed externally",
                            }
                        ],
                        "failure_classification": "PREEMPTED",
                        "error_code": "preempted",
                    },
                )
                continue

            result_payload = None
            try:
                result_payload = child_result_queue.get_nowait()
            except Exception:
                result_payload = None

            if timed_out or proc.exitcode not in (0, None):
                ledger.mark_result(
                    intent_obj.run_id,
                    status="failed",
                    result={
                        "status": "failed",
                        "summary": "worker watchdog timeout" if timed_out else "worker exited unexpectedly",
                        "urls": {},
                        "errors": [
                            {
                                "code": "watchdog_timeout" if timed_out else "worker_down",
                                "message": "terminated by watchdog" if timed_out else "child process exited non-zero",
                            }
                        ],
                        "failure_classification": "HARD_STOP",
                        "error_code": "watchdog_timeout" if timed_out else "worker_down",
                    },
                )
                continue

            if not isinstance(result_payload, dict):
                ledger.mark_result(
                    intent_obj.run_id,
                    status="failed",
                    result={
                        "status": "failed",
                        "summary": "worker did not return result",
                        "urls": {},
                        "errors": [{"code": "worker_down", "message": "missing IPC result"}],
                        "failure_classification": "HARD_STOP",
                        "error_code": "worker_down",
                    },
                )
                continue

            worker_result = WorkerResult(
                run_id=str(result_payload.get("run_id") or ""),
                role=str(result_payload.get("role") or ""),
                status=str(result_payload.get("status") or ""),
                outcome=result_payload.get("outcome"),
                summary=str(result_payload.get("summary") or ""),
                urls=result_payload.get("urls") if isinstance(result_payload.get("urls"), dict) else {},
                errors=result_payload.get("errors") if isinstance(result_payload.get("errors"), list) else [],
                marker_verified=result_payload.get("marker_verified"),
            )

            completed_at = _utc_now_iso_ms()
            reviewer_outcome = worker_result.outcome if intent_obj.role == "REVIEWER" else None

            if intent_obj.role == "EXECUTOR":
                pr_url = _extract_pr_url_from_result(worker_result)
                if pr_url and worker_result.marker_verified is not True:
                    raise CodexWorkerError(
                        "executor must verify canonical PR marker/linkage for PR runs",
                        code="worker_invalid_output",
                        details={"run_id": intent_obj.run_id},
                    )

            if intent_obj.role == "REVIEWER":
                if reviewer_outcome not in ("PASS", "FAIL", "INCOMPLETE"):
                    raise CodexWorkerError("reviewer outcome is required", code="worker_invalid_output")
                _record_reviewer_outcome_state(
                    state_store=state_store,
                    repo_key=repo_key,
                    items=items_snapshot,
                    issue_number=int(issue_number or 0),
                    outcome=str(reviewer_outcome),
                    recorded_at=completed_at,
                )
                if reviewer_outcome == "PASS" and isinstance(issue_number, int) and issue_number > 0:
                    linkage = _resolve_reviewer_pr_linkage(backend=backend, issue_number=int(issue_number))
                    pr_url = str(linkage.get("pr_url") or "").strip()
                    linkage_project_item_id = str(linkage.get("project_item_id") or "").strip()
                    if pr_url and linkage_project_item_id:
                        _transition_reviewer_pass_to_needs_human_approval(
                            backend=backend,
                            run_id=intent_obj.run_id,
                            issue_number=int(issue_number),
                            project_item_id=linkage_project_item_id,
                            pr_url=pr_url,
                            reason="Automated escalation after reviewer PASS.",
                        )
            if intent_obj.role == "EXECUTOR":
                _record_executor_response_state(
                    state_store=state_store,
                    repo_key=repo_key,
                    items=items_snapshot,
                    run_id=intent_obj.run_id,
                    recorded_at=completed_at,
                )

            ledger.mark_result(
                intent_obj.run_id,
                status="succeeded" if worker_result.status == "succeeded" else "failed",
                result={
                    "run_id": worker_result.run_id,
                    "role": worker_result.role,
                    "status": worker_result.status,
                    "summary": worker_result.summary,
                    "urls": worker_result.urls,
                    "errors": worker_result.errors,
                    "reviewer_outcome": reviewer_outcome,
                    "last_reviewer_feedback_at": completed_at if intent_obj.role == "REVIEWER" else None,
                    "last_executor_response_at": completed_at if intent_obj.role == "EXECUTOR" else None,
                    "failure_classification": "ITEM_STOP" if worker_result.status != "succeeded" else "",
                    "error_code": "",
                },
            )
            if task_project_item_id:
                try:
                    ledger.touch_task_last_activity(task_project_item_id, at_iso=completed_at)
                except Exception:
                    pass

            if intent_obj.role == "EXECUTOR" and worker_result.status != "succeeded":
                _transition_executor_failure_to_blocked(
                    backend=backend,
                    items=items_snapshot,
                    run_id=intent_obj.run_id,
                    failure_classification="ITEM_STOP",
                    failure_message=worker_result.summary,
                )
        except Exception as exc:
            failure_classification = classify_failure(exc)
            code = error_code_for_exception(exc)
            _log_stderr(
                {
                    "type": "WORKER_FAILED",
                    "role": intent_obj.role,
                    "run_id": intent_obj.run_id,
                    "classification": failure_classification,
                    "error_code": code,
                    "error": str(exc),
                }
            )
            try:
                ledger.mark_result(
                    intent_obj.run_id,
                    status="failed",
                    result={
                        "status": "failed",
                        "summary": str(exc),
                        "urls": {},
                        "errors": [{"error": str(exc), "code": code}],
                        "failure_classification": failure_classification,
                        "error_code": code,
                        "reviewer_outcome": "INCOMPLETE" if intent_obj.role == "REVIEWER" else None,
                        "last_reviewer_feedback_at": _utc_now_iso_ms() if intent_obj.role == "REVIEWER" else None,
                        "last_executor_response_at": None,
                    },
                )
            except Exception:
                pass
            if task_project_item_id:
                try:
                    ledger.touch_task_last_activity(task_project_item_id, at_iso=_utc_now_iso_ms())
                except Exception:
                    pass
            if intent_obj.role == "EXECUTOR":
                _transition_executor_failure_to_blocked(
                    backend=backend,
                    items=items_snapshot,
                    run_id=intent_obj.run_id,
                    failure_classification=failure_classification,
                    failure_message=str(exc),
                )
        finally:
            release_in_flight_lock(
                redis_client=redis_client,
                repo_key=repo_key,
                issue_number=int(issue_number or 0),
                run_id=intent_obj.run_id,
            )


def start_supervisors(*, config: Any) -> list[Any]:
    ctx = get_context("spawn")
    processes = []
    for _ in range(int(config.runner_max_executors)):
        proc = ctx.Process(
            target=run_supervisor_loop,
            kwargs={
                "role": "EXECUTOR",
                "repo_key": config.repo_key,
                "redis_url": config.redis_url,
                "backend_base_url": config.backend_base_url,
                "backend_timeout_s": config.backend_timeout_s,
                "codex_bin": config.codex_bin,
                "codex_mcp_args": config.codex_mcp_args,
                "codex_tools_call_timeout_s": config.codex_tools_call_timeout_s,
                "watchdog_timeout_s": config.watchdog_timeout_s,
            },
            daemon=True,
            name=f"supervisor-executor",
        )
        proc.start()
        processes.append(proc)

    for _ in range(int(config.runner_max_reviewers)):
        proc = ctx.Process(
            target=run_supervisor_loop,
            kwargs={
                "role": "REVIEWER",
                "repo_key": config.repo_key,
                "redis_url": config.redis_url,
                "backend_base_url": config.backend_base_url,
                "backend_timeout_s": config.backend_timeout_s,
                "codex_bin": config.codex_bin,
                "codex_mcp_args": config.codex_mcp_args,
                "codex_tools_call_timeout_s": config.codex_tools_call_timeout_s,
                "watchdog_timeout_s": config.watchdog_timeout_s,
            },
            daemon=True,
            name=f"supervisor-reviewer",
        )
        proc.start()
        processes.append(proc)

    _log_stderr({"type": "SUPERVISORS_STARTED", "executors": int(config.runner_max_executors), "reviewers": int(config.runner_max_reviewers)})
    return processes
