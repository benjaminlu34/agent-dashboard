# Infra Repo Direction (Phase 2)

## Candidate Models

### Model 1: Infra-owned policy/overlays
- Infra repo stores `AGENTS.md`, `agents/*.md`, `policy/*.json`.
- Target repo is only work/code + GitHub project/issue data.
- Preflight must validate template from target repo on GitHub (not local infra filesystem).

Tradeoffs:
- Strong central governance.
- Simpler rollout across multiple targets.
- Higher blast radius if infra policy changes are wrong.

### Model 2: Target-owned policy/overlays
- Each target repo stores governance and policy files.
- Infra repo is only a thin runner.
- Preflight remains local to target checkout.

Tradeoffs:
- Strong per-repo autonomy.
- Lower central blast radius.
- Drift risk across targets.

### Model 3: Hybrid (recommended)
- Infra repo is the canonical runner/orchestrator.
- Policy can be centrally versioned, but target repos can pin/override via explicit versioning rules.
- Preflight validates target project schema from GitHub and target issue template from GitHub for the active repository.

Tradeoffs:
- Best balance of control and adoption speed.
- Requires explicit compatibility/version contract.
- Slightly more implementation complexity.

## Recommendation
Adopt Model 3.

Reason:
- It preserves a reusable infra runner while avoiding false confidence from validating a local infra template that does not represent the active target repo.
- It supports gradual migration from single-repo to multi-target without changing worker contracts.

## Template Validation Decision
For infra-repo operation, validate the issue template against the **target repo on GitHub**.

- Local infra file validation is insufficient once infra and target repos are different.
- Optional/disabled template validation is unsafe and violates fail-closed governance.

## Minimal Safe Step Implemented in Phase 3
- No backend endpoint changes were introduced.
- Orchestrator loop remains policy-gated through `/internal/preflight`.
- Target identity now supports deterministic env overrides (`TARGET_*`) with policy fallback.
- Preflight template validation reads target repo template metadata from GitHub and fails closed on missing/transient-exhausted conditions.

## Deferred Work
- Add a target-repo template reader to preflight (GitHub Contents API), defaulting to current local mode for backward compatibility.
- Add explicit `target_repository` contract in project identity/policy for multi-target runs.
