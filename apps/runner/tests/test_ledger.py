import json
import os
import tempfile
import unittest

from apps.runner.ledger import LedgerEntry, RunLedger


class LedgerTests(unittest.TestCase):
    def test_idempotent_upsert_and_reload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ledger.json")
            ledger = RunLedger(path)

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

            reloaded = RunLedger(path)
            entry = reloaded.get(run_id)
            self.assertIsNotNone(entry)
            assert entry is not None
            self.assertEqual(entry["status"], "succeeded")

            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            self.assertIn(run_id, payload)

