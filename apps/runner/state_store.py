from __future__ import annotations

import json
import sys
import time
from typing import Any, Optional

from .redis_keys import orchestrator_items_key, orchestrator_root_key


def _decode_redis_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value
    return str(value)


def _decode_redis_hash(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    decoded: dict[str, str] = {}
    for key, value in raw.items():
        decoded[_decode_redis_value(key)] = _decode_redis_value(value)
    return decoded


def _parse_json_object(raw: str) -> Optional[dict[str, Any]]:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _log_stderr(payload: dict[str, Any]) -> None:
    try:
        sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
        sys.stderr.flush()
    except Exception:
        return


class RedisStateStore:
    def __init__(self, redis_client: Any):
        self._redis = redis_client

    def get_root(self, repo_key: str) -> dict[str, str]:
        key = orchestrator_root_key(repo_key)
        raw = self._redis.hgetall(key)
        decoded = _decode_redis_hash(raw)

        for json_field in ("sprint_plan", "ownership_index"):
            raw_value = decoded.get(json_field)
            if raw_value is None:
                continue
            if raw_value == "":
                continue
            if _parse_json_object(raw_value) is not None:
                continue
            try:
                self._redis.hdel(key, json_field)
            except Exception:
                pass
            decoded.pop(json_field, None)
            _log_stderr(
                {
                    "type": "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
                    "repo_key": repo_key,
                    "redis_key": key,
                    "field": json_field,
                    "backup_path": "",
                    "error": f"root field contains invalid JSON: {json_field}",
                }
            )

        return decoded

    def set_root_fields(self, repo_key: str, mapping: dict[str, str]) -> None:
        key = orchestrator_root_key(repo_key)
        normalized: dict[str, str] = {}
        for field, value in (mapping or {}).items():
            if not isinstance(field, str) or not field:
                continue
            normalized[field] = value if isinstance(value, str) else str(value)
        if not normalized:
            return
        self._redis.hset(key, mapping=normalized)

    def get_root_field(self, repo_key: str, field: str) -> Optional[str]:
        if not isinstance(field, str) or not field:
            return None
        key = orchestrator_root_key(repo_key)
        raw = self._redis.hget(key, field)
        if raw is None:
            return None
        return _decode_redis_value(raw)

    def get_item(self, repo_key: str, project_item_id: str) -> Optional[dict[str, Any]]:
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            return None
        key = orchestrator_items_key(repo_key)
        field = project_item_id.strip()
        raw = self._redis.hget(key, field)
        if raw is None:
            return None
        decoded = _decode_redis_value(raw)
        parsed = _parse_json_object(decoded)
        if parsed is not None:
            return parsed

        try:
            self._redis.hdel(key, field)
        except Exception:
            pass

        _log_stderr(
            {
                "type": "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
                "repo_key": repo_key,
                "redis_key": key,
                "field": field,
                "backup_path": "",
                "error": "state item contains invalid JSON",
            }
        )
        return None

    def set_item(self, repo_key: str, project_item_id: str, item_dict: dict[str, Any]) -> None:
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            raise ValueError("project_item_id is required")
        if not isinstance(item_dict, dict):
            raise ValueError("item_dict must be a dict")
        key = orchestrator_items_key(repo_key)
        field = project_item_id.strip()
        value = json.dumps(item_dict, separators=(",", ":"), ensure_ascii=True)
        self._redis.hset(key, field, value)

    def delete_item(self, repo_key: str, project_item_id: str) -> None:
        if not isinstance(project_item_id, str) or not project_item_id.strip():
            return
        key = orchestrator_items_key(repo_key)
        self._redis.hdel(key, project_item_id.strip())

    def get_all_items(self, repo_key: str) -> dict[str, dict[str, Any]]:
        key = orchestrator_items_key(repo_key)
        raw = self._redis.hgetall(key)
        decoded = _decode_redis_hash(raw)
        parsed_items: dict[str, dict[str, Any]] = {}
        to_delete: list[str] = []

        for project_item_id, raw_value in decoded.items():
            parsed = _parse_json_object(raw_value)
            if parsed is None:
                to_delete.append(project_item_id)
                continue
            parsed_items[project_item_id] = parsed

        if to_delete:
            try:
                self._redis.hdel(key, *to_delete)
            except Exception:
                for project_item_id in to_delete:
                    try:
                        self._redis.hdel(key, project_item_id)
                    except Exception:
                        pass
            for project_item_id in to_delete:
                _log_stderr(
                    {
                        "type": "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
                        "repo_key": repo_key,
                        "redis_key": key,
                        "field": project_item_id,
                        "backup_path": "",
                        "error": "state item contains invalid JSON",
                    }
                )

        return parsed_items

    def touch_daemon_heartbeat(self, repo_key: str) -> None:
        now_ms = int(time.time() * 1000)
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000))
        self.set_root_fields(repo_key, {"daemon_heartbeat_at": now_iso})

