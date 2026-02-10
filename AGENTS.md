## Automation Governance
- System of record: GitHub Projects + Issues.
- Human approval required: automation must never merge PRs or close issues.
- One PR per issue is mandatory.
- Required issue template: `.github/ISSUE_TEMPLATE/milestone-task.yml`. If missing or altered from contract, stop and report.
- Required project schema for `Codex Task Board`:
  - `Status`: `Backlog`, `Ready`, `In Progress`, `In Review`, `Needs Human Approval`, `Blocked`, `Done`
  - `Size`: `S`, `M`, `L`
  - `Area`: `db`, `api`, `web`, `providers`, `infra`, `docs`
  - `Priority`: `P0`, `P1`, `P2`
  - `Sprint`: `M1`, `M2`, `M3`, `M4`
  - Use `Sprint` (not GitHub Milestone).
- Role overlays are in `agents/*.md`; overlays can only add restrictions.
- Fail closed on ambiguity or policy/schema/template mismatch.

## Working Rules
- Deliver complete, production-intent changes; avoid partial handoffs.
- Keep changes small and deterministic; avoid unrelated refactors.
- Prefer simple, maintainable implementations over cleverness.
- If blocked by ambiguity, ask one focused question or document a single explicit assumption.

## Quality Bar
- Every behavior change needs at least one of:
  - unit test, or
  - integration/API test, or
  - deterministic manual verification steps.
- Keep commands valid and reproducible.
- Update docs when behavior or setup changes.

## Commands
- Install: `pnpm install`
- Dev: `pnpm dev`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`

## Autonomy Boundaries
- Allowed without asking: normal code edits and standard dev commands.
- Must ask before:
  - destructive commands (`rm -rf`, DB drops, migration wipes)
  - changing lint/test/typecheck configuration
  - adding dependencies
  - modifying CI workflows
