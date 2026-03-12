# Module Map

Use this file when the recommended docs are not enough and you need a direct code pointer.

| Subsystem | Files / Directories | Purpose | Deep Doc |
| --- | --- | --- | --- |
| API route registration | `apps/api/src/index.js` | Registers Fastify internal routes and static assets. | `docs/contracts/endpoint-contracts.md` |
| Agent context delivery | `apps/api/src/routes/internal-agent-context.js`, `apps/api/src/internal/agent-context-loader.js` | Builds the six-file bundle and enriches worker context. | `docs/contracts/agent-context-bundle.md` |
| Policy enforcement | `apps/api/src/internal/policy/enforcement.js`, `apps/api/src/routes/internal-project-item-update-field.js` | Applies permission, schema, and transition checks. | `docs/contracts/task-ownership.md` |
| Target identity resolution | `apps/api/src/internal/target-identity.js`, `apps/api/src/internal/agent-swarm-config.js` | Resolves env overrides and policy fallback for target repo identity. | `docs/architecture/infra-repo-direction.md` |
| Orchestrator dispatch | `apps/orchestrator/src/cli.js`, `apps/orchestrator/src/sanitize-dependency-graph.js` | Computes dispatches, scheduler state, and dependency sanitization. | `docs/contracts/orchestrator-dispatch.md` |
| Runner supervisor loop | `apps/runner/supervisor.py`, `apps/runner/daemon.py` | Pulls intents, manages worktrees, watchdogs, retries, and ledger updates. | `docs/contracts/runner-contract.md` |
| Codex worker prompt + MCP | `apps/runner/codex_worker.py`, `apps/runner/http_client.py` | Builds worker prompts and calls Codex MCP + backend endpoints. | `docs/runbooks/executor-v1.md` |
| Kickoff planning | `apps/runner/kickoff.py`, `apps/runner/kickoff_runtime.py`, `apps/api/src/routes/internal-plan-apply.js` | Generates sprint plans and applies tasks through the backend. | `docs/runbooks/add-agent-role.md` |
