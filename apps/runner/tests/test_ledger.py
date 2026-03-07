import unittest

from apps.runner.ledger import LedgerEntry, RunLedger
from apps.runner.redis_keys import orchestrator_ledger_key

from .fake_redis import FakeRedis


class LedgerTests(unittest.TestCase):
    def test_idempotent_upsert_and_reload(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"
        ledger = RunLedger(redis, repo_key)

        run_id = "11111111-1111-4111-8111-111111111111"
        ledger.upsert(
            LedgerEntry(
                run_id=run_id,
                role="EXECUTOR",
                intent_hash="hash",
                received_at="2026-01-01T00:00:00Z",
                status="queued",
                result=None,
            )
        )
        ledger.mark_running(run_id)
        ledger.mark_result(run_id, status="succeeded", result={"status": "succeeded"})

        reloaded = RunLedger(redis, repo_key)
        entry = reloaded.get(run_id)
        self.assertIsNotNone(entry)
        assert entry is not None
        self.assertEqual(entry["status"], "succeeded")

        payload = redis.hgetall(orchestrator_ledger_key(repo_key))
        self.assertIn(run_id, payload)

    def test_task_failure_state_is_idempotent_per_run_and_resettable(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"
        ledger = RunLedger(redis, repo_key)

        ledger.touch_task_last_activity("PVTI_9", at_iso="2026-03-07T00:00:00.000Z")
        first = ledger.record_task_failure("PVTI_9", run_id="run-1", at_iso="2026-03-07T00:01:00.000Z")
        duplicate = ledger.record_task_failure("PVTI_9", run_id="run-1", at_iso="2026-03-07T00:01:00.000Z")
        second = ledger.record_task_failure("PVTI_9", run_id="run-2", at_iso="2026-03-07T00:02:00.000Z")

        self.assertEqual(first["consecutive_failures"], 1)
        self.assertEqual(duplicate["consecutive_failures"], 1)
        self.assertEqual(second["consecutive_failures"], 2)
        self.assertEqual(ledger.get_task_last_activity("PVTI_9"), "2026-03-07T00:00:00.000Z")

        ledger.reset_task_failures("PVTI_9")
        self.assertEqual(
            ledger.get_task_failure_state("PVTI_9"),
            {
                "consecutive_failures": 0,
                "last_failure_at": "",
                "last_failure_run_id": "",
            },
        )
