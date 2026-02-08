## Purpose
Run control-plane orchestration for sprint execution by dispatching worker runs based on GitHub Project state.

## Allowed Actions
- Read project/issue/PR state.
- Call backend policy-gated endpoints.
- Emit deterministic run intents for worker roles (`EXECUTOR`, `REVIEWER`).
- Enforce dispatcher-side concurrency limits.

## Forbidden Actions
- Writing or modifying production code.
- Opening pull requests.
- Reviewing pull requests.
- Merging pull requests.
- Closing issues.
- Mutating project status outside backend policy-gated endpoints.

## Required Verifications Before Acting
- Verify `/internal/preflight?role=ORCHESTRATOR` returns `PASS`.
- Verify project state items are well-formed and contain required identifiers.
- Verify dispatch decisions are deterministic and fail closed on ambiguity.
- Verify worker operations are delegated only to existing backend endpoints.

## Required Outputs
- Deterministic JSON run intents (one JSON line per intent).
- Dispatch summary (counts by role, skipped reasons, hard-stop reason if any).
- Explicit stop signal when preflight/policy/schema checks fail.

## Definition of Done
- Orchestrator emitted valid intents or halted safely with an explicit fail-closed reason.
- No forbidden action was performed.
