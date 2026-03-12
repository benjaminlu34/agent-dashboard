# Endpoint Contracts

Use this doc when changing internal API routes or wiring new backend behavior.

## Route Entry Points

- App registration: `apps/api/src/index.js`
- Route modules: `apps/api/src/routes/`
- Shared policy helpers: `apps/api/src/internal/`

## Rules

- New mutating routes must remain behind `/internal/preflight`.
- Route handlers must reuse existing policy, identity, and linkage helpers instead of duplicating logic.
- Status and project-field writes must continue to flow through backend routes, not orchestrator or runner direct writes.
- Any route change that affects runner/orchestrator contracts must update the corresponding tests and docs in the same change.

## Common Edit Paths

- Agent context route: `apps/api/src/routes/internal-agent-context.js`
- Status/field transitions: `apps/api/src/routes/internal-project-item-update-field.js`
- Executor claim flow: `apps/api/src/routes/internal-executor-claim-ready-item.js`
- Reviewer PR resolution: `apps/api/src/routes/internal-reviewer-resolve-linked-pr.js`
- Route registration: `apps/api/src/index.js`

## Test Expectations

- Add or update API coverage in `apps/api/test/`.
- If the route impacts runner contracts, update Python tests under `apps/runner/tests/`.
