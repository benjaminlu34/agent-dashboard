from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def normalize_iso(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def minutes_since(start_iso: Any, *, now_iso: str) -> int:
    start_normalized = normalize_iso(start_iso)
    now_normalized = normalize_iso(now_iso)
    if not start_normalized or not now_normalized:
        return 0
    start_dt = datetime.fromisoformat(start_normalized.replace("Z", "+00:00"))
    now_dt = datetime.fromisoformat(now_normalized.replace("Z", "+00:00"))
    delta = now_dt - start_dt
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds() // 60)


def seconds_since(start_iso: Any, *, now_iso: str) -> int:
    start_normalized = normalize_iso(start_iso)
    now_normalized = normalize_iso(now_iso)
    if not start_normalized or not now_normalized:
        return 0
    start_dt = datetime.fromisoformat(start_normalized.replace("Z", "+00:00"))
    now_dt = datetime.fromisoformat(now_normalized.replace("Z", "+00:00"))
    delta = now_dt - start_dt
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds())


def is_after_iso(left_iso: Any, right_iso: Any) -> bool:
    left_normalized = normalize_iso(left_iso)
    right_normalized = normalize_iso(right_iso)
    if not left_normalized or not right_normalized:
        return False
    left_dt = datetime.fromisoformat(left_normalized.replace("Z", "+00:00"))
    right_dt = datetime.fromisoformat(right_normalized.replace("Z", "+00:00"))
    return left_dt > right_dt

