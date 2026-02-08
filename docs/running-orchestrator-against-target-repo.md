# Running Orchestrator Against a Target Repo

Use these environment variables to run this infra repo against a different GitHub target:

```bash
TARGET_OWNER_LOGIN=<owner>
TARGET_OWNER_TYPE=user|org
TARGET_REPO_NAME=<repo>
TARGET_PROJECT_NAME=<project-v2-title>
TARGET_TEMPLATE_PATH=.github/ISSUE_TEMPLATE/milestone-task.yml
TARGET_REF=main
ORCHESTRATOR_SPRINT=M1
ORCHESTRATOR_BACKEND_BASE_URL=http://localhost:4000
ORCHESTRATOR_MAX_EXECUTORS=1
ORCHESTRATOR_MAX_REVIEWERS=1
ORCHESTRATOR_POLL_INTERVAL_MS=15000
ORCHESTRATOR_STALL_MINUTES=120
ORCHESTRATOR_STATE_PATH=.orchestrator-state.json
```

Run once:

```bash
pnpm orchestrator
```

Run loop mode:

```bash
node apps/orchestrator/src/cli.js --loop
```

Identity precedence:
- If any required `TARGET_*` identity variable is set, all required identity variables must be present and they override `policy/github-project.json`.
- If no `TARGET_*` identity override is present, identity falls back to `policy/github-project.json`.

Fail-closed behavior:
- Missing/invalid target identity fields: hard stop.
- Preflight `FAIL`: hard stop.
- Missing/unknown `Status` or `Sprint` for in-scope items: hard stop.
