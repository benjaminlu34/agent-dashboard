import contextlib
import io
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from apps.runner import runner


class _BackendStub:
    def __init__(self, base_url: str, timeout_s: float = 120.0) -> None:
        self.base_url = base_url
        self.timeout_s = timeout_s

    def preflight_orchestrator(self):
        return {"status": "PASS"}

    def get_agent_context(self, role: str):
        raise AssertionError(f"unexpected get_agent_context call for role={role}")

    def get_project_items_metadata(self, *, role: str, sprint: str):
        _ = role
        _ = sprint
        return {"role": "ORCHESTRATOR", "sprint": "M1", "as_of": "2026-02-27T00:00:00Z", "items": []}


class _ProcStub:
    def __init__(self) -> None:
        r_out, w_out = os.pipe()
        r_err, w_err = os.pipe()
        # Close write ends immediately so reads return EOF.
        os.close(w_out)
        os.close(w_err)
        self.stdout = os.fdopen(r_out, "r", encoding="utf-8", closefd=True)
        self.stderr = os.fdopen(r_err, "r", encoding="utf-8", closefd=True)

    def poll(self):
        return 0

    def terminate(self) -> None:
        return None

    def wait(self, timeout: int = 5) -> int:
        return 0


class _ProcSummaryStub:
    def __init__(self, summary_payload: dict) -> None:
        r_out, w_out = os.pipe()
        r_err, w_err = os.pipe()

        os.close(w_out)
        stderr_handle = os.fdopen(w_err, "w", encoding="utf-8", closefd=True)
        stderr_handle.write(json.dumps(summary_payload) + "\n")
        stderr_handle.flush()
        stderr_handle.close()

        self.stdout = os.fdopen(r_out, "r", encoding="utf-8", closefd=True)
        self.stderr = os.fdopen(r_err, "r", encoding="utf-8", closefd=True)
        self._poll_calls = 0

    def poll(self):
        self._poll_calls += 1
        if self._poll_calls < 3:
            return None
        return 0

    def terminate(self) -> None:
        return None

    def wait(self, timeout: int = 5) -> int:
        return 0


