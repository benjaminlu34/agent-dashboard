import unittest

from apps.runner.intents import IntentError, parse_intent


class IntentParsingTests(unittest.TestCase):
    def test_rejects_unknown_fields(self) -> None:
        with self.assertRaises(IntentError) as ctx:
            parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "endpoint": "/internal/executor/claim-ready-item",
                    "body": {"role": "EXECUTOR", "run_id": "11111111-1111-4111-8111-111111111111"},
                    "extra": 123,
                }
            )
        self.assertEqual(ctx.exception.code, "intent_unknown_fields")

    def test_requires_body_role_matches(self) -> None:
        with self.assertRaises(IntentError) as ctx:
            parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "endpoint": "/internal/executor/claim-ready-item",
                    "body": {"role": "REVIEWER", "run_id": "11111111-1111-4111-8111-111111111111"},
                }
            )
        self.assertEqual(ctx.exception.code, "intent_role_mismatch")

    def test_requires_body_run_id_matches(self) -> None:
        with self.assertRaises(IntentError) as ctx:
            parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "REVIEWER",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "endpoint": "/internal/reviewer/resolve-linked-pr",
                    "body": {"role": "REVIEWER", "run_id": "22222222-2222-4222-8222-222222222222", "issue_number": 1},
                }
            )
        self.assertEqual(ctx.exception.code, "intent_run_id_mismatch")

    def test_rejects_endpoint_not_allowed_for_role(self) -> None:
        with self.assertRaises(IntentError) as ctx:
            parse_intent(
                {
                    "type": "RUN_INTENT",
                    "role": "EXECUTOR",
                    "run_id": "11111111-1111-4111-8111-111111111111",
                    "endpoint": "/internal/project-item/update-field",
                    "body": {"role": "EXECUTOR", "run_id": "11111111-1111-4111-8111-111111111111"},
                }
            )
        self.assertEqual(ctx.exception.code, "intent_endpoint_not_allowed")

    def test_accepts_executor_in_review_resolve_endpoint(self) -> None:
        intent = parse_intent(
            {
                "type": "RUN_INTENT",
                "role": "EXECUTOR",
                "run_id": "33333333-3333-4333-8333-333333333333",
                "endpoint": "/internal/reviewer/resolve-linked-pr",
                "body": {
                    "role": "EXECUTOR",
                    "run_id": "33333333-3333-4333-8333-333333333333",
                    "issue_number": 3,
                },
            }
        )
        self.assertEqual(intent.endpoint, "/internal/reviewer/resolve-linked-pr")
