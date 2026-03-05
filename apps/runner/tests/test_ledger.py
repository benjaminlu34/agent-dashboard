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
