import unittest
from unittest.mock import patch

from apps.runner.time_utils import calculate_backoff_delay


class TimeUtilsTests(unittest.TestCase):
    def test_backoff_grows_exponentially_without_jitter(self) -> None:
        with patch("apps.runner.time_utils.random.uniform", return_value=1.0):
            self.assertEqual(calculate_backoff_delay(1, 60.0, 3600.0, 2.0), 60.0)
            self.assertEqual(calculate_backoff_delay(2, 60.0, 3600.0, 2.0), 120.0)
            self.assertEqual(calculate_backoff_delay(3, 60.0, 3600.0, 2.0), 240.0)

    def test_backoff_is_capped(self) -> None:
        with patch("apps.runner.time_utils.random.uniform", return_value=1.0):
            self.assertEqual(calculate_backoff_delay(10, 60.0, 300.0, 2.0), 300.0)

    def test_backoff_applies_jitter_within_ten_percent(self) -> None:
        with patch("apps.runner.time_utils.random.uniform", return_value=0.9):
            self.assertEqual(calculate_backoff_delay(2, 60.0, 3600.0, 2.0), 108.0)
        with patch("apps.runner.time_utils.random.uniform", return_value=1.1):
            self.assertEqual(calculate_backoff_delay(2, 60.0, 3600.0, 2.0), 132.0)
