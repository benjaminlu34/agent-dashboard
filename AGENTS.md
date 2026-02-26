## Repo Scope
- DO NOT treat this repository as the product application repo; it is control-plane infrastructure for agent orchestration.
- DO NOT add product features to `apps/web`; it is scaffold-only in this repo.
- DO NOT assume per-app `package.json` scripts are authoritative; use root scripts in `/package.json` for actual dev/test entrypoints.

## Architecture Coupling
- DO NOT split `apps/orchestrator` away from `apps/api/src/internal/*` without replacing every shared import; this coupling is intentional.
- DO NOT duplicate policy/identity/linkage logic in multiple apps; reuse existing internal modules.
- DO NOT let orchestrator or runner write GitHub project fields directly; all status/field writes must go through backend routes.

## Bundle And Policy Contracts
- DO NOT change agent-context bundle file order: `AGENTS.md`, `agents/<ROLE>.md`, `policy/github-project.json`, `policy/project-schema.json`, `policy/transitions.json`, `policy/role-permissions.json`.
- DO NOT summarize or transform policy JSON before injection; policy files are consumed verbatim and must remain valid JSON.
- DO NOT add a new runtime role without updating all role sources: `agents/*.md`, `policy/role-permissions.json`, `policy/transitions.json`, and role-loading code paths.
- DO NOT assume role keys are case-sensitive in behavior; enforcement normalizes role names.

## Target Identity Rules
- DO NOT partially set `TARGET_*` identity vars; setting any required var enables env-override mode and requires all required vars.
- DO NOT bypass `resolveTargetIdentity()` with ad hoc env/policy reads.
- DO NOT remove fallback-to-policy behavior when no env override is present.

## API Route Invariants
- DO NOT add mutating backend routes that skip `/internal/preflight` gating.
- DO NOT bypass schema option validation in `/internal/project-item/update-field`; field/value must be validated against `policy/project-schema.json`.
- DO NOT remove transition checks before status writes; transitions must be policy-gated first.
- DO NOT remove required metadata gates for handoff transitions (`In Review -> Needs Human Approval`, `Needs Human Approval -> In Review`, `In Progress/In Review -> Blocked`, `Blocked -> Ready`).
- DO NOT remove atomic claim handling in `/internal/executor/claim-ready-item`; claim locking is required to prevent dual claims.
- DO NOT remove claim lease expiration behavior; stale `EXECUTOR_CLAIM_V1` markers are intentionally ignored after TTL.
- DO NOT remove winner-rule semantics for dual claims; earliest claim comment ID wins.
- DO NOT "fix" `/internal/run` to live schema reads without an explicit migration plan; it intentionally uses local policy snapshot for runner v0 compatibility.

## PR Linkage Contracts
- DO NOT use auto-close keywords (`Closes/Fixes/Resolves #N`) for task linkage; use `Refs #N` only.
- DO NOT treat `Refs #N` without valid `EXECUTOR_RUN_V1` marker as unambiguous linkage.
- DO NOT accept marker-only linkage without matching `Refs #N`.
- DO NOT relax marker validation (`issue`, `project_item_id`, `run_id` with UUID v4 semantics).
- DO NOT remove canonical marker tokens used across resolver, runner, and tests.

## Orchestrator Contracts
- DO NOT change `RUN_INTENT` structure emitted by orchestrator without coordinated runner changes.
- DO NOT remove dispatch dedupe semantics for unchanged status epochs.
- DO NOT mark sprint complete while `Backlog` items remain; completion requires no active items and no backlog.
- DO NOT remove corrupted-state recovery; invalid orchestrator state JSON must be rotated to `*.corrupt-<timestamp>` and reset.
- DO NOT remove same-epoch merge of runner-managed fields in `mergeRunnerManagedStateFields()`.
- DO NOT assume label-based dispatch filtering; dispatch is status-driven and current item adapter does not include labels.
- DO NOT remove `ORCHESTRATOR_ITEMS_FILE` fixture mode; tests rely on it for deterministic CLI behavior.

## Runner Contracts
- DO NOT relax intent parsing strictness in `apps/runner/intents.py`; unknown fields and role/run_id mismatches must fail closed.
- DO NOT widen per-role endpoint allowlists without policy and contract updates.
- DO NOT change worker sandbox mapping: `EXECUTOR` is `workspace-write`, `REVIEWER` is `read-only`.
- DO NOT replace MCP stdio JSON-RPC flow with ad hoc protocols; runner is contractually MCP-based.
- DO NOT remove required Codex MCP server checks for `github` and `github_projects`.
- DO NOT accept reviewer results without explicit `outcome` (`PASS|FAIL|INCOMPLETE`).
- DO NOT accept executor outputs with PR URLs unless `marker_verified=true`.
- DO NOT remove per-issue in-flight serialization; executor/reviewer work on same issue must not run concurrently.
- DO NOT remove watchdog and recovery transitions that move stale/failing executor runs to `Blocked`.

## Scope, Sanitization, And Promotion
- DO NOT remove `## Scope` section generation from `/internal/plan-apply` issue bodies.
- DO NOT autopromote Backlog items without dependency sanitization.
- DO NOT keep prunable dependency edges (`DEAD_REF`, `DOC_BLOCKER`, `NO_OVERLAP`).
- DO NOT treat `Needs Human Approval` as satisfying `depends_on` completion; only `Done` unblocks chained dependents.
- DO NOT remove deterministic cycle handling/regeneration tiers.
- DO NOT change regen handoff artifact path; unresolved cycles must write `{ORCHESTRATOR_STATE_PATH}.regen-request.json`.
- DO NOT change regen-related exit-code semantics (`5` exhausted, `6` handoff requested) without updating all callers/tests.

## Kickoff Contracts
- DO NOT loosen kickoff plan schema validation (`goal_issue`, `tasks`, `ready_set_titles`, rationale).
- DO NOT allow kickoff markdown bodies to omit required headings (`Goal`, `Non-goals`, `Acceptance Criteria`, `Files Likely Touched`, `Definition of Done`).
- DO NOT allow kickoff tasks to start outside `Backlog`.
- DO NOT allow kickoff auto-close keywords anywhere in generated content.
- DO NOT bypass area mapping guard (`map_task_area_to_policy_area`) that constrains kickoff task areas to policy areas.
- DO NOT skip writing `.runner-sprint-plan.json` after successful kickoff apply.

## Test-Coupled Landmines
- DO NOT change marker parsing behavior in one place only; `executor-pr-linkage`, `reviewer-pr-linkage`, and their tests must stay aligned.
- DO NOT change runner result/intent schema without updating Python tests (`test_intents.py`, `test_codex_worker_prompt.py`, `test_runner_review_and_stall.py`).
- DO NOT change orchestrator state field semantics without updating state-merge and CLI tests (`orchestrator-cli.test.js`, `test_runner_state_resolution.py`).

## Policy & Schema Enforcement
- DO NOT hallucinate or assume valid values for `Status`, `Size`, `Area`, `Priority`, or `Sprint`; ALWAYS read the exact valid enums directly from `policy/project-schema.json`.
- DO NOT use GitHub Milestones for timeboxing; use the custom `Sprint` field exclusively.
- DO NOT allow role overlays in `agents/*.md` to grant new permissions; they must ONLY add restrictions to the base role.
- DO NOT attempt to guess or infer intent on ambiguity; you must explicitly fail closed on any policy, schema, or template mismatch.