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
- `docs/`: design, runbooks, and orchestration docs.

## Prerequisites

- Node.js `>=18` (repo uses ESM).
- `pnpm`.
- Python `3.12+` (runner).
- GitHub token with permissions to read/write the configured target project/repo as required by routes.
  - Set one of: `GITHUB_PAT` or `GITHUB_TOKEN`.
- Codex CLI with MCP servers `github` and `github_projects` enabled (runner).

## Quick Start

1. Install dependencies:
```bash
pnpm install
```

2. Configure GitHub auth:
```bash
export GITHUB_TOKEN="<token>"
```

3. Configure CLI target repo/project identity:
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

4. Configure target repo/project identity for API+orchestrator (recommended explicit mode):
```bash
export TARGET_OWNER_LOGIN="<owner>"
export TARGET_OWNER_TYPE="user"   # or org
export TARGET_REPO_NAME="<repo>"
export TARGET_PROJECT_NAME="<project-v2-title>"
export TARGET_TEMPLATE_PATH=".github/ISSUE_TEMPLATE/milestone-task.yml"  # optional
export TARGET_REF="HEAD"                                                # optional
```

5. Start internal API:
```bash
pnpm dev
```

6. Run preflight manually:
```bash
curl "http://localhost:4000/internal/preflight?role=ORCHESTRATOR"
```

7. Run CLI doctor preflight checks:
```bash
export GITHUB_TOKEN="<token>"
pnpm doctor
```

8. Run orchestrator once:
```bash
export ORCHESTRATOR_SPRINT="M1"
pnpm orchestrator
```

9. Run orchestrator loop mode:
```bash
node apps/orchestrator/src/cli.js --loop
```

10. Run runner once (executes orchestrator intents and workers):
```bash
pnpm runner
```

11. Dry-run runner (no backend write endpoints, no worker execution):
```bash
pnpm runner:dry
```

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

## API Endpoints (Internal)

- `GET /internal/preflight?role=<ROLE>`
- `POST /internal/run`
- `POST /internal/plan-apply`
- `POST /internal/project-item/update-field`
- `GET /internal/agent-context?role=<ROLE>`
- `POST /internal/executor/claim-ready-item`
- `POST /internal/reviewer/resolve-linked-pr`

## Commands

- Run API: `pnpm dev`
- Run tests: `pnpm test`
- Run CLI config parser test: `pnpm test:cli`
- Run doctor preflight checks: `pnpm doctor`
- Run orchestrator once: `pnpm orchestrator`
- Run runner once: `pnpm runner`
- Run runner dry-run: `pnpm runner:dry`

## Notes on Identity Resolution

Target identity precedence is deterministic:
- If any required `TARGET_*` identity env is set, env override mode is used and all required target identity vars must be present.
- Otherwise, fallback to `policy/github-project.json`.

## Key Docs

- `docs/running-orchestrator-against-target-repo.md`
- `docs/infra-repo-direction.md`
- `docs/executor-v1.md`
- `docs/reviewer-v1-runbook.md`
- `docs/agent-orchestrator.md`
- `docs/runner-contract.md`
- `apps/runner/README.md`
