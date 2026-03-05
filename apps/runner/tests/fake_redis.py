from __future__ import annotations

from collections import deque
import json
from typing import Any, Deque, Optional


class FakeRedis:
    def __init__(self) -> None:
        self._hashes: dict[str, dict[str, str]] = {}
        self._lists: dict[str, Deque[str]] = {}

    def hgetall(self, key: Any) -> dict[str, str]:
        return dict(self._hashes.get(str(key), {}))

    def hget(self, key: Any, field: Any) -> Optional[str]:
        return self._hashes.get(str(key), {}).get(str(field))

    def hset(self, key: Any, field: Any = None, value: Any = None, *, mapping: dict[str, Any] | None = None) -> int:
        normalized_key = str(key)
        hash_map = self._hashes.setdefault(normalized_key, {})

        if mapping is not None:
            for mapped_field, mapped_value in mapping.items():
                hash_map[str(mapped_field)] = "" if mapped_value is None else str(mapped_value)
            return len(mapping)

        if field is None:
            raise TypeError("hset requires field/value or mapping")

        hash_map[str(field)] = "" if value is None else str(value)
        return 1

    def hdel(self, key: Any, *fields: Any) -> int:
        hash_map = self._hashes.get(str(key))
        if not hash_map:
            return 0
        removed = 0
        for field in fields:
            if hash_map.pop(str(field), None) is not None:
                removed += 1
        return removed

    def rpush(self, key: Any, value: Any) -> int:
        queue = self._lists.setdefault(str(key), deque())
        queue.append(str(value))
        return len(queue)

    def lpush(self, key: Any, value: Any) -> int:
        queue = self._lists.setdefault(str(key), deque())
        queue.appendleft(str(value))
        return len(queue)

    def lpop(self, key: Any) -> Optional[str]:
        queue = self._lists.get(str(key))
        if not queue:
            return None
        try:
            return queue.popleft()
        except IndexError:
            return None

    def blpop(self, key: Any, timeout: int = 0):  # noqa: ARG002 - signature parity
        value = self.lpop(key)
        if value is None:
            return None
        return str(key), value

    def eval(self, script: Any, numkeys: int, *keys_and_args: Any):  # noqa: ARG002
        if int(numkeys or 0) != 1:
            raise ValueError("FakeRedis.eval only supports numkeys=1")
        if len(keys_and_args) < 1:
            raise ValueError("FakeRedis.eval requires at least one key")

        root_key = str(keys_and_args[0])

        # Acquire: key + lock_field + now_iso + payload_json
        if len(keys_and_args) == 4:
            lock_field = str(keys_and_args[1])
            now_iso = str(keys_and_args[2])
            payload_json = str(keys_and_args[3])

            existing = self.hget(root_key, lock_field)
            if existing is None or str(existing).strip() == "":
                self.hset(root_key, lock_field, payload_json)
                return 1

            decoded: dict[str, Any] | None = None
            try:
                decoded_value = json.loads(str(existing))
                if isinstance(decoded_value, dict):
                    decoded = decoded_value
            except json.JSONDecodeError:
                decoded = None

            if decoded is None:
                self.hdel(root_key, lock_field)
                self.hset(root_key, lock_field, payload_json)
                return 1

            expires_at = str(decoded.get("expires_at") or "")
            if expires_at == "" or expires_at <= now_iso:
                self.hset(root_key, lock_field, payload_json)
                return 1

            return 0

        # Release: key + lock_field + run_id
        if len(keys_and_args) == 3:
            lock_field = str(keys_and_args[1])
            run_id = str(keys_and_args[2])

            existing = self.hget(root_key, lock_field)
            if existing is None or str(existing).strip() == "":
                return 0

            decoded: dict[str, Any] | None = None
            try:
                decoded_value = json.loads(str(existing))
                if isinstance(decoded_value, dict):
                    decoded = decoded_value
            except json.JSONDecodeError:
                decoded = None

            if decoded is None:
                self.hdel(root_key, lock_field)
                return 1

            existing_run_id = str(decoded.get("run_id") or "")
            if existing_run_id == run_id:
                self.hdel(root_key, lock_field)
                return 1

            return 0

        raise ValueError("FakeRedis.eval unsupported argument count")

    def _snapshot_list(self, key: Any) -> list[str]:
        queue = self._lists.get(str(key))
        return list(queue) if queue else []
