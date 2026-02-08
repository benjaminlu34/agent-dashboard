import unittest

from apps.runner.codex_worker import _build_worker_prompt


class CodexWorkerPromptTests(unittest.TestCase):
    def test_reviewer_prompt_forbids_approvals(self) -> None:
        prompt = _build_worker_prompt(
            role_bundle={"role": "REVIEWER", "files": []},
            intent={
                "type": "RUN_INTENT",
                "role": "REVIEWER",
                "run_id": "11111111-1111-4111-8111-111111111111",
                "endpoint": "/internal/reviewer/resolve-linked-pr",
                "body": {
                    "role": "REVIEWER",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "issue_number": 2,
                },
            },
            backend_base_url="http://localhost:4000",
        )
        self.assertIn("Do NOT call github.pull_request_review_write", prompt)
        self.assertIn("Reviewer: addressed", prompt)

