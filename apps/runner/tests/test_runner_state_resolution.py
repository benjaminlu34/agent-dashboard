import unittest

from apps.runner.state_store import RedisStateStore
from apps.runner.ledger import RunLedger
from apps.runner.supervisor import _record_reviewer_outcome_state

from .fake_redis import FakeRedis


class RunnerStateResolutionTests(unittest.TestCase):
    def test_record_reviewer_outcome_picks_most_recent_item_for_issue(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"
        state_store = RedisStateStore(redis)
        ledger = RunLedger(redis, repo_key)

        items = {
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
        }

        state_store.set_item(repo_key, "PVTI_old", dict(items["PVTI_old"]))
        state_store.set_item(repo_key, "PVTI_new", dict(items["PVTI_new"]))

        _record_reviewer_outcome_state(
            state_store=state_store,
            ledger=ledger,
            repo_key=repo_key,
            items=items,
            issue_number=2,
            outcome="FAIL",
            recorded_at="2026-02-09T21:05:48.000Z",
        )

        self.assertEqual(state_store.get_item(repo_key, "PVTI_old")["last_reviewer_outcome"], "")
        self.assertEqual(state_store.get_item(repo_key, "PVTI_new")["last_reviewer_outcome"], "FAIL")
        self.assertEqual(state_store.get_item(repo_key, "PVTI_new")["last_reviewer_feedback_at"], "2026-02-09T21:05:48.000Z")
        self.assertEqual(state_store.get_item(repo_key, "PVTI_new")["review_cycle_count"], 1)
