# apps/runner (Python)

Python-based runner that consumes `apps/orchestrator` JSONL `RUN_INTENT` lines and spawns a fresh Codex MCP worker per intent.

## Requirements

- Python 3.12+
- Backend running (`pnpm dev`)
- Codex CLI configured with `github` and `github_projects` MCP servers (`codex mcp list`)

## Environment

Required:
- `BACKEND_BASE_URL` (e.g. `http://localhost:4000`)
- `ORCHESTRATOR_SPRINT` (e.g. `M1`)

Optional:
- `RUNNER_MAX_EXECUTORS` (default `1`)
- `RUNNER_MAX_REVIEWERS` (default `1`)
- `RUNNER_DRY_RUN` (default `false`)
- `RUNNER_LEDGER_PATH` (default `./.runner-ledger.json`)
- `RUNNER_ORCHESTRATOR_CMD` (default `node apps/orchestrator/src/cli.js --loop`)
- `CODEX_BIN` (default `codex`)
- `CODEX_MCP_ARGS` (default `mcp-server`)

Target repo identity config (`TARGET_*`) is passed through to `apps/orchestrator` and the backend via env.

## Run

Dry run (no backend write endpoints; does not execute worker intents):

```bash
BACKEND_BASE_URL=http://localhost:4000 ORCHESTRATOR_SPRINT=M1 \
python3 -m apps.runner --dry-run --once
```

Kickoff (goal -> issues via `/internal/plan-apply` -> auto-promote up to 3 tasks to `Ready`):

Dry-run kickoff (generates kickoff JSON + draft, no backend writes):

```bash
BACKEND_BASE_URL=http://localhost:4000 \
python3 -m apps.runner --kickoff --sprint M1 --goal "Sprint M1 should ship X" --dry-run
```

Live kickoff + run orchestrator once:

```bash
BACKEND_BASE_URL=http://localhost:4000 \
python3 -m apps.runner --kickoff --sprint M1 --goal-file ./goal.txt --once
```

Live kickoff + loop:

```bash
BACKEND_BASE_URL=http://localhost:4000 \
python3 -m apps.runner --kickoff --sprint M1 --goal-file ./goal.txt --loop
```

Loop mode:

```bash
BACKEND_BASE_URL=http://localhost:4000 ORCHESTRATOR_SPRINT=M1 \
python3 -m apps.runner
```

## Tests

```bash
python3 -m apps.runner.tests
```

## MCP status

Non-dry-run execution spawns `codex mcp-server` per intent and calls the MCP `codex` tool once per intent.
See `docs/runner-contract.md`.
