import json
import tempfile
import unittest

from apps.runner.runner import Runner, _maybe_autopromote_ready


class _BackendStub:
    def __init__(self) -> None:
        self.calls = []

    def post_json(self, path: str, *, body):
        self.calls.append((path, body))
        return {"ok": True}


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

    def test_chained_successor_promoted_after_dependency_needs_human_approval(self) -> None:
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

        self.assertEqual(len(backend.calls), 1)
        _path, body = backend.calls[0]
        self.assertEqual(body["project_item_id"], "PVTI_3")
        self.assertEqual(body["value"], "Ready")

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
