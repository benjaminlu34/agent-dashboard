# Agent Swarm Infra Repo

This repository is the control-plane and policy runtime for a local, GitHub-backed agent swarm.

It is not an application product repo. It is infrastructure that orchestrates role-scoped agent workflows (`ORCHESTRATOR`, `EXECUTOR`, `REVIEWER`) against a target GitHub repository/project.

## Current Stage

Current maturity is **alpha (local/internal)**, not deploy-complete production alpha.

What exists now:
- Policy-gated internal API (`apps/api`) with preflight, planner/apply, executor claim, reviewer PR resolution, and status update endpoints.
- Orchestrator CLI (`apps/orchestrator`) that emits deterministic JSON run intents for worker roles.
- Python runner (`apps/runner`) that consumes orchestrator JSONL intents, executes Codex MCP workers, handles kickoff planning, maintains a run ledger, and manages resiliency loops (review stalls, blocked retries, watchdogs).
- Target-repo identity overrides via env (`TARGET_*`) with fail-closed validation.
- Preflight template validation against the **target repo on GitHub**.
- Test suite for policy, linkage, preflight, orchestrator loop behavior.

What still needs to be done for deploy-grade alpha:
- CI workflow(s) for test/lint/typecheck gates on PRs (no `.github/workflows/*` currently).
- Runtime auth hardening for internal API endpoints (currently token-based GitHub access only; no service auth layer documented).
- Deployment packaging/runtime manifests (no Dockerfile/compose/K8s manifests in repo).
- Persistent orchestrator state backend if multi-runner or restart durability is needed (current state is local JSON file).
- Operational observability baseline (structured logs exist, but no metrics/alerts pipeline documented).

## Repo Layout

- `AGENTS.md`: global governance contract.
- `agents/*.md`: role overlays.
- `policy/*.json`: machine-readable policy (project schema, transitions, permissions, target identity fallback).
- `apps/api`: Fastify internal control-plane API.
- `apps/orchestrator`: scheduler/dispatcher CLI that emits JSON run intents.
- `apps/runner`: Python runner that executes run intents and automates promotion/review handling.
- `apps/web`: scaffold only (not active runtime).
- `docs/`: layered agent docs with runbooks, contracts, architecture notes, and navigation metadata.

## Prerequisites

- Node.js `>=18` (repo uses ESM).
- `pnpm`.
- Python `3.12+` (runner).
- Redis `7+` reachable via `REDIS_URL` (default `redis://localhost:6379/0`).
- GitHub token with permissions to read/write the configured target project/repo as required by routes.
  - `pnpm doctor` defaults to `GITHUB_TOKEN` (via `.agent-swarm.yml auth.github_token_env`).
  - Existing API/orchestrator flows accept `GITHUB_PAT` or `GITHUB_TOKEN`.
- Codex CLI with MCP servers `github` and `github_projects` enabled (runner).

## Quick Start

1. Install dependencies:
```bash
pnpm install
```

2. Install and start Redis in WSL/Linux:
```bash
sudo apt update
sudo apt install -y redis-server
sudo service redis-server start
```

Check status:
```bash
sudo service redis-server status
```

The default connection string is:
```bash
export REDIS_URL="redis://localhost:6379/0"
```

If you start Redis with `redis-server --port 6379`, that is a foreground process for the current shell only and you must start it again next time. Using `sudo service redis-server start` runs Redis as a background service.

3. Configure GitHub auth:
```bash
export GITHUB_TOKEN="<token>"
```

4. Configure CLI target repo/project identity in repo root (`./.agent-swarm.yml`):
- Option A (recommended): run interactive init from the repo root:
```bash
pnpm swarm:init
```
- Option B: create the file manually:
```bash
cat > .agent-swarm.yml <<'YAML'
version: "1.0"
target:
  owner: "<owner>"
  repo: "<repo>"
  project_v2_number: 1
auth:
  github_token_env: "GITHUB_TOKEN"
YAML
```

5. Configure target repo/project identity for API+orchestrator (recommended explicit mode):
```bash
export TARGET_OWNER_LOGIN="<owner>"
export TARGET_OWNER_TYPE="user"   # or org
export TARGET_REPO_NAME="<repo>"
export TARGET_PROJECT_NAME="<project-v2-title>"
export TARGET_TEMPLATE_PATH=".github/ISSUE_TEMPLATE/milestone-task.yml"  # optional
export TARGET_REF="HEAD"                                                # optional
```

6. Before `pnpm dev`, configure status-state input for dashboard/API status route:
- Option A (auto-scoped defaults from `.agent-swarm.yml`):
  - Ensure `.agent-swarm.yml` contains:
    - `target.owner`
    - `target.repo`
  - The status endpoint will read:
    - `./.orchestrator-state.<sanitized-owner>.<sanitized-repo>.json`
    - `./.runner-ledger.<sanitized-owner>.<sanitized-repo>.json`
- Option B (explicit state file paths via env):
```bash
export ORCHESTRATOR_STATE_PATH="./.orchestrator-state.json"
export RUNNER_LEDGER_PATH="./.runner-ledger.json"
```
- If neither scoped files nor explicit files exist yet, `GET /internal/status` returns empty objects and dashboard sections show empty states.

7. Start internal API:
```bash
pnpm dev
```

8. Run preflight manually:
```bash
curl "http://localhost:4000/internal/preflight?role=ORCHESTRATOR"
```

9. Run CLI doctor preflight checks:
```bash
export GITHUB_TOKEN="<token>"
pnpm doctor
```

10. Run orchestrator once:
```bash
export ORCHESTRATOR_SPRINT="M1"
pnpm orchestrator
```

11. Run orchestrator loop mode:
```bash
node apps/orchestrator/src/cli.js --loop
```

