from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Optional


@dataclass(frozen=True)
class RunnerConfig:
    backend_base_url: str
    orchestrator_sprint: str
    runner_max_executors: int
    runner_max_reviewers: int
    dry_run: bool
    once: bool
    ledger_path: str
    orchestrator_cmd: str
    codex_bin: str
    codex_mcp_args: str


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
) -> RunnerConfig:
    resolved_env = dict(os.environ) if env is None else dict(env)

    backend_base_url = _require_non_empty(resolved_env, "BACKEND_BASE_URL").rstrip("/")
    orchestrator_sprint = _require_non_empty(resolved_env, "ORCHESTRATOR_SPRINT")

    runner_max_executors = _parse_positive_int(resolved_env, "RUNNER_MAX_EXECUTORS", 1)
    runner_max_reviewers = _parse_positive_int(resolved_env, "RUNNER_MAX_REVIEWERS", 1)

    dry_run = dry_run_flag or _parse_bool(resolved_env, "RUNNER_DRY_RUN", False)
    once = once_flag

    ledger_path = resolved_env.get("RUNNER_LEDGER_PATH", "./.runner-ledger.json").strip() or "./.runner-ledger.json"
    orchestrator_cmd = resolved_env.get(
        "RUNNER_ORCHESTRATOR_CMD",
        "node apps/orchestrator/src/cli.js --loop",
    ).strip()
    codex_bin = resolved_env.get("CODEX_BIN", "codex").strip() or "codex"
    codex_mcp_args = resolved_env.get("CODEX_MCP_ARGS", "mcp-server").strip() or "mcp-server"

    return RunnerConfig(
        backend_base_url=backend_base_url,
        orchestrator_sprint=orchestrator_sprint,
        runner_max_executors=runner_max_executors,
        runner_max_reviewers=runner_max_reviewers,
        dry_run=dry_run,
        once=once,
        ledger_path=ledger_path,
        orchestrator_cmd=orchestrator_cmd,
        codex_bin=codex_bin,
        codex_mcp_args=codex_mcp_args,
    )

