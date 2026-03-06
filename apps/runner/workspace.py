from __future__ import annotations

import json
import os
import random
import re
import stat
import subprocess
import sys
import time
from pathlib import Path

from .codex_worker import CodexWorkerError

_RUN_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
_WORKTREE_RETRY_ATTEMPTS = 5
_WORKTREE_RETRY_MIN_DELAY_S = 0.1
_WORKTREE_RETRY_MAX_DELAY_S = 1.0
_WORKTREE_ERROR_CLIP_CHARS = 2000


def _log_stderr(payload: dict[str, object]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


def _clip_output(value: str) -> str:
    text = str(value or "").strip()
    if len(text) <= _WORKTREE_ERROR_CLIP_CHARS:
        return text
    return text[: _WORKTREE_ERROR_CLIP_CHARS - 3].rstrip() + "..."


def _is_retryable_worktree_lock_error(exc: subprocess.CalledProcessError) -> bool:
    combined = "\n".join(
        part for part in (str(getattr(exc, "stdout", "") or ""), str(getattr(exc, "stderr", "") or "")) if part
    ).lower()
    return any(
        token in combined
        for token in (
            "index.lock",
            "unable to create",
            "file exists",
            "another git process",
        )
    )


def _workspace_error(
    message: str,
    *,
    repo_root: str,
    run_id: str,
    worktree_path: str,
    attempts: int,
    stdout: str = "",
    stderr: str = "",
    error: str = "",
) -> CodexWorkerError:
    details = {
        "repo_root": repo_root,
        "run_id": run_id,
        "worktree_path": worktree_path,
        "attempts": attempts,
    }
    if stdout:
        details["stdout"] = _clip_output(stdout)
    if stderr:
        details["stderr"] = _clip_output(stderr)
    if error:
        details["error"] = _clip_output(error)
    return CodexWorkerError(message, code="workspace_setup_failed", details=details)


def _resolve_worktree_base(repo_root: str) -> Path:
    repo_root_path = Path(repo_root).resolve()
    base_dir = repo_root_path.parent / f".{repo_root_path.name}-worktrees"

    try:
        base_dir.mkdir(mode=0o700)
    except FileExistsError:
        pass

    try:
        stat_result = os.lstat(base_dir)
    except OSError as exc:
        raise _workspace_error(
            "failed to inspect worktree base directory",
            repo_root=str(repo_root_path),
            run_id="",
            worktree_path=str(base_dir),
            attempts=0,
            error=str(exc),
        ) from exc

    if stat.S_ISLNK(stat_result.st_mode):
        raise _workspace_error(
            "worktree base directory must not be a symlink",
            repo_root=str(repo_root_path),
            run_id="",
            worktree_path=str(base_dir),
            attempts=0,
        )
    if not stat.S_ISDIR(stat_result.st_mode):
        raise _workspace_error(
            "worktree base path must be a directory",
            repo_root=str(repo_root_path),
            run_id="",
            worktree_path=str(base_dir),
            attempts=0,
        )
    if hasattr(os, "geteuid") and stat_result.st_uid != os.geteuid():
        raise _workspace_error(
            "worktree base directory must be owned by the current user",
            repo_root=str(repo_root_path),
            run_id="",
            worktree_path=str(base_dir),
            attempts=0,
        )

    try:
        current_mode = stat.S_IMODE(stat_result.st_mode)
        if current_mode != 0o700:
            os.chmod(base_dir, 0o700)
    except OSError as exc:
        raise _workspace_error(
            "failed to secure worktree base directory permissions",
            repo_root=str(repo_root_path),
            run_id="",
            worktree_path=str(base_dir),
            attempts=0,
            error=str(exc),
        ) from exc

    return base_dir.resolve()


def _resolve_worktree_path(*, repo_root: str, run_id: str) -> str:
    normalized_run_id = str(run_id or "").strip()
    if not _RUN_ID_RE.fullmatch(normalized_run_id):
        raise _workspace_error(
            "run_id must be a UUIDv4 for worktree setup",
            repo_root=str(repo_root or ""),
            run_id=normalized_run_id,
            worktree_path="",
            attempts=0,
        )

    base_dir = _resolve_worktree_base(repo_root)
    worktree_path = (base_dir / normalized_run_id).resolve()
    try:
        worktree_path.relative_to(base_dir)
    except ValueError as exc:
        raise _workspace_error(
            "run_id resolved outside worktree base directory",
            repo_root=str(repo_root or ""),
            run_id=normalized_run_id,
            worktree_path=str(worktree_path),
            attempts=0,
        ) from exc
    return str(worktree_path)


def setup_worktree(repo_root: str, run_id: str) -> str:
    normalized_repo_root = str(repo_root or "").strip()
    normalized_run_id = str(run_id or "").strip()
    if not normalized_repo_root:
        raise _workspace_error(
            "repo_root is required for worktree setup",
            repo_root="",
            run_id=normalized_run_id,
            worktree_path="",
            attempts=0,
        )

    resolved_repo_root = str(Path(normalized_repo_root).resolve())
    worktree_path = _resolve_worktree_path(repo_root=resolved_repo_root, run_id=normalized_run_id)

    for attempt in range(1, _WORKTREE_RETRY_ATTEMPTS + 1):
        try:
            subprocess.run(
                ["git", "worktree", "add", "--detach", worktree_path],
                cwd=resolved_repo_root,
                check=True,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            return worktree_path
        except subprocess.CalledProcessError as exc:
            if attempt >= _WORKTREE_RETRY_ATTEMPTS or not _is_retryable_worktree_lock_error(exc):
                raise _workspace_error(
                    "failed to create isolated git worktree",
                    repo_root=resolved_repo_root,
                    run_id=normalized_run_id,
                    worktree_path=worktree_path,
                    attempts=attempt,
                    stdout=str(exc.stdout or ""),
                    stderr=str(exc.stderr or ""),
                ) from exc
            time.sleep(random.uniform(_WORKTREE_RETRY_MIN_DELAY_S, _WORKTREE_RETRY_MAX_DELAY_S))
        except FileNotFoundError as exc:
            raise _workspace_error(
                "git binary not found during worktree setup",
                repo_root=resolved_repo_root,
                run_id=normalized_run_id,
                worktree_path=worktree_path,
                attempts=1,
                error=str(exc),
            ) from exc
        except OSError as exc:
            raise _workspace_error(
                "os error during worktree setup",
                repo_root=resolved_repo_root,
                run_id=normalized_run_id,
                worktree_path=worktree_path,
                attempts=1,
                error=str(exc),
            ) from exc
        except Exception as exc:
            raise _workspace_error(
                "unexpected error during worktree setup",
                repo_root=resolved_repo_root,
                run_id=normalized_run_id,
                worktree_path=worktree_path,
                attempts=1,
                error=str(exc),
            ) from exc

    raise _workspace_error(
        "failed to create isolated git worktree",
        repo_root=resolved_repo_root,
        run_id=normalized_run_id,
        worktree_path=worktree_path,
        attempts=_WORKTREE_RETRY_ATTEMPTS,
    )


def teardown_worktree(repo_root: str, worktree_path: str) -> None:
    normalized_repo_root = str(repo_root or "").strip()
    normalized_worktree_path = str(worktree_path or "").strip()
    if not normalized_repo_root or not normalized_worktree_path:
        return

    resolved_repo_root = str(Path(normalized_repo_root).resolve())
    resolved_worktree_path = str(Path(normalized_worktree_path).resolve())
    try:
        subprocess.run(
            ["git", "worktree", "remove", "--force", resolved_worktree_path],
            cwd=resolved_repo_root,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return
    except (subprocess.CalledProcessError, FileNotFoundError, OSError) as exc:
        _log_stderr(
            {
                "type": "WORKTREE_REMOVE_FAILED",
                "repo_root": resolved_repo_root,
                "worktree_path": resolved_worktree_path,
                "error": str(exc),
            }
        )

    try:
        completed = subprocess.run(
            ["git", "worktree", "prune"],
            cwd=resolved_repo_root,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError) as exc:
        _log_stderr(
            {
                "type": "WORKTREE_PRUNE_FAILED",
                "repo_root": resolved_repo_root,
                "worktree_path": resolved_worktree_path,
                "error": str(exc),
            }
        )
        return
    if int(completed.returncode or 0) != 0:
        _log_stderr(
            {
                "type": "WORKTREE_PRUNE_FAILED",
                "repo_root": resolved_repo_root,
                "worktree_path": resolved_worktree_path,
                "exit_code": completed.returncode,
                "stdout": _clip_output(str(completed.stdout or "")),
                "stderr": _clip_output(str(completed.stderr or "")),
            }
        )