class RunnerCliModeTests(unittest.TestCase):
    def test_loop_without_kickoff_with_sprint_spawns_orchestrator(self) -> None:
        captured = {"env": None, "cmd": None}

        def _spawn(cmd: str, *, env):
            captured["cmd"] = cmd
            captured["env"] = dict(env)
            return _ProcStub()

        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            plan_path = f"{tmp_dir}/runner-sprint-plan.json"
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            plan_version = "2026-02-28T00:00:00.000Z"
            with open(state_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint_phase": "ACTIVE", "sealed_at": plan_version, "poll_count": 0, "items": {}}, handle)
            with open(plan_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint": "M1", "plan_version": plan_version, "tasks": []}, handle)
            with open(ledger_path, "w", encoding="utf-8") as handle:
                json.dump({"plan_version": plan_version, "runs": {}, "tasks": {}}, handle)

            env = {
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_STATE_PATH": state_path,
                "RUNNER_SPRINT_PLAN_PATH": plan_path,
                "RUNNER_LEDGER_PATH": ledger_path,
            }
            with patch.dict(os.environ, env, clear=True):
                with patch("apps.runner.runner.BackendClient", _BackendStub):
                    with patch("apps.runner.runner._spawn_orchestrator", _spawn):
                        stderr = io.StringIO()
                        with contextlib.redirect_stderr(stderr):
                            exit_code = runner.main(["--loop", "--dry-run", "--sprint", "M1"])

        self.assertEqual(exit_code, 0)
        self.assertIsNotNone(captured["env"])
        assert captured["env"] is not None
        self.assertEqual(captured["env"].get("ORCHESTRATOR_SPRINT"), "M1")
        self.assertEqual(captured["env"].get("ORCHESTRATOR_MAX_EXECUTORS"), "3")
        self.assertEqual(captured["env"].get("ORCHESTRATOR_MAX_REVIEWERS"), "2")
        self.assertIn("--loop", str(captured["cmd"]))

    def test_loop_closes_orchestrator_pipes(self) -> None:
        captured: dict[str, object] = {}

        def _spawn(cmd: str, *, env):
            _ = cmd
            _ = env
            proc = _ProcStub()
            captured["proc"] = proc
            return proc

        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            plan_path = f"{tmp_dir}/runner-sprint-plan.json"
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            plan_version = "2026-02-28T00:00:00.000Z"
            with open(state_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint_phase": "ACTIVE", "sealed_at": plan_version, "poll_count": 0, "items": {}}, handle)
            with open(plan_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint": "M1", "plan_version": plan_version, "tasks": []}, handle)
            with open(ledger_path, "w", encoding="utf-8") as handle:
                json.dump({"plan_version": plan_version, "runs": {}, "tasks": {}}, handle)

            env = {
                "BACKEND_BASE_URL": "http://localhost:4000",
                "ORCHESTRATOR_STATE_PATH": state_path,
                "RUNNER_SPRINT_PLAN_PATH": plan_path,
                "RUNNER_LEDGER_PATH": ledger_path,
            }
            with patch.dict(os.environ, env, clear=True):
                with patch("apps.runner.runner.BackendClient", _BackendStub):
                    with patch("apps.runner.runner._spawn_orchestrator", _spawn):
                        exit_code = runner.main(["--loop", "--dry-run", "--sprint", "M1"])

        self.assertEqual(exit_code, 0)
        proc = captured.get("proc")
        assert isinstance(proc, _ProcStub)
        self.assertTrue(proc.stdout.closed)
        self.assertTrue(proc.stderr.closed)

    def test_loop_without_kickoff_without_sprint_is_config_error(self) -> None:
        with patch.dict(os.environ, {"BACKEND_BASE_URL": "http://localhost:4000"}, clear=True):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                exit_code = runner.main(["--loop", "--dry-run"])

        self.assertEqual(exit_code, 2)
        self.assertIn("CONFIG_ERROR", stderr.getvalue())
        self.assertIn("sprint is required", stderr.getvalue())

    def test_goal_file_without_kickoff_is_config_error(self) -> None:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as handle:
            handle.write("goal")
            path = handle.name

        try:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                exit_code = runner.main(["--goal-file", path, "--dry-run", "--once"])
            self.assertEqual(exit_code, 2)
            self.assertIn("requires --kickoff", stderr.getvalue())
        finally:
            os.unlink(path)

    def test_kickoff_without_goal_is_config_error(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            exit_code = runner.main(["--kickoff", "--dry-run", "--once", "--sprint", "M1"])

        self.assertEqual(exit_code, 2)
        self.assertIn("requires --goal or --goal-file", stderr.getvalue())

    def test_kickoff_creates_orchestrator_ledger_run_and_passes_transcript_run_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            config = SimpleNamespace(
                backend_base_url="http://localhost:4000",
                backend_timeout_s=120.0,
                dry_run=False,
                orchestrator_sprint="M1",
                codex_bin="codex",
                codex_mcp_args="mcp-server",
                codex_tools_call_timeout_s=600.0,
                sprint_plan_path=f"{tmp_dir}/runner-sprint-plan.json",
                orchestrator_sanitization_regen_attempts=2,
                orchestrator_state_path=f"{tmp_dir}/orchestrator-state.json",
                ledger_path=ledger_path,
                runner_max_executors=1,
                runner_max_reviewers=1,
                review_stall_polls=50,
                blocked_retry_minutes=15,
                watchdog_timeout_s=900,
                once=False,
            )

            kickoff_payload = {
                "sprint": "M1",
                "goal_issue": {
                    "title": "[SPRINT GOAL] M1: Ship kickoff",
                    "body_markdown": (
                        "## Goal\nShip kickoff.\n\n"
                        "## Non-goals\n- None\n\n"
                        "## Acceptance Criteria\n- [ ] Plan exists\n\n"
                        "## Files Likely Touched\n- apps/runner/\n\n"
                        "## Definition of Done\n- [ ] Applied\n"
                    ),
                    "labels": ["meta:sprint-goal"],
                    "fields": {"Sprint": "M1", "Status": "Backlog", "Priority": "P0", "Size": "S", "Area": "docs"},
                },
                "tasks": [
                    {
                        "title": "[TASK] One",
                        "body_markdown": (
                            "## Goal\nDo one.\n\n"
                            "## Non-goals\n- None\n\n"
                            "## Acceptance Criteria\n- [ ] Done\n\n"
                            "## Files Likely Touched\n- apps/runner/\n\n"
                            "## Definition of Done\n- [ ] Checked\n"
                        ),
                        "priority": "P0",
                        "size": "S",
                        "area": "runner",
                        "depends_on_titles": [],
                        "initial_status": "Backlog",
                    },
                    {
                        "title": "[TASK] Two",
                        "body_markdown": (
                            "## Goal\nDo two.\n\n"
                            "## Non-goals\n- None\n\n"
                            "## Acceptance Criteria\n- [ ] Done\n\n"
                            "## Files Likely Touched\n- apps/runner/\n\n"
                            "## Definition of Done\n- [ ] Checked\n"
                        ),
                        "priority": "P1",
                        "size": "S",
                        "area": "runner",
                        "depends_on_titles": [],
                        "initial_status": "Backlog",
                    },
                    {
                        "title": "[TASK] Three",
                        "body_markdown": (
                            "## Goal\nDo three.\n\n"
                            "## Non-goals\n- None\n\n"
                            "## Acceptance Criteria\n- [ ] Done\n\n"
                            "## Files Likely Touched\n- apps/runner/\n\n"
                            "## Definition of Done\n- [ ] Checked\n"
                        ),
                        "priority": "P1",
                        "size": "S",
                        "area": "runner",
                        "depends_on_titles": [],
                        "initial_status": "Backlog",
                    },
                ],
                "ready_set_titles": ["[TASK] One"],
                "prioritization_rationale": "Start with a dependency-free P0 task.",
            }

            class _KickoffBackendStub:
                def __init__(self, base_url: str, timeout_s: float = 120.0) -> None:
                    self.base_url = base_url
                    self.timeout_s = timeout_s

                def preflight_orchestrator(self):
                    return {"status": "PASS"}

                def get_agent_context(self, role: str):
                    self.last_role = role
                    return {"role": role, "files": []}

                def get_project_items_metadata(self, *, role: str, sprint: str):
                    _ = role
                    _ = sprint
                    return {"role": "ORCHESTRATOR", "sprint": "M1", "as_of": "2026-02-27T00:00:00Z", "items": []}

            with patch("apps.runner.runner.load_config", return_value=config):
                with patch("apps.runner.runner.BackendClient", _KickoffBackendStub):
                    with patch("apps.runner.runner.generate_json_with_codex_mcp", return_value=kickoff_payload) as mock_generate:
                        with patch("apps.runner.runner._apply_kickoff_plan", return_value={"status": "APPLIED", "promoted": []}):
                            exit_code = runner.main(["--kickoff", "--goal", "Ship kickoff", "--sprint", "M1"])

            self.assertEqual(exit_code, 0)
            with open(ledger_path, "r", encoding="utf-8") as handle:
                ledger_payload = json.load(handle)
            self.assertIn("runs", ledger_payload)
            self.assertEqual(len(ledger_payload["runs"]), 1)
            entry = next(iter(ledger_payload["runs"].values()))
            self.assertEqual(entry.get("role"), "ORCHESTRATOR")
            self.assertEqual(entry.get("status"), "succeeded")
            self.assertTrue(str(entry.get("run_id", "")).startswith("kickoff-"))

            generate_kwargs = mock_generate.call_args.kwargs
            self.assertEqual(generate_kwargs.get("run_id"), entry.get("run_id"))
            self.assertTrue(isinstance(generate_kwargs.get("repo_root"), str))
            self.assertTrue(len(generate_kwargs.get("repo_root")) > 0)

    def test_runner_loop_creates_orchestrator_run_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            orchestrator_state_path = f"{tmp_dir}/orchestrator-state.json"
            plan_version = "2026-02-28T00:00:00.000Z"
            config = SimpleNamespace(
                backend_base_url="http://localhost:4000",
                backend_timeout_s=120.0,
                dry_run=False,
                orchestrator_sprint="M1",
                codex_bin="codex",
                codex_mcp_args="mcp-server",
                codex_tools_call_timeout_s=600.0,
                sprint_plan_path=f"{tmp_dir}/runner-sprint-plan.json",
                orchestrator_sanitization_regen_attempts=2,
                orchestrator_state_path=orchestrator_state_path,
                ledger_path=ledger_path,
                runner_max_executors=1,
                runner_max_reviewers=1,
                review_stall_polls=50,
                blocked_retry_minutes=15,
                watchdog_timeout_s=900,
                once=False,
                orchestrator_cmd="node apps/orchestrator/src/cli.js --loop",
                runner_ready_buffer=2,
                autopromote=True,
            )
            transcript_run_ids = []

            with open(orchestrator_state_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint_phase": "ACTIVE", "sealed_at": plan_version, "poll_count": 0, "items": {}}, handle)
            with open(config.sprint_plan_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint": "M1", "plan_version": plan_version, "tasks": []}, handle)
            with open(ledger_path, "w", encoding="utf-8") as handle:
                json.dump({"plan_version": plan_version, "runs": {}, "tasks": {}}, handle)

            class _TranscriptStub:
                def __init__(self, *, repo_root: str, run_id: str, **_kwargs: object) -> None:
                    _ = repo_root
                    transcript_run_ids.append(run_id)

                def append_message_to_agent(self, _content: str) -> None:
                    return None

                def append_agent_thinking(self, _content: str) -> None:
                    return None

                def append_system_observation(self, _content: str) -> None:
                    return None

                def close(self) -> None:
                    return None

            with patch("apps.runner.runner.load_config", return_value=config):
                with patch("apps.runner.runner.BackendClient", _BackendStub):
                    with patch("apps.runner.runner._assert_codex_github_mcp_available", return_value=None):
                        with patch("apps.runner.runner._spawn_orchestrator", return_value=_ProcStub()):
                            with patch("apps.runner.runner._RunTranscriptWriter", _TranscriptStub):
                                exit_code = runner.main(["--loop", "--sprint", "M1"])

            self.assertEqual(exit_code, 0)
            with open(ledger_path, "r", encoding="utf-8") as handle:
                ledger_payload = json.load(handle)
            self.assertIn("runs", ledger_payload)
            self.assertEqual(len(ledger_payload["runs"]), 1)
            entry = next(iter(ledger_payload["runs"].values()))
            self.assertEqual(entry.get("role"), "ORCHESTRATOR")
            self.assertEqual(entry.get("status"), "succeeded")
            run_id = str(entry.get("run_id", ""))
            self.assertTrue(run_id.startswith("orchestrator-loop-"))
            self.assertEqual(transcript_run_ids, [run_id])

    def test_dispatch_summary_handlers_run_even_when_autopromote_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            ledger_path = f"{tmp_dir}/runner-ledger.json"
            orchestrator_state_path = f"{tmp_dir}/orchestrator-state.json"
            plan_version = "2026-02-28T00:00:00.000Z"
            config = SimpleNamespace(
                backend_base_url="http://localhost:4000",
                backend_timeout_s=120.0,
                dry_run=False,
                orchestrator_sprint="M1",
                codex_bin="codex",
                codex_mcp_args="mcp-server",
                codex_tools_call_timeout_s=600.0,
                sprint_plan_path=f"{tmp_dir}/runner-sprint-plan.json",
                orchestrator_sanitization_regen_attempts=2,
                orchestrator_state_path=orchestrator_state_path,
                ledger_path=ledger_path,
                runner_max_executors=1,
                runner_max_reviewers=1,
                review_stall_polls=50,
                blocked_retry_minutes=15,
                watchdog_timeout_s=900,
                once=False,
                orchestrator_cmd="node apps/orchestrator/src/cli.js --loop",
                runner_ready_buffer=2,
                autopromote=False,
            )
            summary_payload = {
                "type": "DISPATCH_SUMMARY",
                "sprint": "M1",
                "poll_count": 1,
                "status_counts": {"In Review": 1},
                "intents_emitted": {"EXECUTOR": 0, "REVIEWER": 0, "total": 0},
                "processed_items": [{"issue_number": 4, "project_item_id": "PVTI_4", "status": "In Review"}],
                "needs_attention": {"stalled_in_progress": [], "in_review_churn": []},
                "skipped": {},
            }

            with open(orchestrator_state_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint_phase": "ACTIVE", "sealed_at": plan_version, "poll_count": 0, "items": {}}, handle)
            with open(config.sprint_plan_path, "w", encoding="utf-8") as handle:
                json.dump({"sprint": "M1", "plan_version": plan_version, "tasks": []}, handle)
            with open(ledger_path, "w", encoding="utf-8") as handle:
                json.dump({"plan_version": plan_version, "runs": {}, "tasks": {}}, handle)

            class _TranscriptStub:
                def __init__(self, *, repo_root: str, run_id: str, **_kwargs: object) -> None:
                    _ = repo_root
                    _ = run_id

                def append_message_to_agent(self, _content: str) -> None:
                    return None

                def append_agent_thinking(self, _content: str) -> None:
                    return None

                def append_system_observation(self, _content: str) -> None:
                    return None

                def close(self) -> None:
                    return None

            with patch("apps.runner.runner.load_config", return_value=config):
                with patch("apps.runner.runner.BackendClient", _BackendStub):
                    with patch("apps.runner.runner._assert_codex_github_mcp_available", return_value=None):
                        with patch("apps.runner.runner._spawn_orchestrator", return_value=_ProcSummaryStub(summary_payload)):
                            with patch("apps.runner.runner._RunTranscriptWriter", _TranscriptStub):
                                with patch.object(runner.Runner, "handle_dispatch_summary", autospec=True) as handle_summary_mock:
                                    exit_code = runner.main(["--loop", "--sprint", "M1"])

            self.assertEqual(exit_code, 0)
            self.assertEqual(handle_summary_mock.call_count, 1)
