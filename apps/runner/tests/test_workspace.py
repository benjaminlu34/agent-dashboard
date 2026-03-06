from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from apps.runner.codex_worker import CodexWorkerError
from apps.runner.workspace import setup_worktree, teardown_worktree

_RUN_ID = "11111111-1111-4111-8111-111111111111"
_REPO_ROOT = "/tmp/root"
_BASE_DIR = "/tmp/.root-worktrees"
_CURRENT_UID = os.geteuid() if hasattr(os, "geteuid") else 0
_DIR_STAT = os.stat_result((stat.S_IFDIR | 0o700, 0, 0, 0, _CURRENT_UID, 0, 0, 0, 0, 0))


class WorkspaceTests(unittest.TestCase):
    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_returns_expected_path(self, run_mock, _mkdir, _lstat) -> None:
        run_mock.return_value = subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr="")

        result = setup_worktree(_REPO_ROOT, _RUN_ID)

        self.assertEqual(result, f"{_BASE_DIR}/{_RUN_ID}")
        run_mock.assert_called_once_with(
            ["git", "worktree", "add", "--detach", f"{_BASE_DIR}/{_RUN_ID}"],
            cwd=_REPO_ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_retries_lock_errors(self, run_mock, _mkdir, _lstat, uniform_mock, sleep_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(
                128,
                ["git"],
                output="",
                stderr="fatal: Unable to create '/repo/.git/index.lock': File exists.",
            ),
            subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr=""),
        ]

        result = setup_worktree(_REPO_ROOT, _RUN_ID)

        self.assertEqual(result, f"{_BASE_DIR}/{_RUN_ID}")
        self.assertEqual(run_mock.call_count, 2)
        uniform_mock.assert_called_once_with(0.1, 1.0)
        sleep_mock.assert_called_once_with(0.25)

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_does_not_retry_non_lock_errors(self, run_mock, _mkdir, _lstat, uniform_mock, sleep_mock) -> None:
        run_mock.side_effect = subprocess.CalledProcessError(
            128,
            ["git"],
            output="",
            stderr="fatal: not a git repository",
        )

        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree(_REPO_ROOT, _RUN_ID)

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertEqual(run_mock.call_count, 1)
        uniform_mock.assert_not_called()
        sleep_mock.assert_not_called()

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_raises_after_retry_limit(self, run_mock, _mkdir, _lstat, uniform_mock, sleep_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(
                128,
                ["git"],
                output="",
                stderr="fatal: Unable to create '/repo/.git/index.lock': File exists.",
            )
            for _ in range(5)
        ]

        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree(_REPO_ROOT, _RUN_ID)

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertEqual(run_mock.call_count, 5)
        self.assertEqual(uniform_mock.call_count, 4)
        self.assertEqual(sleep_mock.call_count, 4)

    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_rejects_non_uuid_run_id(self, run_mock, _mkdir, _lstat) -> None:
        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree(_REPO_ROOT, "../escape")

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertIn("UUIDv4", str(ctx.exception))
        run_mock.assert_not_called()

    @patch("apps.runner.workspace.os.lstat", return_value=_DIR_STAT)
    @patch("pathlib.Path.mkdir")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_rejects_absolute_path_run_id(self, run_mock, _mkdir, _lstat) -> None:
        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree(_REPO_ROOT, "/etc/passwd")

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        run_mock.assert_not_called()

    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_rejects_symlinked_base_dir(self, run_mock) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root_dir = Path(tmpdir) / "root"
            root_dir.mkdir()
            target_dir = Path(tmpdir) / "target"
            target_dir.mkdir()
            (Path(tmpdir) / ".root-worktrees").symlink_to(target_dir, target_is_directory=True)

            with self.assertRaises(CodexWorkerError) as ctx:
                setup_worktree(str(root_dir), _RUN_ID)

            self.assertEqual(ctx.exception.code, "workspace_setup_failed")
            self.assertIn("must not be a symlink", str(ctx.exception))
            run_mock.assert_not_called()

    @patch("apps.runner.workspace.subprocess.run")
    def test_teardown_worktree_removes_with_repo_root_cwd(self, run_mock) -> None:
        run_mock.return_value = subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr="")

        teardown_worktree(_REPO_ROOT, f"{_BASE_DIR}/{_RUN_ID}")

        run_mock.assert_called_once_with(
            ["git", "worktree", "remove", "--force", f"{_BASE_DIR}/{_RUN_ID}"],
            cwd=_REPO_ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @patch("apps.runner.workspace.subprocess.run")
    @patch("apps.runner.workspace._log_stderr")
    def test_teardown_worktree_prunes_when_remove_fails(self, log_mock, run_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(1, ["git"], output="", stderr="busy"),
            subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr=""),
        ]

        teardown_worktree(_REPO_ROOT, f"{_BASE_DIR}/{_RUN_ID}")

        self.assertEqual(run_mock.call_count, 2)
        log_mock.assert_called_once()
        self.assertEqual(
            run_mock.call_args_list[1].kwargs,
            {
                "cwd": _REPO_ROOT,
                "check": False,
                "text": True,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
            },
        )
        self.assertEqual(run_mock.call_args_list[1].args[0], ["git", "worktree", "prune"])

    @patch("apps.runner.workspace.subprocess.run")
    @patch("apps.runner.workspace._log_stderr")
    def test_teardown_worktree_swallows_prune_failures(self, log_mock, run_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(1, ["git"], output="", stderr="busy"),
            OSError("prune failed"),
        ]

        teardown_worktree(_REPO_ROOT, f"{_BASE_DIR}/{_RUN_ID}")

        self.assertEqual(run_mock.call_count, 2)
        self.assertEqual(log_mock.call_count, 2)
