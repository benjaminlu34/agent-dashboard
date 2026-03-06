from __future__ import annotations

import subprocess
import unittest
from unittest.mock import patch

from apps.runner.codex_worker import CodexWorkerError
from apps.runner.workspace import setup_worktree, teardown_worktree

_RUN_ID = "11111111-1111-4111-8111-111111111111"


class WorkspaceTests(unittest.TestCase):
    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_returns_expected_path(self, run_mock, _gettempdir) -> None:
        run_mock.return_value = subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr="")

        result = setup_worktree("/repo/root", _RUN_ID)

        self.assertEqual(result, f"/tmp/workspaces/agent-worktrees/{_RUN_ID}")
        run_mock.assert_called_once_with(
            ["git", "worktree", "add", "--detach", f"/tmp/workspaces/agent-worktrees/{_RUN_ID}"],
            cwd="/repo/root",
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_retries_lock_errors(self, run_mock, _gettempdir, uniform_mock, sleep_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(
                128,
                ["git"],
                output="",
                stderr="fatal: Unable to create '/repo/.git/index.lock': File exists.",
            ),
            subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr=""),
        ]

        result = setup_worktree("/repo/root", _RUN_ID)

        self.assertEqual(result, f"/tmp/workspaces/agent-worktrees/{_RUN_ID}")
        self.assertEqual(run_mock.call_count, 2)
        uniform_mock.assert_called_once_with(0.1, 1.0)
        sleep_mock.assert_called_once_with(0.25)

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_does_not_retry_non_lock_errors(self, run_mock, _gettempdir, uniform_mock, sleep_mock) -> None:
        run_mock.side_effect = subprocess.CalledProcessError(
            128,
            ["git"],
            output="",
            stderr="fatal: not a git repository",
        )

        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree("/repo/root", _RUN_ID)

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertEqual(run_mock.call_count, 1)
        uniform_mock.assert_not_called()
        sleep_mock.assert_not_called()

    @patch("apps.runner.workspace.time.sleep")
    @patch("apps.runner.workspace.random.uniform", return_value=0.25)
    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_raises_after_retry_limit(self, run_mock, _gettempdir, uniform_mock, sleep_mock) -> None:
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
            setup_worktree("/repo/root", _RUN_ID)

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertEqual(run_mock.call_count, 5)
        self.assertEqual(uniform_mock.call_count, 4)
        self.assertEqual(sleep_mock.call_count, 4)

    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_rejects_non_uuid_run_id(self, run_mock, _gettempdir) -> None:
        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree("/repo/root", "../escape")

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        self.assertIn("UUIDv4", str(ctx.exception))
        run_mock.assert_not_called()

    @patch("apps.runner.workspace.tempfile.gettempdir", return_value="/tmp/workspaces")
    @patch("apps.runner.workspace.subprocess.run")
    def test_setup_worktree_rejects_absolute_path_run_id(self, run_mock, _gettempdir) -> None:
        with self.assertRaises(CodexWorkerError) as ctx:
            setup_worktree("/repo/root", "/etc/passwd")

        self.assertEqual(ctx.exception.code, "workspace_setup_failed")
        run_mock.assert_not_called()

    @patch("apps.runner.workspace.subprocess.run")
    def test_teardown_worktree_removes_with_repo_root_cwd(self, run_mock) -> None:
        run_mock.return_value = subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr="")

        teardown_worktree("/repo/root", f"/tmp/workspaces/agent-worktrees/{_RUN_ID}")

        run_mock.assert_called_once_with(
            ["git", "worktree", "remove", "--force", f"/tmp/workspaces/agent-worktrees/{_RUN_ID}"],
            cwd="/repo/root",
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    @patch("apps.runner.workspace.subprocess.run")
    def test_teardown_worktree_prunes_when_remove_fails(self, run_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(1, ["git"], output="", stderr="busy"),
            subprocess.CompletedProcess(args=["git"], returncode=0, stdout="", stderr=""),
        ]

        teardown_worktree("/repo/root", f"/tmp/workspaces/agent-worktrees/{_RUN_ID}")

        self.assertEqual(run_mock.call_count, 2)
        self.assertEqual(
            run_mock.call_args_list[1].kwargs,
            {
                "cwd": "/repo/root",
                "check": False,
                "text": True,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.PIPE,
            },
        )
        self.assertEqual(run_mock.call_args_list[1].args[0], ["git", "worktree", "prune"])

    @patch("apps.runner.workspace.subprocess.run")
    def test_teardown_worktree_swallows_prune_failures(self, run_mock) -> None:
        run_mock.side_effect = [
            subprocess.CalledProcessError(1, ["git"], output="", stderr="busy"),
            OSError("prune failed"),
        ]

        teardown_worktree("/repo/root", f"/tmp/workspaces/agent-worktrees/{_RUN_ID}")

        self.assertEqual(run_mock.call_count, 2)
