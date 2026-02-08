import unittest

from apps.runner.kickoff import (
    KickoffError,
    kickoff_plan_to_plan_apply_draft,
    validate_kickoff_plan,
)


def _issue_body_md(*, goal: str) -> str:
    return "\n".join(
        [
            "## Goal",
            goal,
            "",
            "## Non-goals",
            "- Not included",
            "",
            "## Acceptance Criteria",
            "- [ ] Works as specified",
            "",
            "## Files Likely Touched",
            "- apps/runner/",
            "",
            "## Definition of Done",
            "- [ ] Tests pass",
            "",
        ]
    )


def _valid_plan(*, task_count: int = 3):
    tasks = []
    for idx in range(task_count):
        tasks.append(
            {
                "title": f"[TASK] Task {idx + 1}",
                "body_markdown": _issue_body_md(goal=f"Do task {idx + 1}."),
                "priority": "P0" if idx == 0 else "P1",
                "size": "S",
                "area": "runner",
                "depends_on_titles": [],
                "initial_status": "Backlog",
            }
        )

    return {
        "sprint": "M1",
        "goal_issue": {
            "title": "[SPRINT GOAL] M1: Test kickoff",
            "body_markdown": _issue_body_md(goal="Ship Sprint M1 kickoff."),
            "labels": ["meta:sprint-goal"],
            "fields": {"Sprint": "M1", "Status": "Backlog", "Priority": "P0", "Size": "S", "Area": "docs"},
        },
        "tasks": tasks,
        "ready_set_titles": [tasks[0]["title"]],
        "prioritization_rationale": "Pick one dependency-free P0 to start.",
    }


class KickoffValidationTests(unittest.TestCase):
    def test_rejects_task_count_out_of_bounds(self) -> None:
        with self.assertRaises(KickoffError) as ctx_low:
            validate_kickoff_plan(_valid_plan(task_count=2), sprint="M1", ready_limit=3)
        self.assertEqual(ctx_low.exception.code, "kickoff_invalid_task_count")

        with self.assertRaises(KickoffError) as ctx_high:
            validate_kickoff_plan(_valid_plan(task_count=26), sprint="M1", ready_limit=3)
        self.assertEqual(ctx_high.exception.code, "kickoff_invalid_task_count")

    def test_rejects_missing_goal_label(self) -> None:
        plan = _valid_plan()
        plan["goal_issue"]["labels"] = ["something-else"]
        with self.assertRaises(KickoffError) as ctx:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx.exception.code, "kickoff_missing_goal_label")

    def test_rejects_invalid_priority_and_size(self) -> None:
        plan = _valid_plan()
        plan["tasks"][0]["priority"] = "P9"
        with self.assertRaises(KickoffError) as ctx_priority:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx_priority.exception.code, "kickoff_invalid_priority")

        plan = _valid_plan()
        plan["tasks"][0]["size"] = "XL"
        with self.assertRaises(KickoffError) as ctx_size:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx_size.exception.code, "kickoff_invalid_size")

    def test_rejects_ready_set_with_dependencies(self) -> None:
        plan = _valid_plan()
        plan["tasks"][0]["depends_on_titles"] = [plan["tasks"][1]["title"]]
        with self.assertRaises(KickoffError) as ctx:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx.exception.code, "kickoff_ready_set_has_dependencies")

    def test_rejects_autoclose_keywords(self) -> None:
        plan = _valid_plan()
        plan["tasks"][0]["body_markdown"] = plan["tasks"][0]["body_markdown"] + "\nCloses #123\n"
        with self.assertRaises(KickoffError) as ctx:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx.exception.code, "kickoff_forbidden_autoclose")

    def test_ready_limit_enforced(self) -> None:
        plan = _valid_plan()
        plan["ready_set_titles"] = [t["title"] for t in plan["tasks"]]
        with self.assertRaises(KickoffError) as ctx:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=1)
        self.assertEqual(ctx.exception.code, "kickoff_ready_set_too_large")

    def test_translation_produces_plan_apply_draft_goal_first(self) -> None:
        plan = validate_kickoff_plan(_valid_plan(), sprint="M1", ready_limit=3)
        draft = kickoff_plan_to_plan_apply_draft(plan)
        self.assertEqual(draft["sprint"], "M1")
        self.assertEqual(draft["issues"][0]["title"], "[SPRINT GOAL] M1: Test kickoff")
        self.assertEqual(draft["issues"][0]["labels"], ["meta:sprint-goal"])
        self.assertEqual(draft["issues"][1]["title"], "[TASK] Task 1")
        self.assertEqual(draft["issues"][1]["area"], "infra")  # runner maps to policy area

    def test_title_collision_fails_closed(self) -> None:
        plan = _valid_plan()
        plan["tasks"][1]["title"] = plan["tasks"][0]["title"]
        with self.assertRaises(KickoffError) as ctx:
            validate_kickoff_plan(plan, sprint="M1", ready_limit=3)
        self.assertEqual(ctx.exception.code, "kickoff_title_collision")

    def test_apply_dry_run_never_posts(self) -> None:
        from apps.runner.runner import _apply_kickoff_plan  # pylint: disable=import-outside-toplevel
        import io  # pylint: disable=import-outside-toplevel
        import contextlib  # pylint: disable=import-outside-toplevel

        class BackendStub:
            def __init__(self) -> None:
                self.post_calls = 0

            def post_json(self, *_args, **_kwargs):
                self.post_calls += 1
                raise AssertionError("dry-run must not post to backend")

        plan = validate_kickoff_plan(_valid_plan(), sprint="M1", ready_limit=3)
        draft = kickoff_plan_to_plan_apply_draft(plan)
        backend = BackendStub()
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            result = _apply_kickoff_plan(backend=backend, plan=plan, draft=draft, dry_run=True)
        self.assertEqual(result["status"], "DRY_RUN")
        self.assertEqual(backend.post_calls, 0)

    def test_apply_fails_when_ready_set_title_missing_mapping(self) -> None:
        from apps.runner.runner import _apply_kickoff_plan  # pylint: disable=import-outside-toplevel

        class BackendStub:
            def post_json(self, path: str, *, body):
                if path == "/internal/plan-apply":
                    created = []
                    for idx, _issue in enumerate(body["draft"]["issues"]):
                        created.append({"index": idx, "project_item_id": f"PVTI_{idx}"})
                    return {"status": "APPLIED", "created": created}
                raise AssertionError(f"unexpected backend call: {path}")

        plan = validate_kickoff_plan(_valid_plan(), sprint="M1", ready_limit=3)
        draft = kickoff_plan_to_plan_apply_draft(plan)
        plan["ready_set_titles"] = ["[TASK] Not in draft"]
        with self.assertRaises(KickoffError) as ctx:
            _apply_kickoff_plan(backend=BackendStub(), plan=plan, draft=draft, dry_run=False)
        self.assertEqual(ctx.exception.code, "kickoff_ready_set_missing_mapping")
