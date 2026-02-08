from __future__ import annotations

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
import os
from typing import Any, Dict, Optional

from .codex_worker import CodexWorkerError, run_intent_with_codex_mcp
from .config import load_config
from .http_client import BackendClient, HttpError
from .intents import IntentError, RunIntent, parse_intent, parse_json_line
from .ledger import LedgerEntry, RunLedger


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def classify_failure(error: Exception) -> str:
    # Returns one of: HARD_STOP, ITEM_STOP, TRANSIENT
    if isinstance(error, IntentError):
        return "HARD_STOP"
    if isinstance(error, HttpError):
        if error.code in ("backend_unreachable",):
            return "TRANSIENT"
        if error.status_code == 409:
            return "ITEM_STOP"
        if error.status_code >= 500:
            return "TRANSIENT"
        # Backend 4xx is treated as fail-closed; caller can inspect payload.
        return "HARD_STOP"
    if isinstance(error, CodexWorkerError):
        return "HARD_STOP"
    return "HARD_STOP"


def exit_code_for_classification(classification: str) -> int:
    if classification == "TRANSIENT":
        return 4
    if classification == "HARD_STOP":
        return 2
    if classification == "ITEM_STOP":
        return 0
    return 2


class Runner:
    def __init__(self, *, backend: BackendClient, ledger: Optional[RunLedger], dry_run: bool, codex_bin: str, codex_mcp_args: str):
        self._backend = backend
        self._ledger = ledger
        self._dry_run = dry_run
        self._codex_bin = codex_bin
        self._codex_mcp_args = codex_mcp_args

        self._executor_queue: "queue.Queue[RunIntent]" = queue.Queue()
        self._reviewer_queue: "queue.Queue[RunIntent]" = queue.Queue()

        self._hard_stop_event = threading.Event()
        self._hard_stop_reason: Optional[str] = None

    def hard_stop(self, reason: str) -> None:
        self._hard_stop_reason = reason
        self._hard_stop_event.set()

    def enqueue(self, intent: RunIntent) -> None:
        if intent.role == "EXECUTOR":
            self._executor_queue.put(intent)
        else:
            self._reviewer_queue.put(intent)

    def should_stop(self) -> bool:
        return self._hard_stop_event.is_set()

    def stop_reason(self) -> str:
        return self._hard_stop_reason or "hard stop"

    def run_worker_loop(self, *, role: str) -> None:
        intent_queue = self._executor_queue if role == "EXECUTOR" else self._reviewer_queue

        while not self.should_stop():
            try:
                intent = intent_queue.get(timeout=0.2)
            except queue.Empty:
                continue

            try:
                self._handle_intent(intent)
            except Exception as exc:
                classification = classify_failure(exc)
                if classification == "ITEM_STOP":
                    _log_stderr({"type": "ITEM_STOP", "role": role, "run_id": intent.run_id, "error": str(exc)})
                else:
                    self.hard_stop(f"{classification}: {exc}")
            finally:
                intent_queue.task_done()

    def _handle_intent(self, intent: RunIntent) -> None:
        if self._dry_run:
            _log_stderr(
                {
                    "type": "DRY_RUN_INTENT",
                    "role": intent.role,
                    "run_id": intent.run_id,
                    "endpoint": intent.endpoint,
                    "body": intent.body,
                }
            )
            return

        if self._ledger:
            existing = self._ledger.get(intent.run_id)
            if existing and existing.get("status") == "succeeded":
                _log_stderr({"type": "LEDGER_SKIP", "run_id": intent.run_id, "reason": "already_succeeded"})
                return

            if not existing:
                self._ledger.upsert(
                    LedgerEntry(
                        run_id=intent.run_id,
                        role=intent.role,
                        intent_hash=intent.intent_hash,
                        received_at=_utc_now_iso(),
                        status="queued",
                        result=None,
                    )
                )
            self._ledger.mark_running(intent.run_id)

        try:
            # Bundle injection: fetch verbatim from backend.
            bundle = self._backend.get_agent_context(intent.role)

            # Execute via Codex MCP worker (Codex MCP server is spawned per intent).
            result = run_intent_with_codex_mcp(
                codex_bin=self._codex_bin,
                codex_mcp_args=self._codex_mcp_args,
                backend_base_url=self._backend.base_url,
                role_bundle=bundle,
                intent=intent.raw,
            )
        except Exception as exc:
            if self._ledger:
                self._ledger.mark_result(
                    intent.run_id,
                    status="failed",
                    result={"status": "failed", "summary": str(exc), "urls": {}, "errors": [{"error": str(exc)}]},
                )
            raise

        if self._ledger:
            self._ledger.mark_result(
                intent.run_id,
                status="succeeded" if result.status == "succeeded" else "failed",
                result={
                    "run_id": result.run_id,
                    "role": result.role,
                    "status": result.status,
                    "summary": result.summary,
                    "urls": result.urls,
                    "errors": result.errors,
                },
            )


def _log_stderr(obj: Dict[str, Any]) -> None:
    sys.stderr.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stderr.flush()


