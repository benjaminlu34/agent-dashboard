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
