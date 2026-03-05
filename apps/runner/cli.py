from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from .config import load_config
from .daemon import OrchestratorDaemon, create_redis_client
from .http_client import BackendClient
from .supervisor import start_supervisors


def _log_stderr(payload: dict[str, object]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="runner")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--daemon", action="store_true", help="run persistent orchestrator daemon (Redis control loop)")
    mode.add_argument("--once", action="store_true", help="run a single scheduler tick and exit")
    parser.add_argument("--dry-run", action="store_true", help="do not enqueue intents or call backend write endpoints")
    parser.add_argument("--sprint", type=str, help="sprint value M1..M4 (overrides ORCHESTRATOR_SPRINT)")
    args = parser.parse_args(argv)

    sprint_override = args.sprint.strip() if isinstance(args.sprint, str) else None
    repo_root = str(Path(__file__).resolve().parents[2])

    try:
        config = load_config(
            dry_run_flag=bool(args.dry_run),
            once_flag=bool(args.once),
            orchestrator_sprint_override=sprint_override,
            cwd=repo_root,
        )
    except ValueError as exc:
        _log_stderr({"type": "CONFIG_ERROR", "error": str(exc)})
        return 2

    backend = BackendClient(base_url=config.backend_base_url, timeout_s=config.backend_timeout_s)
    try:
        redis_client = create_redis_client(config.redis_url)
    except RuntimeError as exc:
        _log_stderr({"type": "CONFIG_ERROR", "error": str(exc)})
        return 2

    daemon = OrchestratorDaemon(config=config, backend=backend, redis_client=redis_client)

    try:
        if args.once:
            daemon.run_once(sprint=config.orchestrator_sprint)
            return 0

        if not config.dry_run:
            start_supervisors(config=config)
        daemon.run()
        return 0
    except KeyboardInterrupt:
        return 130
