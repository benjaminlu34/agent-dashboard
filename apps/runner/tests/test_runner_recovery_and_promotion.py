import json
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

from apps.runner.runner import (
    MalformedSprintDataError,
    Runner,
    SanitizationRegenExhaustedError,
    SanitizationRegenHandoffRequestedError,
    _maybe_autopromote_ready,
)


class _BackendStub:
    def __init__(self) -> None:
        self.calls = []

    def post_json(self, path: str, *, body):
        self.calls.append((path, body))
        return {"ok": True}


def _parse_json_logs(raw: str):
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


class RunnerPromotionAndRecoveryTests(unittest.TestCase):
    def test_backlog_items_promoted_to_ready_buffer(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "In Progress"},
            ],
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=None,
            backend=backend,
            dry_run=False,
            ready_target=2,
        )

        self.assertEqual(len(backend.calls), 2)
        first_path, first_body = backend.calls[0]
        second_path, second_body = backend.calls[1]
        self.assertEqual(first_path, "/internal/project-item/update-field")
        self.assertEqual(second_path, "/internal/project-item/update-field")
        self.assertEqual(first_body["project_item_id"], "PVTI_2")
        self.assertEqual(second_body["project_item_id"], "PVTI_4")
        self.assertEqual(first_body["value"], "Ready")
        self.assertEqual(second_body["value"], "Ready")

    def test_disjoint_owned_paths_can_be_ready_concurrently(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] A", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] B", "issue_number": 4, "project_item_id": "PVTI_4", "priority": "P0", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [],
                    "depends_on": [],
                    "group_id": "component:apps/api",
                    "isolation_mode": "ISOLATED",
                },
                "4": {
                    "touch_paths": ["apps/runner"],
                    "owns_paths": ["apps/runner"],
                    "conflicts_with": [],
                    "depends_on": [],
                    "group_id": "component:apps/runner",
                    "isolation_mode": "ISOLATED",
                },
            },
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=sprint_plan,
            backend=backend,
            dry_run=False,
            ready_target=2,
        )

        self.assertEqual(len(backend.calls), 2)
        promoted = [call[1]["project_item_id"] for call in backend.calls]
        self.assertEqual(promoted, ["PVTI_2", "PVTI_4"])

    def test_overlapping_owned_paths_are_chained_and_not_both_promoted(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API-1", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] API-2", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
                {"title": "[TASK] Runner", "issue_number": 4, "project_item_id": "PVTI_4", "priority": "P0", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3],
                    "depends_on": [],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [2],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "4": {
                    "touch_paths": ["apps/runner"],
                    "owns_paths": ["apps/runner"],
                    "conflicts_with": [],
                    "depends_on": [],
                    "group_id": "component:apps/runner",
                    "isolation_mode": "ISOLATED",
                },
            },
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=sprint_plan,
            backend=backend,
            dry_run=False,
            ready_target=2,
        )

        self.assertEqual(len(backend.calls), 2)
        promoted = [call[1]["project_item_id"] for call in backend.calls]
        self.assertEqual(promoted, ["PVTI_2", "PVTI_4"])

    def test_chained_successor_promoted_after_dependency_done(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Done"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API-1", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] API-2", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3],
                    "depends_on": [],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [2],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=sprint_plan,
            backend=backend,
            dry_run=False,
            ready_target=1,
        )

        self.assertEqual(len(backend.calls), 1)
        _path, body = backend.calls[0]
        self.assertEqual(body["project_item_id"], "PVTI_3")
        self.assertEqual(body["value"], "Ready")

    def test_chained_successor_not_promoted_when_dependency_only_needs_human_approval(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Needs Human Approval"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API-1", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] API-2", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3],
                    "depends_on": [],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [2],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=sprint_plan,
            backend=backend,
            dry_run=False,
            ready_target=1,
        )

        self.assertEqual(backend.calls, [])

    def test_non_overlapping_chained_dependency_is_pruned_before_promotion(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] Web", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/server.py"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/web/src/index.ts"],
                    "owns_paths": ["apps/web"],
                    "conflicts_with": [],
                    "depends_on": [],
                    "group_id": "component:apps/web",
                    "isolation_mode": "CHAINED",
                },
            },
        }

        _maybe_autopromote_ready(
            summary=summary,
            sprint_plan=sprint_plan,
            backend=backend,
            dry_run=False,
            ready_target=1,
        )

        self.assertEqual(len(backend.calls), 1)
        _path, body = backend.calls[0]
        self.assertEqual(body["project_item_id"], "PVTI_2")
        self.assertEqual(body["value"], "Ready")

    def test_cycle_error_regen_tier1_then_pass_logs_success(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API-1", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] API-2", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/a.ts"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api/src/b.ts"],
                    "owns_paths": ["apps/api/src"],
                    "conflicts_with": [2],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }
        stderr_buffer = StringIO()
        with redirect_stderr(stderr_buffer):
            _maybe_autopromote_ready(
                summary=summary,
                sprint_plan=sprint_plan,
                backend=backend,
                dry_run=False,
                ready_target=1,
                sanitization_regen_attempts=2,
                orchestrator_state_path="./.orchestrator-state.json",
            )

        self.assertEqual(len(backend.calls), 1)
        events = _parse_json_logs(stderr_buffer.getvalue())
        success_events = [event for event in events if event.get("type") == "sanitization_regen_succeeded"]
        self.assertEqual(len(success_events), 1)
        self.assertEqual(success_events[0].get("attempts"), 1)
        history = success_events[0].get("history")
        self.assertIsInstance(history, list)
        self.assertEqual(history[0].get("tier"), "DETERMINISTIC_PATCH")
        self.assertEqual(history[0].get("edges_removed"), [{"from": 3, "to": 2}])

    def test_tier2_invoked_on_attempt_one_when_new_cycle_remains(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] A", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] B", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] C", "issue_number": 4, "project_item_id": "PVTI_4", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/a.ts"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3, 4],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api/src/b.ts"],
                    "owns_paths": ["apps/api/src"],
                    "conflicts_with": [2, 4],
                    "depends_on": [2, 4],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "4": {
                    "touch_paths": ["apps/api/src/c.ts"],
                    "owns_paths": ["apps/api/src/internal"],
                    "conflicts_with": [2, 3],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            stderr_buffer = StringIO()
            with redirect_stderr(stderr_buffer):
                with self.assertRaises(SanitizationRegenHandoffRequestedError) as ctx:
                    _maybe_autopromote_ready(
                        summary=summary,
                        sprint_plan=sprint_plan,
                        backend=backend,
                        dry_run=False,
                        ready_target=1,
                        sanitization_regen_attempts=2,
                        orchestrator_state_path=state_path,
                    )
            self.assertEqual(ctx.exception.exit_code, 6)
            self.assertTrue(Path(f"{state_path}.regen-request.json").exists())
            events = _parse_json_logs(stderr_buffer.getvalue())
            handoff_events = [event for event in events if event.get("type") == "sanitization_regen_handoff_requested"]
            self.assertEqual(len(handoff_events), 1)
            history = handoff_events[0].get("history")
            self.assertIsInstance(history, list)
            self.assertEqual(history[0].get("tier"), "DETERMINISTIC_PATCH")
            self.assertEqual(history[1].get("tier"), "PLANNER_REGEN")
            self.assertEqual(history[1].get("attempt"), 1)
        self.assertEqual(backend.calls, [])

    def test_all_regen_attempts_exhausted_logs_history_and_raises_exit_five(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] A", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] B", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] C", "issue_number": 4, "project_item_id": "PVTI_4", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/a.ts"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3, 4],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api/src/b.ts"],
                    "owns_paths": ["apps/api/src"],
                    "conflicts_with": [2, 4],
                    "depends_on": [2, 4],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "4": {
                    "touch_paths": ["apps/api/src/c.ts"],
                    "owns_paths": ["apps/api/src/internal"],
                    "conflicts_with": [2, 3],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }
        stderr_buffer = StringIO()
        with redirect_stderr(stderr_buffer):
            with self.assertRaises(SanitizationRegenExhaustedError) as ctx:
                _maybe_autopromote_ready(
                    summary=summary,
                    sprint_plan=sprint_plan,
                    backend=backend,
                    dry_run=False,
                    ready_target=1,
                    sanitization_regen_attempts=1,
                    orchestrator_state_path="./.orchestrator-state.json",
                )
        self.assertEqual(ctx.exception.exit_code, 5)
        events = _parse_json_logs(stderr_buffer.getvalue())
        exhausted_events = [event for event in events if event.get("type") == "sanitization_regen_exhausted"]
        self.assertEqual(len(exhausted_events), 1)
        history = exhausted_events[0].get("history")
        self.assertIsInstance(history, list)
        self.assertEqual(history[0].get("tier"), "DETERMINISTIC_PATCH")
        self.assertEqual(history[-1].get("tier"), "FINAL_SANITIZATION_FAILED")
        self.assertEqual(backend.calls, [])

    def test_regen_attempts_zero_preserves_immediate_exit_three_behavior(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] API-1", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] API-2", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/a.ts"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api/src/b.ts"],
                    "owns_paths": ["apps/api/src"],
                    "conflicts_with": [2],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }
        stderr_buffer = StringIO()
        with redirect_stderr(stderr_buffer):
            with self.assertRaises(MalformedSprintDataError):
                _maybe_autopromote_ready(
                    summary=summary,
                    sprint_plan=sprint_plan,
                    backend=backend,
                    dry_run=False,
                    ready_target=1,
                    sanitization_regen_attempts=0,
                    orchestrator_state_path="./.orchestrator-state.json",
                )
        events = _parse_json_logs(stderr_buffer.getvalue())
        regen_events = [event for event in events if str(event.get("type", "")).startswith("sanitization_regen_")]
        self.assertEqual(regen_events, [])

    def test_tier1_removes_last_to_first_edge_only_and_keeps_unrelated_edges(self) -> None:
        backend = _BackendStub()
        summary = {
            "sprint": "M1",
            "status_counts": {"Ready": 0},
            "processed_items": [
                {"issue_number": 2, "project_item_id": "PVTI_2", "status": "Backlog"},
                {"issue_number": 3, "project_item_id": "PVTI_3", "status": "Backlog"},
                {"issue_number": 4, "project_item_id": "PVTI_4", "status": "Backlog"},
                {"issue_number": 5, "project_item_id": "PVTI_5", "status": "Backlog"},
            ],
        }
        sprint_plan = {
            "sprint": "M1",
            "tasks": [
                {"title": "[TASK] A", "issue_number": 2, "project_item_id": "PVTI_2", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] B", "issue_number": 3, "project_item_id": "PVTI_3", "priority": "P0", "depends_on_titles": []},
                {"title": "[TASK] C", "issue_number": 4, "project_item_id": "PVTI_4", "priority": "P1", "depends_on_titles": []},
                {"title": "[TASK] D", "issue_number": 5, "project_item_id": "PVTI_5", "priority": "P1", "depends_on_titles": []},
            ],
            "sprint_plan": {
                "2": {
                    "touch_paths": ["apps/api/src/a.ts"],
                    "owns_paths": ["apps/api"],
                    "conflicts_with": [3, 4, 5],
                    "depends_on": [3],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "3": {
                    "touch_paths": ["apps/api/src/b.ts"],
                    "owns_paths": ["apps/api/src"],
                    "conflicts_with": [2, 4, 5],
                    "depends_on": [4],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "4": {
                    "touch_paths": ["apps/api/src/c.ts"],
                    "owns_paths": ["apps/api/src/internal"],
                    "conflicts_with": [2, 3, 5],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
                "5": {
                    "touch_paths": ["apps/api/src/d.ts"],
                    "owns_paths": ["apps/api/src/other"],
                    "conflicts_with": [2, 3, 4],
                    "depends_on": [2],
                    "group_id": "component:apps/api",
                    "isolation_mode": "CHAINED",
                },
            },
        }
        stderr_buffer = StringIO()
        with redirect_stderr(stderr_buffer):
            _maybe_autopromote_ready(
                summary=summary,
                sprint_plan=sprint_plan,
                backend=backend,
                dry_run=False,
                ready_target=1,
                sanitization_regen_attempts=2,
                orchestrator_state_path="./.orchestrator-state.json",
            )

        events = _parse_json_logs(stderr_buffer.getvalue())
        success_events = [event for event in events if event.get("type") == "sanitization_regen_succeeded"]
        self.assertEqual(len(success_events), 1)
        patch = success_events[0]["history"][0]
        self.assertEqual(patch.get("edges_removed"), [{"from": 4, "to": 2}])
        patched_items = patch.get("patched_items")
        item4 = next(item for item in patched_items if item.get("number") == 4)
        item5 = next(item for item in patched_items if item.get("number") == 5)
        self.assertEqual(item4.get("depends_on"), [])
        self.assertEqual(item5.get("depends_on"), [2])

    def test_executor_failure_moves_in_progress_item_to_blocked(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            with open(state_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "poll_count": 10,
                        "items": {
                            "PVTI_44": {
                                "last_seen_issue_number": 44,
                                "last_seen_status": "In Progress",
                                "last_dispatched_role": "EXECUTOR",
                                "last_run_id": "run-44",
                            }
                        },
                    },
                    handle,
                )

            runner = Runner(
                backend=backend,
                ledger=None,
                dry_run=False,
                codex_bin="codex",
                codex_mcp_args="mcp-server",
                codex_tools_call_timeout_s=600.0,
                orchestrator_state_path=state_path,
                review_stall_polls=50,
                blocked_retry_minutes=15,
                watchdog_timeout_s=900,
            )
            runner._transition_executor_failure_to_blocked(
                run_id="run-44",
                failure_classification="ITEM_STOP",
                failure_message="mcp call timed out",
            )

        self.assertEqual(len(backend.calls), 1)
        path, body = backend.calls[0]
        self.assertEqual(path, "/internal/project-item/update-field")
        self.assertEqual(body["role"], "ORCHESTRATOR")
        self.assertEqual(body["project_item_id"], "PVTI_44")
        self.assertEqual(body["field"], "Status")
        self.assertEqual(body["value"], "Blocked")
        self.assertEqual(body["issue_number"], 44)
        self.assertEqual(body["failure_classification"], "ITEM_STOP")

    def test_executor_fixup_failure_moves_in_review_item_to_blocked(self) -> None:
        backend = _BackendStub()
        with tempfile.TemporaryDirectory() as tmp_dir:
            state_path = f"{tmp_dir}/orchestrator-state.json"
            with open(state_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "poll_count": 11,
                        "items": {
                            "PVTI_55": {
                                "last_seen_issue_number": 55,
                                "last_seen_status": "In Review",
                                "last_dispatched_role": "EXECUTOR",
                                "last_run_id": "run-55",
                            }
                        },
                    },
                    handle,
                )

            runner = Runner(
                backend=backend,
                ledger=None,
                dry_run=False,
                codex_bin="codex",
                codex_mcp_args="mcp-server",
                codex_tools_call_timeout_s=600.0,
                orchestrator_state_path=state_path,
                review_stall_polls=50,
                blocked_retry_minutes=15,
                watchdog_timeout_s=900,
            )
            runner._transition_executor_failure_to_blocked(
                run_id="run-55",
                failure_classification="ITEM_STOP",
                failure_message="executor fixup failed",
            )

        self.assertEqual(len(backend.calls), 1)
        path, body = backend.calls[0]
        self.assertEqual(path, "/internal/project-item/update-field")
        self.assertEqual(body["role"], "ORCHESTRATOR")
        self.assertEqual(body["project_item_id"], "PVTI_55")
        self.assertEqual(body["field"], "Status")
        self.assertEqual(body["value"], "Blocked")
        self.assertEqual(body["issue_number"], 55)
        self.assertEqual(body["failure_classification"], "ITEM_STOP")
        self.assertIn("existing linked PR branch", " ".join(body["suggested_next_steps"]))
