from __future__ import annotations

import pathlib
import unittest


def main() -> int:
    suite = unittest.defaultTestLoader.discover(
        start_dir=str(pathlib.Path(__file__).resolve().parent),
        pattern="test_*.py",
        top_level_dir=str(pathlib.Path(__file__).resolve().parents[2]),
    )
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