def _spawn_orchestrator(cmd: str, *, env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(
        cmd,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=None,  # inherit; prevents stderr pipe deadlocks
        text=True,
        env=env,
        bufsize=1,
    )


def _assert_codex_github_mcp_available(*, codex_bin: str) -> None:
    # Fail closed if Codex CLI isn't configured to expose GitHub MCP tools (github + github_projects).
    # Worker runbooks rely on these tools for PR/issue/project operations.
    try:
        completed = subprocess.run(
            [codex_bin, "mcp", "list"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexWorkerError("failed to check codex mcp configuration", code="codex_mcp_check_failed") from exc

    output = (completed.stdout or "") + "\n" + (completed.stderr or "")
    if completed.returncode != 0:
        raise CodexWorkerError(
            "codex mcp list failed",
            code="codex_mcp_check_failed",
            details={"exit_code": completed.returncode, "output": output.strip()[:2000]},
        )

    def has_enabled(name: str) -> bool:
        for line in output.splitlines():
            if line.strip().startswith(name):
                return "enabled" in line
        return False

    missing = [name for name in ("github", "github_projects") if not has_enabled(name)]
    if missing:
        raise CodexWorkerError(
            "required codex mcp servers are not enabled",
            code="codex_mcp_servers_missing",
            details={"missing": missing, "hint": "Run `codex mcp login github` and ensure GITHUB_PAT is set."},
        )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="runner")
    parser.add_argument("--dry-run", action="store_true", help="do not spawn Codex or call backend write endpoints")
    parser.add_argument("--once", action="store_true", help="run orchestrator once and exit")
    args = parser.parse_args(argv)

    try:
        config = load_config(dry_run_flag=args.dry_run, once_flag=args.once)
    except ValueError as exc:
        _log_stderr({"type": "CONFIG_ERROR", "error": str(exc)})
        return 2

    backend = BackendClient(base_url=config.backend_base_url)

    # Preflight gate.
    try:
        preflight = backend.preflight_orchestrator()
    except HttpError as exc:
        classification = classify_failure(exc)
        _log_stderr(
            {
                "type": classification,
                "reason": "backend_preflight_failed",
                "error": str(exc),
                "code": exc.code,
                "status_code": exc.status_code,
                "payload": exc.payload,
            }
        )
        return exit_code_for_classification(classification)

    if preflight.get("status") != "PASS":
        _log_stderr({"type": "HARD_STOP", "reason": "preflight_fail", "payload": preflight})
        return 2

    if not config.dry_run:
        try:
            _assert_codex_github_mcp_available(codex_bin=config.codex_bin)
        except CodexWorkerError as exc:
            _log_stderr({"type": "HARD_STOP", "reason": "codex_mcp_missing", "code": exc.code, "details": exc.details})
            return 2

    ledger: Optional[RunLedger] = None
    if not config.dry_run:
        ledger = RunLedger(config.ledger_path)

    runner = Runner(
        backend=backend,
        ledger=ledger,
        dry_run=config.dry_run,
        codex_bin=config.codex_bin,
        codex_mcp_args=config.codex_mcp_args,
    )

    # Spawn worker threads.
    workers: list[threading.Thread] = []
    for _ in range(config.runner_max_executors):
        thread = threading.Thread(target=runner.run_worker_loop, kwargs={"role": "EXECUTOR"}, daemon=True)
        thread.start()
        workers.append(thread)
    for _ in range(config.runner_max_reviewers):
        thread = threading.Thread(target=runner.run_worker_loop, kwargs={"role": "REVIEWER"}, daemon=True)
        thread.start()
        workers.append(thread)

    # Spawn orchestrator process. Runner passes through required sprint + backend url.
    orchestrator_env = dict(os.environ)
    orchestrator_env["ORCHESTRATOR_SPRINT"] = config.orchestrator_sprint
    orchestrator_env["ORCHESTRATOR_BACKEND_BASE_URL"] = config.backend_base_url
    if config.once:
        if "--loop" in config.orchestrator_cmd:
            orchestrator_cmd = config.orchestrator_cmd.replace("--loop", "--once")
        elif "--once" in config.orchestrator_cmd:
            orchestrator_cmd = config.orchestrator_cmd
        else:
            orchestrator_cmd = f"{config.orchestrator_cmd} --once"
    else:
        orchestrator_cmd = config.orchestrator_cmd

    proc = _spawn_orchestrator(orchestrator_cmd, env=orchestrator_env)
    assert proc.stdout is not None

    _log_stderr({"type": "RUNNER_STARTED", "dry_run": config.dry_run, "orchestrator_cmd": orchestrator_cmd})

    # Read intents from orchestrator stdout JSONL.
    try:
        for line in proc.stdout:
            if runner.should_stop():
                break
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = parse_json_line(stripped)
                intent = parse_intent(value)
            except IntentError as exc:
                runner.hard_stop(f"intent_error: {exc.code}: {exc}")
                break

            if ledger and ledger.get(intent.run_id) and ledger.get(intent.run_id).get("status") == "succeeded":
                _log_stderr({"type": "LEDGER_SKIP", "run_id": intent.run_id, "reason": "already_succeeded"})
                continue

            if ledger:
                ledger.upsert(
                    LedgerEntry(
                        run_id=intent.run_id,
                        role=intent.role,
                        intent_hash=intent.intent_hash,
                        received_at=_utc_now_iso(),
                        status="queued",
                        result=None,
                    )
                )

            runner.enqueue(intent)
    finally:
        try:
            proc.terminate()
        except Exception:
            pass

    if runner.should_stop():
        _log_stderr({"type": "HARD_STOP", "reason": runner.stop_reason()})
        return 2

    rc = proc.wait(timeout=5)
    if rc != 0:
        _log_stderr({"type": "HARD_STOP", "reason": "orchestrator_nonzero_exit", "exit_code": rc})
        return rc if rc in (2, 3, 4) else 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
