import unittest

from apps.runner.codex_worker import CodexWorkerError, _build_worker_prompt, _extract_worker_result


class CodexWorkerPromptTests(unittest.TestCase):
    def test_executor_prompt_mentions_fixup_branch_constraints(self) -> None:
        prompt = _build_worker_prompt(
            role_bundle={"role": "EXECUTOR", "files": []},
            intent={
                "type": "RUN_INTENT",
                "role": "EXECUTOR",
                "run_id": "11111111-1111-4111-8111-111111111111",
                "endpoint": "/internal/executor/claim-ready-item",
                "body": {
                    "role": "EXECUTOR",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "sprint": "M1",
                },
            },
            backend_base_url="http://localhost:4000",
        )
        self.assertIn("MUST set marker_verified=true", prompt)
        self.assertIn("In Review fixup run", prompt)
        self.assertIn("descend from head_sha", prompt)
        self.assertIn('"marker_verified": true|false|null', prompt)

    def test_extract_worker_result_requires_reviewer_outcome(self) -> None:
        with self.assertRaises(CodexWorkerError):
            _extract_worker_result(
                content='{"run_id":"r1","role":"REVIEWER","status":"succeeded","summary":"ok","urls":{},"errors":[]}',
                expected_run_id="r1",
                expected_role="REVIEWER",
            )

    def test_extract_worker_result_accepts_reviewer_outcome(self) -> None:
        result = _extract_worker_result(
            content=(
                '{"run_id":"r2","role":"REVIEWER","status":"succeeded",'
                '"outcome":"PASS","summary":"ok","urls":{},"errors":[],"marker_verified":null}'
            ),
            expected_run_id="r2",
            expected_role="REVIEWER",
        )
        self.assertEqual(result.outcome, "PASS")

    def test_extract_worker_result_accepts_executor_marker_verified(self) -> None:
        result = _extract_worker_result(
            content=(
                '{"run_id":"r3","role":"EXECUTOR","status":"succeeded",'
                '"summary":"ok","urls":{"pr_url":"https://example.com/pr/1"},'
                '"errors":[],"marker_verified":true}'
            ),
            expected_run_id="r3",
            expected_role="EXECUTOR",
        )
        self.assertEqual(result.marker_verified, True)