12. Run runner once (executes orchestrator intents and workers):
```bash
pnpm runner
```

13. Dry-run runner (no backend write endpoints, no worker execution):
```bash
pnpm runner:dry
```

## CLI Doctor

`pnpm doctor` reads `.agent-swarm.yml` in your current working directory and runs three preflight checks:
- Check 1: token presence/auth/scopes using `auth.github_token_env` (defaults to `GITHUB_TOKEN`).
- Check 2: read/write connectivity for `target.owner` + `target.repo`.
- Check 3: required template presence at `.github/ISSUE_TEMPLATE/milestone-task.yml`.

Doctor exit codes:
- `0`: all checks passed.
- `1`: one or more checks failed.

Remediation output is intentionally safe-by-default:
- Template fix remediation uses `mktemp`, creates a dedicated branch, and does not push to the default branch.
- The script refuses to overwrite an existing template file.
- A human review/approval step is still required before merge.

## Orchestrator Runtime Config

Required:
- `ORCHESTRATOR_SPRINT`

Optional:
- `ORCHESTRATOR_BACKEND_BASE_URL` (default `http://localhost:4000`)
- `ORCHESTRATOR_REPO_ROOT` (default repo root)
- `ORCHESTRATOR_MAX_EXECUTORS` (default `1`)
- `ORCHESTRATOR_MAX_REVIEWERS` (default `1`)
- `ORCHESTRATOR_POLL_INTERVAL_MS` (default `15000`)
- `ORCHESTRATOR_STALL_MINUTES` (default `120`)
- `ORCHESTRATOR_REVIEW_CHURN_POLLS` (default `3`)
- `ORCHESTRATOR_REVIEWER_RETRY_POLLS` (default `20`)
- `ORCHESTRATOR_EXECUTOR_RETRY_POLLS` (default `20`)
- `ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS` (default `2`)
- `ORCHESTRATOR_STATE_PATH` (default `./.orchestrator-state.json`)
- `ORCHESTRATOR_ITEMS_FILE` (fixture JSON for local testing)

Exit codes:
- `0`: normal completion/run success
- `2`: preflight/identity/validation hard stop
- `3`: malformed sprint-scoped item data
- `4`: transient preflight/template retries exhausted

## Runner Runtime Config

Required:
- `ORCHESTRATOR_SPRINT` (or pass `--sprint`)

Optional:
- `BACKEND_BASE_URL` (default `http://localhost:4000`)
- `BACKEND_TIMEOUT_S` (default `120`)
- `RUNNER_MAX_EXECUTORS` (default `3`)
- `RUNNER_MAX_REVIEWERS` (default `2`)
- `RUNNER_READY_BUFFER` (default `2`)
- `REVIEW_STALL_POLLS` (default `50`)
- `BLOCKED_RETRY_MINUTES` (default `15`)
- `RUNNER_WATCHDOG_TIMEOUT_S` (default `900`)
- `RUNNER_DRY_RUN` (default `false`)
- `RUNNER_LEDGER_PATH` (default `./.runner-ledger.json`)
- `RUNNER_SPRINT_PLAN_PATH` (default `./.runner-sprint-plan.json`)
- `RUNNER_AUTOPROMOTE` (default `true`)
- `ORCHESTRATOR_STATE_PATH` (default `./.orchestrator-state.json`)
- `RUNNER_ORCHESTRATOR_CMD` (default `node apps/orchestrator/src/cli.js --loop`)
- `CODEX_BIN` (default `codex`)
- `CODEX_MCP_ARGS` (default `mcp-server`)
- `CODEX_TOOLS_CALL_TIMEOUT_S` (default `1800`)
- `ORCHESTRATOR_SANITIZATION_REGEN_ATTEMPTS` (default `2`)

Watchdog tuning note:
- `RUNNER_WATCHDOG_TIMEOUT_S` should be configured for worst-case worker runtime (especially reviewer runs). If set too low, repeated reviewer watchdog timeouts can increase review cycles and push items into cycle-cap blocking.

## API Endpoints (Internal)

- `GET /internal/preflight?role=<ROLE>`
- `POST /internal/run`
- `POST /internal/plan-apply`
- `POST /internal/project-item/update-field`
- `GET /internal/agent-context?role=<ROLE>`
- `POST /internal/executor/claim-ready-item`
- `POST /internal/reviewer/resolve-linked-pr`
- `POST /internal/kickoff/start-loop`
- `POST /internal/runner/start-loop`

## Commands

- Run API: `pnpm dev`
- Run tests: `pnpm test`
- Run CLI config parser test: `pnpm test:cli`
- Init `.agent-swarm.yml` + required template: `pnpm swarm:init`
- Run doctor preflight checks: `pnpm doctor`
- Run orchestrator once: `pnpm orchestrator`
- Run runner once: `pnpm runner`
- Run runner dry-run: `pnpm runner:dry`
- Start runner loop without kickoff: `python3 -m apps.runner --sprint M1 --loop`

## Notes on Identity Resolution

Target identity precedence is deterministic:
- If any required `TARGET_*` identity env is set, env override mode is used and all required target identity vars must be present.
- Otherwise, fallback to `policy/github-project.json`.

## Key Docs

- `docs/README.md`
- `docs/runbooks/start-local-control-plane.md`
- `docs/runbooks/run-against-target-repo.md`
- `docs/runbooks/executor-v1.md`
- `docs/runbooks/reviewer-v1.md`
- `docs/contracts/runner-contract.md`
- `docs/contracts/orchestrator-dispatch.md`
- `docs/contracts/agent-context-bundle.md`
- `docs/contracts/endpoint-contracts.md`
- `docs/architecture/infra-repo-direction.md`
- `docs/architecture/module-map.md`
- `apps/runner/README.md`
