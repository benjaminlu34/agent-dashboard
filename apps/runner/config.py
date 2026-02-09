from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Optional


@dataclass(frozen=True)
class RunnerConfig:
    backend_base_url: str
    backend_timeout_s: float
    orchestrator_sprint: str
    runner_max_executors: int
    runner_max_reviewers: int
    runner_ready_buffer: int
    review_stall_polls: int
    blocked_retry_minutes: int
    watchdog_timeout_s: int
    dry_run: bool
    once: bool
    ledger_path: str
    sprint_plan_path: str
    autopromote: bool
    orchestrator_state_path: str
    orchestrator_cmd: str
    codex_bin: str
    codex_mcp_args: str
    codex_tools_call_timeout_s: float


def _require_non_empty(env: dict[str, str], key: str) -> str:
    value = env.get(key, "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def _parse_positive_int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{key} must be an integer") from None
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def _parse_positive_float(env: dict[str, str], key: str, default: float) -> float:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{key} must be a number") from None
    if value <= 0:
        raise ValueError(f"{key} must be a positive number")
    return value


def _parse_bool(env: dict[str, str], key: str, default: bool = False) -> bool:
    raw = env.get(key)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    return normalized in ("1", "true", "yes", "y", "on")


def load_config(
    *,
    env: Optional[dict[str, str]] = None,
    dry_run_flag: bool = False,
    once_flag: bool = False,
    orchestrator_sprint_override: Optional[str] = None,
) -> RunnerConfig:
    resolved_env = dict(os.environ) if env is None else dict(env)

    backend_base_url = _require_non_empty(resolved_env, "BACKEND_BASE_URL").rstrip("/")
    backend_timeout_s = _parse_positive_float(resolved_env, "BACKEND_TIMEOUT_S", 120.0)
    if orchestrator_sprint_override is not None:
        orchestrator_sprint = orchestrator_sprint_override.strip()
        if not orchestrator_sprint:
            raise ValueError("sprint is required")
    else:
        try:
            orchestrator_sprint = _require_non_empty(resolved_env, "ORCHESTRATOR_SPRINT")
        except ValueError:
            raise ValueError("sprint is required") from None

    runner_max_executors = _parse_positive_int(resolved_env, "RUNNER_MAX_EXECUTORS", 1)
    runner_max_reviewers = _parse_positive_int(resolved_env, "RUNNER_MAX_REVIEWERS", 1)
    runner_ready_buffer = _parse_positive_int(resolved_env, "RUNNER_READY_BUFFER", 2)
    review_stall_polls = _parse_positive_int(resolved_env, "REVIEW_STALL_POLLS", 50)
    blocked_retry_minutes = _parse_positive_int(resolved_env, "BLOCKED_RETRY_MINUTES", 15)
    watchdog_timeout_s = _parse_positive_int(resolved_env, "RUNNER_WATCHDOG_TIMEOUT_S", 900)

    dry_run = dry_run_flag or _parse_bool(resolved_env, "RUNNER_DRY_RUN", False)
    once = once_flag

    ledger_path = resolved_env.get("RUNNER_LEDGER_PATH", "./.runner-ledger.json").strip() or "./.runner-ledger.json"
    sprint_plan_path = resolved_env.get("RUNNER_SPRINT_PLAN_PATH", "./.runner-sprint-plan.json").strip() or "./.runner-sprint-plan.json"
    autopromote = _parse_bool(resolved_env, "RUNNER_AUTOPROMOTE", True)
    orchestrator_state_path = (
        resolved_env.get("ORCHESTRATOR_STATE_PATH", "./.orchestrator-state.json").strip() or "./.orchestrator-state.json"
    )
    orchestrator_cmd = resolved_env.get(
        "RUNNER_ORCHESTRATOR_CMD",
        "node apps/orchestrator/src/cli.js --loop",
    ).strip()
    codex_bin = resolved_env.get("CODEX_BIN", "codex").strip() or "codex"
    codex_mcp_args = resolved_env.get("CODEX_MCP_ARGS", "mcp-server").strip() or "mcp-server"
    codex_tools_call_timeout_s = _parse_positive_float(resolved_env, "CODEX_TOOLS_CALL_TIMEOUT_S", 1800.0)

    return RunnerConfig(
        backend_base_url=backend_base_url,
        backend_timeout_s=backend_timeout_s,
        orchestrator_sprint=orchestrator_sprint,
        runner_max_executors=runner_max_executors,
        runner_max_reviewers=runner_max_reviewers,
        runner_ready_buffer=runner_ready_buffer,
        review_stall_polls=review_stall_polls,
        blocked_retry_minutes=blocked_retry_minutes,
        watchdog_timeout_s=watchdog_timeout_s,
        dry_run=dry_run,
        once=once,
        ledger_path=ledger_path,
        sprint_plan_path=sprint_plan_path,
        autopromote=autopromote,
        orchestrator_state_path=orchestrator_state_path,
        orchestrator_cmd=orchestrator_cmd,
        codex_bin=codex_bin,
        codex_mcp_args=codex_mcp_args,
        codex_tools_call_timeout_s=codex_tools_call_timeout_s,
    )
