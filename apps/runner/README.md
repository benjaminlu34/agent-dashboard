# apps/runner (Python)

Python-based runner that consumes `apps/orchestrator` JSONL `RUN_INTENT` lines and spawns a fresh Codex MCP worker per intent.

## Requirements

- Python 3.12+
- Backend running (`pnpm dev`)
- Codex CLI configured with `github` and `github_projects` MCP servers (`codex mcp list`)

## Environment

Required:
- `ORCHESTRATOR_SPRINT` (e.g. `M1`)

Optional:
- `BACKEND_BASE_URL` (default `http://localhost:4000`)
- `BACKEND_TIMEOUT_S` (default `120`)
- `RUNNER_MAX_EXECUTORS` (default `3`)
- `RUNNER_MAX_REVIEWERS` (default `2`)
- `RUNNER_READY_BUFFER` (default `2`) - minimum number of `Ready` items runner tries to maintain via promotion
- `REVIEW_STALL_POLLS` (default `50`) - after this many `In Review` polls, allow one retry reviewer dispatch; if still stalled, escalate
- `BLOCKED_RETRY_MINUTES` (default `15`) - cooldown before auto-retrying retryable `Blocked` items back to `Ready`
- `RUNNER_WATCHDOG_TIMEOUT_S` (default `900`) - timeout for stale `running` executor runs before forced `In Progress/In Review -> Blocked`
- `RUNNER_DRY_RUN` (default `false`)
- `RUNNER_LEDGER_PATH` (default `./.runner-ledger.json`)
- `RUNNER_SPRINT_PLAN_PATH` (default `./.runner-sprint-plan.json`)
- `RUNNER_AUTOPROMOTE` (default `true`) - auto-promotes Backlog tasks to `Ready` to maintain buffer
- `ORCHESTRATOR_STATE_PATH` (default `./.orchestrator-state.json`)
- `RUNNER_ORCHESTRATOR_CMD` (default `node apps/orchestrator/src/cli.js --loop`)
- `CODEX_BIN` (default `codex`)
- `CODEX_MCP_ARGS` (default `mcp-server`)
- `CODEX_TOOLS_CALL_TIMEOUT_S` (default `1800`) - timeout for a single Codex MCP `tools/call` worker run
- `ORCHESTRATOR_SANITIZATION_REGEN_ATTEMPTS` (default `2`) - dependency sanitization regen tries (`0` disables regen and preserves immediate malformed-item stop)

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

## CLI options

- `--dry-run`: do not call backend write endpoints or execute worker intents
- `--once`: run orchestrator once and exit
- `--loop`: run orchestrator loop (default when not using kickoff)
- `--kickoff`: generate and apply a sprint plan before running orchestrator
- `--sprint <M1..M4>`: override `ORCHESTRATOR_SPRINT`
- `--goal <text>`: kickoff goal text (requires `--kickoff`)
- `--goal-file <path>`: kickoff goal text file (requires `--kickoff`)
- `--ready-limit <1..3>`: max dependency-free tasks to auto-promote to Ready during kickoff

## Tests

```bash
python3 -m apps.runner.tests
```

## MCP status

Non-dry-run execution spawns `codex mcp-server` per intent and calls the MCP `codex` tool once per intent.
See `docs/runner-contract.md`.

Worker sandbox policy:
- `EXECUTOR` runs with `workspace-write` sandbox (repo workspace writes only).
- `REVIEWER` runs with `read-only` sandbox.
- Worker prompts also require no reads/writes outside repository workspace.

## Automation behaviors

- Maintains a Ready buffer by auto-promoting Backlog tasks when `RUNNER_AUTOPROMOTE` is enabled.
- Applies dependency-graph sanitization before promotion and can request external regeneration when cycles remain (`{ORCHESTRATOR_STATE_PATH}.regen-request.json`).
- Retries retryable Blocked items after `BLOCKED_RETRY_MINUTES` based on ledger classification.
- Escalates long-running In Review stalls after `REVIEW_STALL_POLLS` and bounded reviewer retries.
- Blocks items that exceed the review cycle cap (5 cycles).
- Enforces a watchdog timeout for stale running intents (`RUNNER_WATCHDOG_TIMEOUT_S`).

## Human Rework Loop

When an item is in `Needs Human Approval`, request additional changes by moving:
- `Needs Human Approval` -> `In Review`

Do not move it back to `Ready`. This keeps one-PR linkage intact and causes orchestrator to run executor fixups on the existing linked PR branch.

## Operational events

Runner emits structured stderr events for resiliency workflows:
- `REVIEW_OUTCOME` (`PASS` | `FAIL` | `INCOMPLETE`)
- `REVIEW_STALL_DETECTED`
- `REVIEW_STALL_ESCALATED`
- `BLOCKED_RETRY`
- `REVIEW_CYCLE_CAP_BLOCKED`
- `WORKER_WATCHDOG_TIMEOUT`
