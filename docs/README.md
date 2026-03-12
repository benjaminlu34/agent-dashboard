# Documentation Map

This repository uses a three-layer documentation hierarchy for agent navigation:

1. `AGENTS.md` is the Layer 1 command center.
2. Bucket indexes in `docs/` are Layer 2 routing guides.
3. The individual docs below each bucket are Layer 3 deep references.

## Buckets

- `docs/runbooks/README.md`
  - Keywords: setup, operate, execute, review, target-repo, roles
  - Use when you need the step-by-step workflow for an operator or worker role.
- `docs/contracts/README.md`
  - Keywords: bundle, routes, endpoints, runner, ownership, invariants
  - Use when you need exact behavior, schema, or enforcement rules.
- `docs/architecture/README.md`
  - Keywords: topology, module-map, repo-shape, coupling, rationale
  - Use when you need system structure or code-to-subsystem mapping.

## Common Tasks

- Modify Agent Logic -> `docs/runbooks/executor-v1.md`
- Update API Routes -> `docs/contracts/endpoint-contracts.md`
- Change Permissions -> `docs/contracts/agent-context-bundle.md`
- Adjust Transitions -> `docs/contracts/task-ownership.md`
- Run locally -> `docs/runbooks/start-local-control-plane.md`
- Run against a target repo -> `docs/runbooks/run-against-target-repo.md`

## Search Fallback

If the recommended docs are insufficient, check these next:

- `docs/runbooks/README.md`
- `docs/contracts/README.md`
- `docs/architecture/README.md`
- `docs/architecture/module-map.md`
