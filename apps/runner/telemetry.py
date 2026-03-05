from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any

from .redis_keys import telemetry_events_channel


def _utc_now_iso_ms() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def publish_transcript_event(
    *,
    redis_client: Any,
    run_id: str,
    role: str,
    section: str,
    content: str,
    created_at: str | None = None,
) -> None:
    normalized_run_id = str(run_id or "").strip()
    normalized_role = str(role or "").strip().upper()
    normalized_section = str(section or "").strip().upper()
    normalized_content = str(content or "").strip()
    if not normalized_run_id or not normalized_role or not normalized_section or not normalized_content:
        return

    payload = {
        "run_id": normalized_run_id,
        "role": normalized_role,
        "section": normalized_section,
        "content": normalized_content,
        "created_at": str(created_at).strip() if isinstance(created_at, str) and created_at.strip() else _utc_now_iso_ms(),
    }

    try:
        redis_client.publish(telemetry_events_channel(normalized_run_id), json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
    except Exception:
        return

