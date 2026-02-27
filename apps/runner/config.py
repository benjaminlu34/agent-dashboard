from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys
from typing import Optional

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - dependency may be installed at runtime
    yaml = None  # type: ignore[assignment]

DEFAULT_BACKEND_BASE_URL = "http://localhost:4000"
DEFAULT_AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml"
DEFAULT_LEDGER_PATH = "./.runner-ledger.json"
DEFAULT_ORCHESTRATOR_STATE_PATH = "./.orchestrator-state.json"


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
    orchestrator_sanitization_regen_attempts: int


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


def _parse_non_negative_int(env: dict[str, str], key: str, default: int) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{key} must be an integer") from None
    if value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _parse_bool(env: dict[str, str], key: str, default: bool = False) -> bool:
    raw = env.get(key)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    return normalized in ("1", "true", "yes", "y", "on")


def _sanitize_state_path_token(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", value.strip())


def _read_target_repo_identity_from_agent_swarm(cwd: Path) -> Optional[tuple[str, str]]:
    if yaml is None:
        return None

    config_path = cwd / DEFAULT_AGENT_SWARM_CONFIG_PATH
    try:
        raw = config_path.read_text(encoding="utf8")
    except FileNotFoundError:
        return None

    try:
        parsed = yaml.safe_load(raw) or {}
    except yaml.YAMLError as exc:
        sys.stderr.write(
            f"Warning: Failed to parse {DEFAULT_AGENT_SWARM_CONFIG_PATH}: {exc}. "
            "Falling back to default state paths.\n"
        )
        return None

    if not isinstance(parsed, dict):
        return None
    target = parsed.get("target")
    if not isinstance(target, dict):
        return None

    owner = target.get("owner")
    repo = target.get("repo")
    if not isinstance(owner, str) or not owner.strip():
        return None
    if not isinstance(repo, str) or not repo.strip():
        return None

    owner_token = _sanitize_state_path_token(owner)
    repo_token = _sanitize_state_path_token(repo)
    return owner_token, repo_token


def _resolve_repo_scoped_state_defaults(cwd: Path) -> tuple[str, str]:
    identity = _read_target_repo_identity_from_agent_swarm(cwd)
    if identity is None:
        return DEFAULT_LEDGER_PATH, DEFAULT_ORCHESTRATOR_STATE_PATH

    owner, repo = identity
    return (
        f"./.runner-ledger.{owner}.{repo}.json",
        f"./.orchestrator-state.{owner}.{repo}.json",
    )


def load_config(
    *,
    env: Optional[dict[str, str]] = None,
    dry_run_flag: bool = False,
    once_flag: bool = False,
    orchestrator_sprint_override: Optional[str] = None,
    cwd: Optional[str] = None,
) -> RunnerConfig:
    resolved_env = dict(os.environ) if env is None else dict(env)
    resolved_cwd = Path(cwd).resolve() if cwd is not None else Path.cwd()
    dotenv_path = resolved_cwd / ".env"
    try:
        dotenv_raw = dotenv_path.read_text(encoding="utf8")
    except FileNotFoundError:
        dotenv_raw = ""

    line_pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$")
    for line in dotenv_raw.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = line_pattern.match(line)
        if match is None:
            continue
        key = match.group(1)
        value = match.group(2).strip()
        if len(value) >= 2 and (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        resolved_env[key] = value

    default_ledger_path, default_orchestrator_state_path = _resolve_repo_scoped_state_defaults(resolved_cwd)

    backend_base_url = resolved_env.get("BACKEND_BASE_URL", DEFAULT_BACKEND_BASE_URL).strip() or DEFAULT_BACKEND_BASE_URL
    backend_base_url = backend_base_url.rstrip("/")
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

    runner_max_executors = _parse_positive_int(resolved_env, "RUNNER_MAX_EXECUTORS", 3)
    runner_max_reviewers = _parse_positive_int(resolved_env, "RUNNER_MAX_REVIEWERS", 2)
    runner_ready_buffer = _parse_positive_int(resolved_env, "RUNNER_READY_BUFFER", 2)
    review_stall_polls = _parse_positive_int(resolved_env, "REVIEW_STALL_POLLS", 50)
    blocked_retry_minutes = _parse_positive_int(resolved_env, "BLOCKED_RETRY_MINUTES", 15)
    watchdog_timeout_s = _parse_positive_int(resolved_env, "RUNNER_WATCHDOG_TIMEOUT_S", 900)

    dry_run = dry_run_flag or _parse_bool(resolved_env, "RUNNER_DRY_RUN", False)
    once = once_flag

    ledger_path = resolved_env.get("RUNNER_LEDGER_PATH", default_ledger_path).strip() or default_ledger_path
    sprint_plan_path = resolved_env.get("RUNNER_SPRINT_PLAN_PATH", "./.runner-sprint-plan.json").strip() or "./.runner-sprint-plan.json"
    autopromote = _parse_bool(resolved_env, "RUNNER_AUTOPROMOTE", True)
    orchestrator_state_path = (
        resolved_env.get("ORCHESTRATOR_STATE_PATH", default_orchestrator_state_path).strip() or default_orchestrator_state_path
    )
    orchestrator_cmd = resolved_env.get(
        "RUNNER_ORCHESTRATOR_CMD",
        "node apps/orchestrator/src/cli.js --loop",
    ).strip()
    codex_bin = resolved_env.get("CODEX_BIN", "codex").strip() or "codex"
    codex_mcp_args = resolved_env.get("CODEX_MCP_ARGS", "mcp-server").strip() or "mcp-server"
    codex_tools_call_timeout_s = _parse_positive_float(resolved_env, "CODEX_TOOLS_CALL_TIMEOUT_S", 1800.0)
    orchestrator_sanitization_regen_attempts = _parse_non_negative_int(
        resolved_env,
        "ORCHESTRATOR_SANITIZATION_REGEN_ATTEMPTS",
        2,
    )

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
        orchestrator_sanitization_regen_attempts=orchestrator_sanitization_regen_attempts,
    )
