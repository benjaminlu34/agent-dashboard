import json
import tempfile
import unittest

from apps.runner.runner import Runner
from apps.runner.http_client import BackendClient


class RunnerStateResolutionTests(unittest.TestCase):
    def test_record_reviewer_outcome_picks_most_recent_item_for_issue(self) -> None:
        # State file can retain stale entries across local test runs; recording reviewer outcome
        # must still target the currently active project item for the issue number.
        state_path = tempfile.NamedTemporaryFile(delete=True).name
        state = {
            "poll_count": 10,
            "items": {
                "PVTI_old": {
                    "last_seen_issue_number": 2,
                    "last_seen_status": "Backlog",
                    "last_seen_sprint": "M1",
                    "last_seen_at": "2026-02-09T20:00:00.000Z",
                    "last_reviewer_outcome": "",
                    "last_reviewer_feedback_at": "",
                    "review_cycle_count": 0,
                },
                "PVTI_new": {
                    "last_seen_issue_number": 2,
                    "last_seen_status": "In Review",
                    "last_seen_sprint": "M1",
                    "last_seen_at": "2026-02-09T21:00:00.000Z",
                    "last_reviewer_outcome": "",
                    "last_reviewer_feedback_at": "",
                    "review_cycle_count": 0,
                },
            },
        }
        with open(state_path, "w", encoding="utf8") as handle:
            json.dump(state, handle)

        runner = Runner(
            backend=BackendClient(base_url="http://localhost:4000", timeout_s=5),
            ledger=None,
            dry_run=True,
            codex_bin="codex",
            codex_mcp_args="",
            codex_tools_call_timeout_s=1.0,
            orchestrator_state_path=state_path,
            review_stall_polls=10,
            blocked_retry_minutes=15,
            watchdog_timeout_s=60,
        )

        runner._record_reviewer_outcome_state(  # pylint: disable=protected-access
            issue_number=2,
            outcome="FAIL",
            recorded_at="2026-02-09T21:05:48.000Z",
        )

        with open(state_path, encoding="utf8") as handle:
            updated = json.load(handle)
        self.assertEqual(updated["items"]["PVTI_old"]["last_reviewer_outcome"], "")
        self.assertEqual(updated["items"]["PVTI_new"]["last_reviewer_outcome"], "FAIL")
        self.assertEqual(updated["items"]["PVTI_new"]["last_reviewer_feedback_at"], "2026-02-09T21:05:48.000Z")
        self.assertEqual(updated["items"]["PVTI_new"]["review_cycle_count"], 1)
