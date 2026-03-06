from __future__ import annotations

import random
import subprocess
import tempfile
import time
from pathlib import Path

from .codex_worker import CodexWorkerError

_WORKTREE_RETRY_ATTEMPTS = 5
_WORKTREE_RETRY_MIN_DELAY_S = 0.1
_WORKTREE_RETRY_MAX_DELAY_S = 1.0
_WORKTREE_ERROR_CLIP_CHARS = 2000


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
    if not normalized_run_id:
        raise _workspace_error(
            "run_id is required for worktree setup",
            repo_root=normalized_repo_root,
            run_id="",
            worktree_path="",
            attempts=0,
        )

    resolved_repo_root = str(Path(normalized_repo_root).resolve())
    worktree_path = str((Path(tempfile.gettempdir()) / "agent-worktrees" / normalized_run_id).resolve())
    Path(worktree_path).parent.mkdir(parents=True, exist_ok=True)

    last_error: subprocess.CalledProcessError | None = None
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
            last_error = exc
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

    if last_error is not None:
        raise _workspace_error(
            "failed to create isolated git worktree",
            repo_root=resolved_repo_root,
            run_id=normalized_run_id,
            worktree_path=worktree_path,
            attempts=_WORKTREE_RETRY_ATTEMPTS,
            stdout=str(last_error.stdout or ""),
            stderr=str(last_error.stderr or ""),
        ) from last_error
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
    except Exception:
        pass

    try:
        subprocess.run(
            ["git", "worktree", "prune"],
            cwd=resolved_repo_root,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception:
        return
