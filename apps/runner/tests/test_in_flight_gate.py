import unittest

from apps.runner.in_flight import acquire_in_flight_lock, release_in_flight_lock

from .fake_redis import FakeRedis


class RunnerInFlightGateTests(unittest.TestCase):
    def test_reserve_blocks_until_release(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"

        self.assertTrue(
            acquire_in_flight_lock(
                redis_client=redis,
                repo_key=repo_key,
                issue_number=42,
                run_id="run-1",
                role="EXECUTOR",
                ttl_s=60,
            )
        )

        self.assertFalse(
            acquire_in_flight_lock(
                redis_client=redis,
                repo_key=repo_key,
                issue_number=42,
                run_id="run-2",
                role="REVIEWER",
                ttl_s=60,
            )
        )

        release_in_flight_lock(redis_client=redis, repo_key=repo_key, issue_number=42, run_id="run-1")

        self.assertTrue(
            acquire_in_flight_lock(
                redis_client=redis,
                repo_key=repo_key,
                issue_number=42,
                run_id="run-2",
                role="REVIEWER",
                ttl_s=60,
            )
        )

        release_in_flight_lock(redis_client=redis, repo_key=repo_key, issue_number=42, run_id="run-2")

    def test_acquire_fails_closed_when_eval_unavailable(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"
        redis.eval = None  # type: ignore[attr-defined]

        self.assertFalse(
            acquire_in_flight_lock(
                redis_client=redis,
                repo_key=repo_key,
                issue_number=42,
                run_id="run-1",
                role="EXECUTOR",
                ttl_s=60,
            )
        )

    def test_acquire_fails_closed_when_eval_errors(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"

        def _boom(*_args, **_kwargs):
            raise RuntimeError("eval failed")

        redis.eval = _boom  # type: ignore[method-assign]

        self.assertFalse(
            acquire_in_flight_lock(
                redis_client=redis,
                repo_key=repo_key,
                issue_number=42,
                run_id="run-1",
                role="EXECUTOR",
                ttl_s=60,
            )
        )

    def test_release_ignores_eval_errors(self) -> None:
        redis = FakeRedis()
        repo_key = "example.repo"

        def _boom(*_args, **_kwargs):
            raise RuntimeError("eval failed")

        redis.eval = _boom  # type: ignore[method-assign]

        release_in_flight_lock(redis_client=redis, repo_key=repo_key, issue_number=42, run_id="run-1")
