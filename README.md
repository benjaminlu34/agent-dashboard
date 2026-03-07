# Agent Dashboard Control Plane

This repository is the control-plane runtime for a local, GitHub-backed agent swarm.

It is not the product application repository. It provides the policy bundle, backend routes, orchestrator, runner, CLI tooling, and dashboard used to drive role-scoped agent work against a target GitHub repository and Project V2 board.

## What Lives Here

- `apps/api`: Fastify backend for internal orchestration routes, configuration, metadata, status, kickoff, and logs. It also serves the local dashboard UI.
- `apps/orchestrator`: Node CLI that reads policy plus target state and emits deterministic `RUN_INTENT` JSONL for worker roles.
- `apps/runner`: Python runner that executes orchestrator intents through Codex MCP, manages kickoff, autopromotion, in-flight serialization, watchdogs, retries, and recovery.
- `apps/cli`: local operator CLI for `init` and `doctor`.
- `apps/web`: static dashboard assets served by `apps/api`. In this repo it is control-plane UI only, not a product app.
- `agents/` and `policy/`: role overlays and machine-readable policy consumed verbatim by the backend and runner.
- `docs/`: runbooks and contracts for orchestrator, runner, kickoff, and target-repo operation.

## Prerequisites

- Node.js `>=18`
- `pnpm`
- Python `3.12+`
- Redis `7+` reachable at `REDIS_URL` (default `redis://localhost:6379/0`)
- GitHub token with access to the target repository and Project V2
- Codex CLI with `github` and `github_projects` MCP servers enabled for non-dry-run runner execution

## Quick Start

1. Install dependencies:

```bash
pnpm install
pip install -r apps/runner/requirements.txt
```

2. Start Redis:

```bash
sudo apt update
sudo apt install -y redis-server
sudo service redis-server start
export REDIS_URL=redis://localhost:6379/0
```

3. Configure GitHub auth:

```bash
export GITHUB_TOKEN=<token>
```

4. Configure the target repo and project in the repo root:

Recommended:

```bash
pnpm swarm:init
```

This writes `./.agent-swarm.yml` and the required issue template path for local bootstrap.

5. Start the backend:

```bash
pnpm dev
```

Then open `http://localhost:4000`.

`pnpm dev` starts the backend and serves the dashboard. From the UI, `Start Kickoff Loop (Step 2)` and `Start Runner Loop (No Kickoff)` will start the runner daemon automatically if it is not already running.

6. Run preflight checks:

```bash
pnpm doctor
```

`doctor` validates:

- token presence and active scopes
- read/write access to the configured target repo
- required issue template presence at `.github/ISSUE_TEMPLATE/milestone-task.yml`

7. Run the orchestration flow:

From the dashboard UI you can:

- open `Settings` and save target owner, repo, project number, token, and worker counts
- save a sprint goal
- click `Start Kickoff Loop (Step 2)` for a new sprint
- click `Start Runner Loop (No Kickoff)` when tasks already exist
- seal a pending-verification sprint
- stop active runner or kickoff loops

The UI still assumes the backend from step 5 is already running. It cannot start `pnpm dev` for you because the dashboard is served by that backend.

8. CLI alternatives:

Run orchestrator once:

```bash
export ORCHESTRATOR_SPRINT=M1
pnpm orchestrator
```

Run the runner once:

```bash
export ORCHESTRATOR_SPRINT=M1
pnpm runner
```

Dry-run the runner:

```bash
export ORCHESTRATOR_SPRINT=M1
pnpm runner:dry
```

Run kickoff plus the loop directly from the runner:

```bash
python3 -m apps.runner --kickoff --sprint M1 --goal-file ./goal.txt --loop
```

Use these CLI commands when you want a one-shot/manual flow instead of driving execution from the dashboard.

## Root Commands

Use the root `package.json` scripts as the repo entrypoints.

- `pnpm dev`: start `apps/api` on port `4000`
- `pnpm swarm:init`: create or update local `.agent-swarm.yml`
- `pnpm doctor`: verify auth, repo access, and required template
- `pnpm orchestrator`: run the orchestrator once
- `pnpm runner`: run the Python runner once
- `pnpm runner:dry`: dry-run the runner once
- `pnpm test`: run API tests
- `pnpm test:cli`: run CLI tests
- `pnpm test:web`: run dashboard unit tests
- `pnpm test:web:e2e`: run Playwright dashboard tests
- `pnpm test:all`: run API tests plus dashboard unit and e2e tests

Runner tests are separate:

```bash
python3 -m apps.runner.tests
```

To run the persistent runner daemon manually instead of letting the dashboard start it:

```bash
python3 -m apps.runner --sprint M1
```

## Configuration Notes

### `.agent-swarm.yml`

The local CLI reads `./.agent-swarm.yml` for:

- target owner
- target repo
- Project V2 number
- which environment variable contains the GitHub token

### `TARGET_*` identity overrides

The backend and orchestrator can also run in explicit env-override mode. If any required `TARGET_*` variable is set, all required target identity variables must be set. Otherwise identity falls back to policy configuration.

Common variables:

- `TARGET_OWNER_LOGIN`
- `TARGET_OWNER_TYPE`
- `TARGET_REPO_NAME`
- `TARGET_PROJECT_NAME`
- `TARGET_TEMPLATE_PATH`
- `TARGET_REF`

### State and ledger files

The control plane uses local JSON files for stateful coordination:

- orchestrator state: `./.orchestrator-state*.json`
- runner ledger: `./.runner-ledger*.json`
- sprint plan cache: `./.runner-sprint-plan.json`

When `.agent-swarm.yml` is present, the default orchestrator and ledger paths are scoped by owner and repo.

## Runtime Responsibilities

- Backend routes enforce preflight, project field validation, transition rules, claim locking, PR linkage validation, and kickoff/metadata contracts.
- Orchestrator emits strict role-scoped intents and keeps local scheduler state, including corruption recovery and runner-managed field merge behavior.
- Runner executes intents via Codex MCP, maintains per-issue serialization, promotes `Backlog` work to `Ready` when configured, and applies recovery flows for stalled or failed work.

## Key Docs

- `docs/quickstart.md`
- `docs/agent-orchestrator.md`
- `docs/runner-contract.md`
- `docs/infra-repo-direction.md`
- `docs/running-orchestrator-against-target-repo.md`
- `docs/agent-context-bundle.md`
- `docs/executor-v1.md`
- `docs/reviewer-v1-runbook.md`
- `apps/runner/README.md`
