from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .config import RunnerConfig
from .codex_worker import CodexWorkerError
from .http_client import BackendClient, HttpError
from .intents import IntentError, parse_intent
from .kickoff import KickoffError
from .kickoff_runtime import run_kickoff
from .ledger import LedgerEntry, RunLedger
from .failure import is_retryable_failure
from .in_flight import release_in_flight_lock
from .promotion import MalformedSprintDataError, SanitizationRegenExhaustedError, SanitizationRegenHandoffRequestedError
from .promotion import maybe_autopromote_ready
from .redis_keys import orchestrator_control_key, orchestrator_intents_queue_key
from .scheduler import SchedulerError, build_run_plan, merge_runner_managed_item_fields
from .state_store import RedisStateStore
from .time_utils import calculate_backoff_delay, is_after_iso, minutes_since, normalize_iso, seconds_since


def _log_stderr(payload: dict[str, Any]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


def _utc_now_iso_ms() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _parse_non_negative_int(raw: Any, default: int) -> int:
    try:
        parsed = int(str(raw).strip())
    except Exception:
        return default
    return parsed if parsed >= 0 else default


def _parse_positive_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        parsed = int(str(raw).strip())
    except Exception:
        return default
    return parsed if parsed > 0 else default


def _parse_non_negative_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        parsed = int(str(raw).strip())
    except Exception:
        return default
    return parsed if parsed >= 0 else default


def _read_policy_status_options(repo_root: str) -> list[str]:
    schema_path = Path(repo_root) / "policy" / "project-schema.json"
    content = schema_path.read_text(encoding="utf8")
    policy = json.loads(content)
    required_fields = policy.get("required_fields")
    if not isinstance(required_fields, list):
        raise ValueError("policy/project-schema.json missing required_fields list")
    for field in required_fields:
        if not isinstance(field, dict):
            continue
        if field.get("name") != "Status":
            continue
        options = field.get("allowed_options")
        if not isinstance(options, list) or not options:
            raise ValueError("policy/project-schema.json missing Status.allowed_options")
        normalized = [str(option).strip() for option in options if isinstance(option, str) and option.strip()]
        if not normalized:
            raise ValueError("policy/project-schema.json missing Status.allowed_options")
        return normalized
    raise ValueError("policy/project-schema.json missing Status field")


def _read_orchestrator_items_fixture(repo_root: str, fixture_path: str) -> list[dict[str, Any]]:
    resolved = Path(repo_root) / fixture_path
    raw = resolved.read_text(encoding="utf8")
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise SchedulerError("ORCHESTRATOR_ITEMS_FILE must contain a JSON array", code="validation_failed")
    items: list[dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        items.append(entry)
    return items


def create_redis_client(redis_url: str) -> Any:
    try:
        import redis  # type: ignore[import-untyped]
    except ModuleNotFoundError as exc:  # pragma: no cover
        raise RuntimeError("redis package is required (pip install -r apps/runner/requirements.txt)") from exc
    return redis.Redis.from_url(redis_url, decode_responses=True)


@dataclass(frozen=True)
class ControlMessage:
    command: str
    mode: str
    sprint: str
    goal: str = ""
    require_verification: bool = True
    ready_limit: int = 3


def _parse_control_message(raw: Any) -> Optional[ControlMessage]:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    command = str(parsed.get("command") or "").strip().upper()
    if command not in {"START", "STOP"}:
        return None
    if command == "STOP":
        return ControlMessage(command="STOP", mode="", sprint="")
    mode = str(parsed.get("mode") or "").strip().upper()
    if mode not in {"KICKOFF", "RUNNER"}:
        return None
    sprint = str(parsed.get("sprint") or "").strip()
    if not sprint:
        return None
    goal = str(parsed.get("goal") or "").strip()
    require_verification = bool(parsed.get("require_verification")) if "require_verification" in parsed else True
    ready_limit = parsed.get("ready_limit")
    if not isinstance(ready_limit, int) or ready_limit <= 0:
        ready_limit = 3
    return ControlMessage(
        command="START",
        mode=mode,
        sprint=sprint,
        goal=goal,
        require_verification=require_verification,
        ready_limit=min(3, ready_limit),
    )


class OrchestratorDaemon:
    def __init__(self, *, config: RunnerConfig, backend: BackendClient, redis_client: Any):
        self._config = config
        self._backend = backend
        self._redis = redis_client
        self._repo_key = config.repo_key
        self._control_key = orchestrator_control_key(self._repo_key)
        self._state_store = RedisStateStore(redis_client)
        self._ledger = RunLedger(redis_client, self._repo_key)
        self._allowed_status_options = _read_policy_status_options(str(Path(__file__).resolve().parents[2]))
        self._repo_root = Path(__file__).resolve().parents[2]
        self._prune_stale_worktrees()

    def _prune_stale_worktrees(self) -> None:
        try:
            completed = subprocess.run(
                ["git", "worktree", "prune"],
                cwd=str(self._repo_root.resolve()),
                check=False,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except Exception as exc:
            _log_stderr({"type": "WORKTREE_PRUNE_FAILED", "repo_key": self._repo_key, "error": str(exc)})
            return

        if int(completed.returncode or 0) != 0:
            _log_stderr(
                {
                    "type": "WORKTREE_PRUNE_FAILED",
                    "repo_key": self._repo_key,
                    "exit_code": completed.returncode,
                    "stdout": str(completed.stdout or "")[:1000],
                    "stderr": str(completed.stderr or "")[:1000],
                }
            )
            return

        output = "\n".join(part for part in (str(completed.stdout or "").strip(), str(completed.stderr or "").strip()) if part)
        if output:
            _log_stderr({"type": "WORKTREE_PRUNED", "repo_key": self._repo_key, "output": output[:1000]})

    def run(self) -> None:
        while True:
            self._set_daemon_status("IDLE", mode="")
            _log_stderr({"type": "DAEMON_IDLE", "repo_key": self._repo_key})
            result = self._redis.blpop(self._control_key, timeout=0)
            if not result:
                continue
            _key, raw_message = result
            message = _parse_control_message(raw_message)
            if message is None:
                _log_stderr({"type": "DAEMON_CONTROL_INVALID", "repo_key": self._repo_key})
                continue
            if message.command == "STOP":
                _log_stderr({"type": "DAEMON_STOP_IGNORED_IDLE", "repo_key": self._repo_key})
                continue
            self._run_start(message)

    def run_once(self, *, sprint: str) -> None:
        normalized_sprint = str(sprint or "").strip()
        if normalized_sprint not in {"M1", "M2", "M3", "M4"}:
            raise ValueError("sprint must be M1..M4")
        self._scheduler_tick(sprint=normalized_sprint)

    def _set_daemon_status(self, status: str, *, mode: str) -> None:
        self._state_store.set_root_fields(
            self._repo_key,
            {
                "daemon_status": status,
                "daemon_mode": mode,
                "daemon_pid": str(os.getpid()),
                "daemon_heartbeat_at": _utc_now_iso_ms(),
            },
        )

    def _run_start(self, message: ControlMessage) -> None:
        normalized_sprint = message.sprint.strip()
        if normalized_sprint not in {"M1", "M2", "M3", "M4"}:
            _log_stderr({"type": "DAEMON_START_REJECTED", "repo_key": self._repo_key, "error": "invalid sprint"})
            return

        self._state_store.set_root_fields(
            self._repo_key,
            {
                "daemon_status": "ACTIVE",
                "daemon_mode": message.mode,
                "current_sprint": normalized_sprint,
                "daemon_pid": str(os.getpid()),
                "daemon_started_at": _utc_now_iso_ms(),
                "daemon_heartbeat_at": _utc_now_iso_ms(),
            },
        )

        if message.mode == "KICKOFF":
            self._run_kickoff_mode(message)
            return

        if not self._phase_guard_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        if not self._drift_defense_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        if not self._preflight_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        self._run_scheduler_loop(sprint=normalized_sprint)

    def _phase_guard_or_stop(self) -> bool:
        poll_seconds = _parse_non_negative_int_env("RUNNER_VERIFY_POLL_SECONDS", 0)
        while True:
            stop_raw = self._redis.lpop(self._control_key)
            stop_msg = _parse_control_message(stop_raw) if stop_raw is not None else None
            if stop_msg is not None and stop_msg.command == "STOP":
                _log_stderr({"type": "DAEMON_STOPPING", "repo_key": self._repo_key, "reason": "api_requested"})
                return False

            phase = str(self._state_store.get_root_field(self._repo_key, "sprint_phase") or "").strip().upper()
            if phase == "ACTIVE":
                return True

            if poll_seconds <= 0:
                _log_stderr({"type": "HARD_STOP", "reason": "sprint_pending_verification", "repo_key": self._repo_key, "phase": phase})
                return False

            _log_stderr({"type": "SPRINT_PENDING_VERIFICATION", "repo_key": self._repo_key, "phase": phase, "poll_seconds": poll_seconds})
            time.sleep(float(poll_seconds))

    def _drift_defense_or_stop(self) -> bool:
        sprint_plan_path = (self._repo_root / self._config.sprint_plan_path).resolve()
        try:
            raw = sprint_plan_path.read_text(encoding="utf8")
        except FileNotFoundError:
            _log_stderr({"type": "HARD_STOP", "reason": "sprint_plan_missing", "repo_key": self._repo_key, "path": str(sprint_plan_path)})
            return False
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "sprint_plan_invalid",
                    "repo_key": self._repo_key,
                    "path": str(sprint_plan_path),
                    "error": str(exc),
                }
            )
            return False
        if not isinstance(payload, dict):
            _log_stderr({"type": "HARD_STOP", "reason": "sprint_plan_invalid", "repo_key": self._repo_key, "path": str(sprint_plan_path)})
            return False
        plan_version = str(payload.get("plan_version") or "").strip()
        if not plan_version:
            _log_stderr({"type": "HARD_STOP", "reason": "plan_version_missing", "repo_key": self._repo_key, "path": str(sprint_plan_path)})
            return False

        ledger_version = self._ledger.get_plan_version()
        if not ledger_version:
            _log_stderr({"type": "HARD_STOP", "reason": "plan_version_missing", "repo_key": self._repo_key, "where": "ledger"})
            return False
        if ledger_version != plan_version:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "plan_version_mismatch",
                    "repo_key": self._repo_key,
                    "sprint_plan_plan_version": plan_version,
                    "ledger_plan_version": ledger_version,
                }
            )
            return False
        return True

    def _preflight_or_stop(self) -> bool:
        try:
            payload = self._backend.preflight_orchestrator()
        except HttpError as exc:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "backend_preflight_failed",
                    "repo_key": self._repo_key,
                    "error": str(exc),
                    "code": exc.code,
                    "status_code": exc.status_code,
                    "payload": exc.payload,
                }
            )
            return False
        if payload.get("status") != "PASS":
            _log_stderr({"type": "HARD_STOP", "reason": "preflight_fail", "repo_key": self._repo_key, "payload": payload})
            return False
        return True

    def _run_kickoff_mode(self, message: ControlMessage) -> None:
        goal = str(message.goal or "").strip()
        if not goal:
            goal = str(self._state_store.get_root_field(self._repo_key, "kickoff_goal") or "").strip()
        if not goal:
            _log_stderr({"type": "HARD_STOP", "reason": "kickoff_goal_missing", "repo_key": self._repo_key})
            self._set_daemon_status("IDLE", mode="")
            return

        orchestrator_state_path = str((self._repo_root / self._config.orchestrator_state_path).resolve())
        try:
            kickoff = run_kickoff(
                backend=self._backend,
                redis_client=self._redis,
                repo_root=str(self._repo_root),
                codex_bin=self._config.codex_bin,
                codex_mcp_args=self._config.codex_mcp_args,
                codex_tools_call_timeout_s=self._config.codex_tools_call_timeout_s,
                sprint=message.sprint,
                goal_text=goal,
                ready_limit=int(message.ready_limit),
                require_verification=bool(message.require_verification),
                dry_run=bool(self._config.dry_run),
                sanitization_regen_attempts=int(self._config.orchestrator_sanitization_regen_attempts),
                orchestrator_state_path=orchestrator_state_path,
            )
            _log_stderr({"type": "DAEMON_KICKOFF_COMPLETE", "repo_key": self._repo_key, "run_id": kickoff.run_id})
        except SanitizationRegenHandoffRequestedError as exc:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "sanitization_regen_handoff_requested",
                    "repo_key": self._repo_key,
                    "error": str(exc),
                    "request_path": exc.request_path,
                    "history": exc.history,
                }
            )
            self._set_daemon_status("IDLE", mode="")
            return
        except SanitizationRegenExhaustedError as exc:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "sanitization_regen_exhausted",
                    "repo_key": self._repo_key,
                    "error": str(exc),
                    "history": exc.history,
                }
            )
            self._set_daemon_status("IDLE", mode="")
            return
        except MalformedSprintDataError as exc:
            _log_stderr({"type": "HARD_STOP", "reason": "malformed_item_data", "repo_key": self._repo_key, "error": str(exc)})
            self._set_daemon_status("IDLE", mode="")
            return
        except (KickoffError, CodexWorkerError) as exc:
            _log_stderr(
                {
                    "type": "HARD_STOP",
                    "reason": "kickoff_failed",
                    "repo_key": self._repo_key,
                    "code": getattr(exc, "code", "kickoff_failed"),
                    "details": getattr(exc, "details", {}),
                    "error": str(exc),
                }
            )
            self._set_daemon_status("IDLE", mode="")
            return

        if bool(self._config.dry_run):
            self._set_daemon_status("IDLE", mode="")
            return

        if not self._phase_guard_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        if not self._drift_defense_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        if not self._preflight_or_stop():
            self._set_daemon_status("IDLE", mode="")
            return
        self._run_scheduler_loop(sprint=message.sprint.strip())

    def _run_scheduler_loop(self, *, sprint: str) -> None:
        poll_interval_ms = _parse_positive_int_env("ORCHESTRATOR_POLL_INTERVAL_MS", 5000)
        stall_minutes = _parse_positive_int_env("ORCHESTRATOR_STALL_MINUTES", 120)
        review_churn_polls = _parse_positive_int_env("ORCHESTRATOR_REVIEW_CHURN_POLLS", 3)
        max_reviewer_dispatches_per_status = _parse_positive_int_env("ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS", 1)
        reviewer_retry_polls = _parse_non_negative_int_env("ORCHESTRATOR_REVIEWER_RETRY_POLLS", 0)
        executor_retry_polls = _parse_non_negative_int_env("ORCHESTRATOR_EXECUTOR_RETRY_POLLS", 0)
        max_review_cycles = _parse_positive_int_env("ORCHESTRATOR_MAX_REVIEW_CYCLES", 5)

        while True:
            stop_raw = self._redis.lpop(self._control_key)
            stop_msg = _parse_control_message(stop_raw) if stop_raw is not None else None
            if stop_msg is not None and stop_msg.command == "STOP":
                _log_stderr({"type": "DAEMON_STOPPING", "repo_key": self._repo_key, "reason": "api_requested"})
                self._set_daemon_status("IDLE", mode="")
                return

            self._state_store.touch_daemon_heartbeat(self._repo_key)
            try:
                completed = self._scheduler_tick(
                    sprint=sprint,
                    stall_minutes=stall_minutes,
                    review_churn_polls=review_churn_polls,
                    max_reviewer_dispatches_per_status=max_reviewer_dispatches_per_status,
                    reviewer_retry_polls=reviewer_retry_polls,
                    executor_retry_polls=executor_retry_polls,
                    max_review_cycles=max_review_cycles,
                    poll_interval_ms=poll_interval_ms,
                )
            except (SanitizationRegenHandoffRequestedError, SanitizationRegenExhaustedError, MalformedSprintDataError) as exc:
                _log_stderr({"type": "HARD_STOP", "repo_key": self._repo_key, "reason": "sanitization_regen_failed", "error": str(exc)})
                self._set_daemon_status("IDLE", mode="")
                return
            if completed:
                _log_stderr({"type": "END_OF_SPRINT_SUMMARY", **{"sprint": sprint, "repo_key": self._repo_key}})
                self._set_daemon_status("IDLE", mode="")
                return
            time.sleep(poll_interval_ms / 1000)

    def _scheduler_tick(
        self,
        *,
        sprint: str,
        stall_minutes: Optional[int] = None,
        review_churn_polls: Optional[int] = None,
        max_reviewer_dispatches_per_status: Optional[int] = None,
        reviewer_retry_polls: Optional[int] = None,
        executor_retry_polls: Optional[int] = None,
        max_review_cycles: Optional[int] = None,
        poll_interval_ms: int = 5000,
    ) -> bool:
        resolved_stall_minutes = stall_minutes if isinstance(stall_minutes, int) and stall_minutes > 0 else _parse_positive_int_env("ORCHESTRATOR_STALL_MINUTES", 120)
        resolved_review_churn = review_churn_polls if isinstance(review_churn_polls, int) and review_churn_polls > 0 else _parse_positive_int_env("ORCHESTRATOR_REVIEW_CHURN_POLLS", 3)
        resolved_max_reviewer_dispatches = (
            max_reviewer_dispatches_per_status
            if isinstance(max_reviewer_dispatches_per_status, int) and max_reviewer_dispatches_per_status > 0
            else _parse_positive_int_env("ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS", 1)
        )
        resolved_reviewer_retry = (
            reviewer_retry_polls
            if isinstance(reviewer_retry_polls, int) and reviewer_retry_polls >= 0
            else _parse_non_negative_int_env("ORCHESTRATOR_REVIEWER_RETRY_POLLS", 0)
        )
        resolved_executor_retry = (
            executor_retry_polls
            if isinstance(executor_retry_polls, int) and executor_retry_polls >= 0
            else _parse_non_negative_int_env("ORCHESTRATOR_EXECUTOR_RETRY_POLLS", 0)
        )
        resolved_max_review_cycles = (
            max_review_cycles if isinstance(max_review_cycles, int) and max_review_cycles > 0 else _parse_positive_int_env("ORCHESTRATOR_MAX_REVIEW_CYCLES", 5)
        )

        try:
            fixture_path = os.environ.get("ORCHESTRATOR_ITEMS_FILE", "").strip()
            if fixture_path:
                project_items = _read_orchestrator_items_fixture(str(Path(__file__).resolve().parents[2]), fixture_path)
            else:
                payload = self._backend.get_project_items_metadata(role="ORCHESTRATOR", sprint=sprint)
                raw_items = payload.get("items")
                if not isinstance(raw_items, list):
                    raise SchedulerError("backend metadata payload missing items list", code="backend_invalid_payload")
                project_items = [entry for entry in raw_items if isinstance(entry, dict)]
        except (HttpError, OSError, ValueError, SchedulerError) as exc:
            _log_stderr({"type": "DAEMON_POLL_FAILED", "repo_key": self._repo_key, "error": str(exc)})
            return False

        root = self._state_store.get_root(self._repo_key)
        poll_count = _parse_non_negative_int(root.get("poll_count"), 0)
        items = self._state_store.get_all_items(self._repo_key)
        previous_state = {"poll_count": poll_count, "items": items}

        now_iso = _utc_now_iso_ms()
        try:
            run_plan = build_run_plan(
                project_items=project_items,
                allowed_status_options=self._allowed_status_options,
                max_executors=int(self._config.runner_max_executors),
                max_reviewers=int(self._config.runner_max_reviewers),
                sprint=sprint,
                previous_state=previous_state,
                now_iso=now_iso,
                stall_minutes=resolved_stall_minutes,
                review_churn_polls=resolved_review_churn,
                max_reviewer_dispatches_per_status=resolved_max_reviewer_dispatches,
                reviewer_retry_polls=resolved_reviewer_retry,
                executor_retry_polls=resolved_executor_retry,
                max_review_cycles=resolved_max_review_cycles,
            )
        except SchedulerError as exc:
            _log_stderr({"type": "DAEMON_SCHEDULER_ERROR", "repo_key": self._repo_key, "error": str(exc), "code": exc.code})
            return False

        next_items: dict[str, dict[str, Any]] = {}
        for project_item_id, next_item in run_plan.next_state.get("items", {}).items():
            if not isinstance(next_item, dict):
                continue
            existing_item = items.get(project_item_id)
            if isinstance(existing_item, dict):
                next_items[project_item_id] = merge_runner_managed_item_fields(next_item=next_item, existing_item=existing_item)
            else:
                next_items[project_item_id] = next_item

        self._state_store.set_root_fields(self._repo_key, {"poll_count": str(run_plan.next_state.get("poll_count", 0))})
        for project_item_id, next_item in next_items.items():
            self._state_store.set_item(self._repo_key, project_item_id, next_item)

        for intent in run_plan.intents:
            try:
                parsed = parse_intent(intent)
            except IntentError as exc:
                _log_stderr({"type": "DAEMON_INTENT_INVALID", "repo_key": self._repo_key, "error": str(exc), "code": exc.code})
                continue

            serialized = json.dumps(intent, separators=(",", ":"), ensure_ascii=True)
            queue_key = orchestrator_intents_queue_key(role=parsed.role, repo_key=self._repo_key)
            if bool(self._config.dry_run):
                _log_stderr({"type": "DRY_RUN_WOULD_DISPATCH", "repo_key": self._repo_key, "role": parsed.role, "run_id": parsed.run_id, "endpoint": parsed.endpoint})
                continue

            self._redis.rpush(queue_key, serialized)
            self._ledger.upsert(
                LedgerEntry(
                    run_id=parsed.run_id,
                    role=parsed.role,
                    intent_hash=parsed.intent_hash,
                    received_at=now_iso,
                    status="queued",
                    result=None,
                )
            )

        _log_stderr({"type": "DISPATCH_SUMMARY", **run_plan.summary})

        orchestrator_state_path = str((self._repo_root / self._config.orchestrator_state_path).resolve())
        sprint_plan = self._load_sprint_plan()
        if self._config.autopromote:
            maybe_autopromote_ready(
                summary=run_plan.summary,
                sprint_plan=sprint_plan,
                backend=self._backend,
                dry_run=bool(self._config.dry_run),
                ready_target=int(self._config.runner_ready_buffer),
                sanitization_regen_attempts=int(self._config.orchestrator_sanitization_regen_attempts),
                orchestrator_state_path=orchestrator_state_path,
            )

        if not bool(self._config.dry_run):
            self._handle_dispatch_summary(summary=run_plan.summary)

        return bool(run_plan.completed)

    def _load_sprint_plan(self) -> Optional[dict[str, Any]]:
        sprint_plan_path = (self._repo_root / self._config.sprint_plan_path).resolve()
        try:
            raw = sprint_plan_path.read_text(encoding="utf8")
        except FileNotFoundError:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    def _handle_dispatch_summary(self, *, summary: dict[str, Any]) -> None:
        handlers = [
            ("recover_passed_in_review_items", self._recover_passed_in_review_items),
            ("recover_lost_in_review_reviewer_dispatches", self._recover_lost_in_review_reviewer_dispatches),
            ("handle_review_stall", self._handle_review_stall),
            ("handle_stalled_in_progress", self._handle_stalled_in_progress),
            ("handle_blocked_retries", self._handle_blocked_retries),
            ("handle_in_review_cycle_caps", self._handle_in_review_cycle_caps),
            ("handle_running_watchdog", self._handle_running_watchdog),
        ]
        for handler_name, handler in handlers:
            try:
                handler(summary=summary)
            except Exception as exc:
                _log_stderr({"type": "DISPATCH_SUMMARY_HANDLER_FAILED", "handler": handler_name, "error": str(exc)})

    def _resolve_reviewer_pr_linkage(self, *, issue_number: int) -> dict[str, Any]:
        return self._backend.post_json("/internal/reviewer/resolve-linked-pr", body={"role": "REVIEWER", "issue_number": issue_number})

    def _transition_reviewer_pass_to_needs_human_approval(
        self,
        *,
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
    ) -> dict[str, Any]:
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
    ) -> dict[str, Any]:
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

    def _transition_stalled_in_progress_to_blocked(
        self,
        *,
        issue_number: int,
        project_item_id: str,
        run_id: str,
        stuck_minutes: int,
        status_since_at: str,
    ) -> dict[str, Any]:
        body = {
            "role": "ORCHESTRATOR",
            "project_item_id": project_item_id,
            "field": "Status",
            "value": "Blocked",
            "issue_number": issue_number,
            "failure_classification": "ITEM_STOP",
            "failure_message": (
                "Detected stale In Progress state without an active executor run; "
                f"stuck for {stuck_minutes} minutes since {status_since_at or 'unknown'}."
            ),
            "suggested_next_steps": [
                "Inspect runner logs and linked execution artifacts for this issue.",
                "Requeue work by moving item to Ready after triage.",
            ],
            "run_id": run_id,
            "stuck_minutes": stuck_minutes,
        }
        return self._backend.post_json("/internal/project-item/update-field", body=body)

    def _transition_executor_failure_to_blocked(
        self,
        *,
        run_id: str,
        issue_number: int,
        project_item_id: str,
        status: str,
        failure_classification: str,
        failure_message: str,
    ) -> None:
        normalized_status = str(status or "").strip()
        if normalized_status not in ("In Progress", "In Review"):
            return

        if normalized_status == "In Review":
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
            payload = self._backend.post_json("/internal/project-item/update-field", body=body)
            _log_stderr(
                {
                    "type": "WORKER_RECOVERY_STATUS_UPDATED",
                    "role": "EXECUTOR",
                    "run_id": run_id,
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "from": normalized_status,
                    "to": "Blocked",
                    "backend_payload": payload,
                }
            )
        except Exception as exc:
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

    def _resolve_error_backoff(
        self,
        *,
        project_item_id: str,
        now_iso: str,
        fallback_failure_at: Any,
    ) -> Optional[dict[str, Any]]:
        failure_state = self._ledger.get_task_failure_state(project_item_id)
        failure_at = normalize_iso(failure_state.get("last_failure_at")) or normalize_iso(fallback_failure_at)
        attempt_count = failure_state.get("consecutive_failures")
        normalized_attempt_count = attempt_count if isinstance(attempt_count, int) and attempt_count > 0 else 0
        if normalized_attempt_count <= 0 and failure_at:
            normalized_attempt_count = 1
        if normalized_attempt_count <= 0 or not failure_at:
            return None

        delay_s = calculate_backoff_delay(
            normalized_attempt_count,
            self._config.error_retry_base_s,
            self._config.error_retry_max_s,
            self._config.error_retry_multiplier,
        )
        elapsed_s = seconds_since(failure_at, now_iso=now_iso)
        return {
            "attempt_count": normalized_attempt_count,
            "failure_at": failure_at,
            "delay_s": delay_s,
            "elapsed_s": elapsed_s,
        }

    def _recover_passed_in_review_items(self, *, summary: dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return

        items = self._state_store.get_all_items(self._repo_key)
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
            state_item = items.get(project_item_id)
            if not isinstance(state_item, dict):
                continue
            reviewer_outcome = str(state_item.get("last_reviewer_outcome") or "").strip().upper()
            if reviewer_outcome != "PASS":
                continue

            run_id = str(state_item.get("last_run_id") or "").strip()
            try:
                linkage = self._resolve_reviewer_pr_linkage(issue_number=issue_number)
                pr_url = str(linkage.get("pr_url") or "").strip()
                linkage_project_item_id = str(linkage.get("project_item_id") or "").strip()
                if not pr_url:
                    raise HttpError("review linkage missing pr_url", code="backend_invalid_payload", payload=linkage)
                if linkage_project_item_id != project_item_id:
                    raise HttpError(
                        "review linkage project_item_id mismatch",
                        code="backend_invalid_payload",
                        payload={"expected_project_item_id": project_item_id, "actual_project_item_id": linkage_project_item_id},
                    )
                payload = self._transition_reviewer_pass_to_needs_human_approval(
                    run_id=run_id,
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    pr_url=pr_url,
                    reason="Recovered stale reviewer PASS outcome while item remained In Review.",
                )
                _log_stderr({"type": "REVIEW_PASS_RECOVERED", "issue_number": issue_number, "project_item_id": project_item_id, "run_id": run_id, "backend_payload": payload})
            except Exception as exc:
                _log_stderr({"type": "REVIEW_PASS_RECOVERED", "issue_number": issue_number, "project_item_id": project_item_id, "run_id": run_id, "status": "failed", "error": str(exc)})

    def _handle_review_stall(self, *, summary: dict[str, Any]) -> None:
        needs_attention = summary.get("needs_attention")
        if not isinstance(needs_attention, dict):
            return
        churn_entries = needs_attention.get("in_review_churn")
        if not isinstance(churn_entries, list):
            return

        items = self._state_store.get_all_items(self._repo_key)
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
            if in_review_polls <= int(self._config.review_stall_polls):
                continue

            state_item = items.get(project_item_id)
            if isinstance(state_item, dict):
                reviewer_feedback_at = state_item.get("last_reviewer_feedback_at")
                executor_response_at = state_item.get("last_executor_response_at")
                if is_after_iso(executor_response_at, reviewer_feedback_at):
                    continue

            reviewer_dispatches = 0
            if isinstance(state_item, dict):
                dispatches_value = state_item.get("reviewer_dispatches_for_current_status")
                if isinstance(dispatches_value, int):
                    reviewer_dispatches = dispatches_value
            if reviewer_dispatches < 2:
                continue

            try:
                linkage = self._resolve_reviewer_pr_linkage(issue_number=issue_number)
                pr_url = str(linkage.get("pr_url") or "").strip()
                linkage_project_item_id = str(linkage.get("project_item_id") or "").strip()
                if not pr_url:
                    raise HttpError("review linkage missing pr_url", code="backend_invalid_payload", payload=linkage)
                if linkage_project_item_id != project_item_id:
                    raise HttpError(
                        "review linkage project_item_id mismatch",
                        code="backend_invalid_payload",
                        payload={"expected_project_item_id": project_item_id, "actual_project_item_id": linkage_project_item_id},
                    )
                payload = self._transition_reviewer_pass_to_needs_human_approval(
                    run_id=str(entry.get("last_run_id") or ""),
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    pr_url=pr_url,
                    reason="Escalated by orchestrator after repeated In Review stall; manual decision required.",
                )
                _log_stderr({"type": "REVIEW_STALL_ESCALATED", "issue_number": issue_number, "project_item_id": project_item_id, "in_review_polls": in_review_polls, "backend_payload": payload})
            except Exception as exc:
                _log_stderr({"type": "REVIEW_STALL_ESCALATED", "issue_number": issue_number, "project_item_id": project_item_id, "in_review_polls": in_review_polls, "status": "failed", "error": str(exc)})

    def _handle_stalled_in_progress(self, *, summary: dict[str, Any]) -> None:
        needs_attention = summary.get("needs_attention")
        if not isinstance(needs_attention, dict):
            return
        stalled_entries = needs_attention.get("stalled_in_progress")
        if not isinstance(stalled_entries, list):
            return

        now_iso = _utc_now_iso_ms()
        stall_minutes = _parse_positive_int_env("ORCHESTRATOR_STALL_MINUTES", 120)

        sealed_at = normalize_iso(self._state_store.get_root_field(self._repo_key, "sealed_at"))
        items = self._state_store.get_all_items(self._repo_key)

        for entry in stalled_entries:
            if not isinstance(entry, dict):
                continue
            issue_number = entry.get("issue_number")
            project_item_id = entry.get("project_item_id")
            stuck_minutes = entry.get("stuck_minutes")
            status_since_at = str(entry.get("status_since_at") or "").strip()
            if not isinstance(issue_number, int) or issue_number <= 0:
                continue
            if not isinstance(project_item_id, str) or not project_item_id.strip():
                continue
            if not isinstance(stuck_minutes, int) or stuck_minutes <= 0:
                continue

            state_item = items.get(project_item_id)
            if not isinstance(state_item, dict):
                continue
            if state_item.get("last_seen_status") != "In Progress":
                continue

            last_activity_at = str(self._ledger.get_task_last_activity(project_item_id) or "")
            baseline_at = normalize_iso(last_activity_at) or sealed_at
            effective_stuck_minutes = minutes_since(baseline_at, now_iso=now_iso) if baseline_at else stuck_minutes
            if effective_stuck_minutes < stall_minutes:
                continue

            run_id = str(state_item.get("last_run_id") or "").strip()
            if run_id:
                ledger_entry = self._ledger.get(run_id)
                if isinstance(ledger_entry, dict):
                    ledger_status = str(ledger_entry.get("status") or "").strip().lower()
                    if ledger_status == "running":
                        continue

            try:
                payload = self._transition_stalled_in_progress_to_blocked(
                    issue_number=issue_number,
                    project_item_id=project_item_id,
                    run_id=run_id,
                    stuck_minutes=effective_stuck_minutes,
                    status_since_at=baseline_at or status_since_at,
                )
                _log_stderr(
                    {
                        "type": "STALLED_IN_PROGRESS_BLOCKED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "run_id": run_id,
                        "stuck_minutes": effective_stuck_minutes,
                        "status_since_at": baseline_at or status_since_at,
                        "stall_minutes": stall_minutes,
                        "baseline_last_activity_at": normalize_iso(last_activity_at),
                        "baseline_sealed_at": sealed_at,
                        "backend_payload": payload,
                    }
                )
            except Exception as exc:
                _log_stderr({"type": "STALLED_IN_PROGRESS_BLOCKED", "issue_number": issue_number, "project_item_id": project_item_id, "run_id": run_id, "stuck_minutes": stuck_minutes, "status_since_at": status_since_at, "status": "failed", "error": str(exc)})

    def _recover_lost_in_review_reviewer_dispatches(self, *, summary: dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return
        poll_count_value = summary.get("poll_count")
        current_poll = poll_count_value if isinstance(poll_count_value, int) and poll_count_value >= 0 else None
        now_iso = _utc_now_iso_ms()

        items = self._state_store.get_all_items(self._repo_key)
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
            state_item = items.get(project_item_id)
            if not isinstance(state_item, dict):
                continue
            if state_item.get("last_dispatched_role") != "REVIEWER":
                continue
            if state_item.get("last_dispatched_status") != "In Review":
                continue
            if str(state_item.get("last_reviewer_outcome") or "").strip():
                continue
            last_dispatched_poll_value = state_item.get("last_dispatched_poll")
            last_dispatched_poll = last_dispatched_poll_value if isinstance(last_dispatched_poll_value, int) and last_dispatched_poll_value >= 0 else 0
            if current_poll is not None and last_dispatched_poll >= current_poll:
                continue
            stale_run_id = str(state_item.get("last_run_id") or "").strip()
            if not stale_run_id:
                continue

            elapsed_seconds = seconds_since(state_item.get("last_dispatched_at"), now_iso=now_iso)

            retryable_recovery = False
            ledger_entry = self._ledger.get(stale_run_id)
            if isinstance(ledger_entry, dict):
                ledger_status = str(ledger_entry.get("status") or "").strip().lower()
                if ledger_status == "running":
                    continue
                result = ledger_entry.get("result")
                reviewer_outcome = ""
                failure_classification = ""
                error_code = ""
                if isinstance(result, dict):
                    outcome_value = result.get("reviewer_outcome")
                    if isinstance(outcome_value, str) and outcome_value.strip():
                        reviewer_outcome = str(outcome_value).strip().upper()
                    failure_classification = str(result.get("failure_classification") or "")
                    error_code = str(result.get("error_code") or "")
                if reviewer_outcome in ("PASS", "FAIL", "INCOMPLETE"):
                    continue
                retryable_recovery = ledger_status == "failed" and is_retryable_failure(
                    failure_classification=failure_classification,
                    error_code=error_code,
                )
                recovery_reason = f"ledger_status_{ledger_status or 'unknown'}_without_outcome"
            else:
                retryable_recovery = True
                recovery_reason = "ledger_entry_missing"

            if not retryable_recovery:
                continue

            failure_at = normalize_iso(state_item.get("last_dispatched_at")) or now_iso
            retry_state = self._ledger.record_task_failure(project_item_id, run_id=stale_run_id, at_iso=failure_at)
            backoff = self._resolve_error_backoff(
                project_item_id=project_item_id,
                now_iso=now_iso,
                fallback_failure_at=retry_state.get("last_failure_at") or failure_at,
            )
            if backoff is not None and backoff["elapsed_s"] < backoff["delay_s"]:
                _log_stderr(
                    {
                        "type": "REVIEW_DISPATCH_RECOVERY_DEFERRED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "stale_run_id": stale_run_id,
                        "elapsed_s": backoff["elapsed_s"],
                        "retry_delay_s": backoff["delay_s"],
                        "attempt_count": backoff["attempt_count"],
                        "reason": recovery_reason,
                    }
                )
                continue

            review_cycle_count = state_item.get("review_cycle_count")
            next_cycle_count = int(review_cycle_count) if isinstance(review_cycle_count, int) and review_cycle_count >= 0 else 0
            next_cycle_count += 1
            updated = dict(state_item)
            updated.update(
                {
                    "last_reviewer_outcome": "INCOMPLETE",
                    "last_reviewer_feedback_at": retry_state.get("last_failure_at") or failure_at,
                    "review_cycle_count": next_cycle_count,
                    "last_dispatched_role": "",
                    "last_dispatched_status": "",
                    "last_dispatched_at": "",
                    "last_dispatched_poll": 0,
                }
            )
            self._state_store.set_item(self._repo_key, project_item_id, updated)
            _log_stderr(
                {
                    "type": "REVIEW_DISPATCH_RECOVERED",
                    "issue_number": issue_number,
                    "project_item_id": project_item_id,
                    "stale_run_id": stale_run_id,
                    "elapsed_s": elapsed_seconds,
                    "attempt_count": backoff["attempt_count"] if backoff is not None else 1,
                    "reason": recovery_reason,
                }
            )

    def _handle_blocked_retries(self, *, summary: dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return

        now_iso = _utc_now_iso_ms()
        items = self._state_store.get_all_items(self._repo_key)
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

            state_item = items.get(project_item_id)
            if not isinstance(state_item, dict):
                continue
            blocked_minutes = minutes_since(state_item.get("status_since_at"), now_iso=now_iso)

            run_id = str(state_item.get("last_run_id") or "")
            if not run_id:
                continue
            ledger_entry = self._ledger.get(run_id)
            if not isinstance(ledger_entry, dict):
                continue
            result = ledger_entry.get("result")
            if not isinstance(result, dict):
                continue
            failure_classification = str(result.get("failure_classification") or "")
            error_code = str(result.get("error_code") or "")
            if not is_retryable_failure(failure_classification=failure_classification, error_code=error_code):
                continue
            backoff = self._resolve_error_backoff(
                project_item_id=project_item_id,
                now_iso=now_iso,
                fallback_failure_at=state_item.get("status_since_at"),
            )
            if backoff is not None and backoff["elapsed_s"] < backoff["delay_s"]:
                _log_stderr(
                    {
                        "type": "BLOCKED_RETRY_DEFERRED",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "blocked_minutes": blocked_minutes,
                        "elapsed_s": backoff["elapsed_s"],
                        "retry_delay_s": backoff["delay_s"],
                        "attempt_count": backoff["attempt_count"],
                        "failure_classification": failure_classification,
                        "error_code": error_code,
                    }
                )
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
                _log_stderr({"type": "BLOCKED_RETRY", "issue_number": issue_number, "project_item_id": project_item_id, "blocked_minutes": blocked_minutes, "failure_classification": failure_classification, "error_code": error_code, "backend_payload": payload})
            except Exception as exc:
                _log_stderr({"type": "BLOCKED_RETRY", "issue_number": issue_number, "project_item_id": project_item_id, "blocked_minutes": blocked_minutes, "failure_classification": failure_classification, "error_code": error_code, "status": "failed", "error": str(exc)})

    def _handle_in_review_cycle_caps(self, *, summary: dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return

        items = self._state_store.get_all_items(self._repo_key)
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
            state_item = items.get(project_item_id)
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
                _log_stderr({"type": "REVIEW_CYCLE_CAP_BLOCKED", "issue_number": issue_number, "project_item_id": project_item_id, "review_cycle_count": review_cycle_count, "backend_payload": payload})
            except Exception as exc:
                _log_stderr({"type": "REVIEW_CYCLE_CAP_BLOCKED", "issue_number": issue_number, "project_item_id": project_item_id, "review_cycle_count": review_cycle_count, "status": "failed", "error": str(exc)})

    def _handle_running_watchdog(self, *, summary: dict[str, Any]) -> None:
        processed_items = summary.get("processed_items")
        if not isinstance(processed_items, list):
            return
        now_iso = _utc_now_iso_ms()

        items = self._state_store.get_all_items(self._repo_key)
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
            state_item = items.get(project_item_id)
            if not isinstance(state_item, dict):
                continue
            run_id = str(state_item.get("last_run_id") or "")
            if not run_id:
                continue
            ledger_entry = self._ledger.get(run_id)
            if not isinstance(ledger_entry, dict) or ledger_entry.get("status") != "running":
                continue
            started_at = ledger_entry.get("running_at") or ledger_entry.get("received_at")
            elapsed_seconds = seconds_since(started_at, now_iso=now_iso)
            if elapsed_seconds <= int(self._config.watchdog_timeout_s):
                continue

            message = f"Worker exceeded watchdog timeout ({int(self._config.watchdog_timeout_s)}s)."
            try:
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
            except Exception:
                pass

            release_in_flight_lock(
                redis_client=self._redis,
                repo_key=self._repo_key,
                issue_number=int(issue_number),
                run_id=run_id,
            )

            run_role = str(ledger_entry.get("role") or "").strip().upper()
            _log_stderr({"type": "WORKER_WATCHDOG_TIMEOUT", "repo_key": self._repo_key, "run_id": run_id, "role": run_role, "issue_number": issue_number, "project_item_id": project_item_id, "elapsed_s": elapsed_seconds, "timeout_s": int(self._config.watchdog_timeout_s)})

            if run_role == "REVIEWER":
                self._ledger.record_task_failure(project_item_id, run_id=run_id, at_iso=now_iso)
                _log_stderr(
                    {
                        "type": "WORKER_WATCHDOG_TIMEOUT_RECOVERY",
                        "run_id": run_id,
                        "role": "REVIEWER",
                        "issue_number": issue_number,
                        "project_item_id": project_item_id,
                        "action": "deferred_to_review_dispatch_recovery",
                    }
                )
            else:
                self._ledger.record_task_failure(project_item_id, run_id=run_id, at_iso=now_iso)
                self._transition_executor_failure_to_blocked(
                    run_id=run_id,
                    issue_number=int(issue_number),
                    project_item_id=project_item_id,
                    status=str(item.get("status") or ""),
                    failure_classification="HARD_STOP",
                    failure_message=message,
                )
