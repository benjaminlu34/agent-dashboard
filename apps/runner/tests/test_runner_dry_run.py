import unittest

from apps.runner.runner import Runner
from apps.runner.intents import parse_intent


class _BackendStub:
    def __init__(self) -> None:
        self.get_agent_context_calls = 0

    def get_agent_context(self, role: str):
        self.get_agent_context_calls += 1
        raise AssertionError("dry-run must not fetch agent context")


class RunnerDryRunTests(unittest.TestCase):
    def test_dry_run_never_fetches_bundle_or_executes(self) -> None:
        backend = _BackendStub()
        runner = Runner(backend=backend, ledger=None, dry_run=True, codex_bin="codex", codex_mcp_args="mcp-server")

        intent = parse_intent(
            {
                "type": "RUN_INTENT",
                "role": "EXECUTOR",
                "run_id": "11111111-1111-4111-8111-111111111111",
                "endpoint": "/internal/executor/claim-ready-item",
                "body": {"role": "EXECUTOR", "run_id": "11111111-1111-4111-8111-111111111111", "sprint": "M1"},
            }
        )

        runner._handle_intent(intent)  # pylint: disable=protected-access
        self.assertEqual(backend.get_agent_context_calls, 0)

