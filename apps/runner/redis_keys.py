from __future__ import annotations


def orchestrator_root_key(repo_key: str) -> str:
    return f"orchestrator:state:{repo_key}:root"


def orchestrator_items_key(repo_key: str) -> str:
    return f"orchestrator:state:{repo_key}:items"


def orchestrator_ledger_key(repo_key: str) -> str:
    return f"orchestrator:ledger:{repo_key}"


def orchestrator_intents_queue_key(*, role: str, repo_key: str) -> str:
    normalized_role = str(role or "").strip().upper()
    return f"orchestrator:queue:intents:{normalized_role}:{repo_key}"


def orchestrator_control_key(repo_key: str) -> str:
    return f"orchestrator:control:{repo_key}"


def telemetry_events_channel(run_id: str) -> str:
    return f"telemetry:events:{run_id}"

