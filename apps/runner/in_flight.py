from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import sys
from typing import Any

from .redis_keys import orchestrator_root_key


_ACQUIRE_LOCK_LUA = r"""
local root_key = KEYS[1]
local lock_field = ARGV[1]
local now_iso = ARGV[2]
local payload_json = ARGV[3]

local existing = redis.call('HGET', root_key, lock_field)
if not existing then
  redis.call('HSET', root_key, lock_field, payload_json)
  return 1
end

local ok, decoded = pcall(cjson.decode, existing)
if not ok then
  redis.call('HDEL', root_key, lock_field)
  redis.call('HSET', root_key, lock_field, payload_json)
  return 1
end

local expires_at = tostring(decoded['expires_at'] or '')
if expires_at == '' then
  redis.call('HSET', root_key, lock_field, payload_json)
  return 1
end

if expires_at <= now_iso then
  redis.call('HSET', root_key, lock_field, payload_json)
  return 1
end

return 0
"""


_RELEASE_LOCK_LUA = r"""
local root_key = KEYS[1]
local lock_field = ARGV[1]
local run_id = ARGV[2]

local existing = redis.call('HGET', root_key, lock_field)
if not existing then
  return 0
end

local ok, decoded = pcall(cjson.decode, existing)
if not ok then
  redis.call('HDEL', root_key, lock_field)
  return 1
end

local existing_run_id = tostring(decoded['run_id'] or '')
if existing_run_id == run_id then
  redis.call('HDEL', root_key, lock_field)
  return 1
end

return 0
"""


def _utc_now_iso_ms() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _iso_after_seconds(now_iso: str, seconds: int) -> str:
    try:
        parsed = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    except ValueError:
        parsed = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    expires = parsed.astimezone(timezone.utc) + timedelta(seconds=int(seconds))
    return expires.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def acquire_in_flight_lock(
    *,
    redis_client: Any,
    repo_key: str,
    issue_number: int,
    run_id: str,
    role: str,
    ttl_s: int,
) -> bool:
    if issue_number <= 0:
        return True

    root_key = orchestrator_root_key(repo_key)
    lock_field = f"in_flight:{issue_number}"
    now_iso = _utc_now_iso_ms()
    payload = {
        "run_id": str(run_id),
        "role": str(role).strip().upper(),
        "acquired_at": now_iso,
        "expires_at": _iso_after_seconds(now_iso, ttl_s),
    }
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)

    eval_fn = getattr(redis_client, "eval", None)
    if not callable(eval_fn):
        try:
            sys.stderr.write(
                json.dumps(
                    {
                        "type": "IN_FLIGHT_LOCK_EVAL_UNAVAILABLE",
                        "repo_key": repo_key,
                        "issue_number": issue_number,
                        "run_id": str(run_id),
                        "role": str(role).strip().upper(),
                    },
                    separators=(",", ":"),
                    ensure_ascii=True,
                )
                + "\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return False

    try:
        result = eval_fn(_ACQUIRE_LOCK_LUA, 1, root_key, lock_field, now_iso, payload_json)
        return int(result or 0) == 1
    except Exception as exc:
        try:
            sys.stderr.write(
                json.dumps(
                    {
                        "type": "IN_FLIGHT_LOCK_EVAL_FAILED",
                        "repo_key": repo_key,
                        "issue_number": issue_number,
                        "run_id": str(run_id),
                        "role": str(role).strip().upper(),
                        "error": str(exc),
                    },
                    separators=(",", ":"),
                    ensure_ascii=True,
                )
                + "\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return False


def release_in_flight_lock(
    *,
    redis_client: Any,
    repo_key: str,
    issue_number: int,
    run_id: str,
) -> None:
    if issue_number <= 0:
        return
    root_key = orchestrator_root_key(repo_key)
    lock_field = f"in_flight:{issue_number}"

    eval_fn = getattr(redis_client, "eval", None)
    if not callable(eval_fn):
        try:
            sys.stderr.write(
                json.dumps(
                    {
                        "type": "IN_FLIGHT_UNLOCK_EVAL_UNAVAILABLE",
                        "repo_key": repo_key,
                        "issue_number": issue_number,
                        "run_id": str(run_id),
                    },
                    separators=(",", ":"),
                    ensure_ascii=True,
                )
                + "\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return

    try:
        eval_fn(_RELEASE_LOCK_LUA, 1, root_key, lock_field, str(run_id))
    except Exception as exc:
        try:
            sys.stderr.write(
                json.dumps(
                    {
                        "type": "IN_FLIGHT_UNLOCK_EVAL_FAILED",
                        "repo_key": repo_key,
                        "issue_number": issue_number,
                        "run_id": str(run_id),
                        "error": str(exc),
                    },
                    separators=(",", ":"),
                    ensure_ascii=True,
                )
                + "\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
        return
