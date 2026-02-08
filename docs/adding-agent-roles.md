# Adding Agent Roles

## 1) Overview
This document defines the required process for adding a new AI agent role to this repository architecture (bundle loader, preflight, policy gating, and runner endpoints).

This process MUST be followed for both human and Codex-driven implementation.

Execution sequence:
1. Validate prerequisites and governance contracts.
2. Classify the role as Draft-only or Mutating.
3. Add a restrictive role overlay in `agents/<ROLE>.md`.
4. Add or update policy entries in `policy/*.json`.
5. Wire endpoint(s) under `apps/api` internal routes.
6. Add enforcement hooks before tool or state operations.
7. Add PASS/FAIL tests with temp repo fixtures.
8. Apply logging and cost controls.
9. Roll out in dry-run, then limited scope, with human review gates.

## 2) Preconditions (what must already exist)
Before adding a role, all of the following MUST be true:

- `AGENTS.md` exists and defines global governance constraints.
- `agents/` exists and is used for role overlays.
- `policy/` exists and includes role permission and transition policy files.
- Internal API runner routing exists under `apps/api` with `internal-*` route conventions.
- `.github/ISSUE_TEMPLATE/milestone-task.yml` exists and matches expected contract.
- GitHub Project identity policy for `Codex Task Board` exists and is valid.
- Project schema fields/options match required governance definitions.

Verification checkpoint:
- Run a preflight check that validates file presence, required policy keys, and project schema contract.
- If any prerequisite is missing or invalid, implementation MUST stop.

## STOP CONDITIONS
Automation MUST stop immediately and report when any of the following occurs:

- Missing or changed issue template contract (`.github/ISSUE_TEMPLATE/milestone-task.yml`).
- Missing or invalid GitHub-project identity policy.
- Project schema mismatch (required fields/options differ).
- Role not explicitly specified in request or endpoint payload.
- Attempt to perform a disallowed action per role policy.

## 3) Decide the role type (Draft-only vs Mutating)
Role type MUST be decided before writing any code.

Draft-only roles:
- `ARCHITECT`
- `SECURITY_SENTRY`
- `REVIEWER` (comment-only)

Mutating roles:
- `TEST_ENGINEER`
- `REFACTORER`

Rules:
- Draft-only roles MUST NOT perform writes to code, project state, or issue state.
- Draft-only roles MUST be served exclusively by endpoints that do not import GitHub write clients.
- Draft-only roles MUST be served exclusively by endpoints that do not import filesystem write utilities.
- Draft-only role endpoints MUST return structured draft output only.
- Mutating roles SHOULD start with minimal write scopes and explicit transition limits.
- Mutating roles MUST use endpoints that explicitly enumerate allowed side effects.
- Role type selection MUST drive endpoint behavior, policy entries, and test cases.

Verification checkpoint:
- Confirm a single authoritative role type flag exists in policy and is enforced in runtime checks.
- Confirm draft-only endpoint modules are auditable via import review (for example, grep for write-capable clients/utilities).

## 4) Add the role overlay (agents/<ROLE>.md)
Role overlays MUST use uppercase token naming (for example, `agents/ARCHITECT.md`).

Rules:
- Overlays can restrict permissions, never expand them.
- Overlay instructions MUST be consistent with global governance in `AGENTS.md`.
- Overlay MUST state write permissions explicitly.

Example: `agents/ARCHITECT.md`
```md
# ARCHITECT Overlay

## Mission
Produce implementation plans, architecture decisions, and risk analysis.

## Constraints
- MUST operate in draft-only mode.
- MUST NOT edit files.
- MUST NOT change issue/project status.
- MUST output structured JSON only when requested by endpoint contract.

## Allowed actions
- Read repository files.
- Analyze policy and routing structure.
- Propose patch plans and test plans.
```

Verification checkpoint:
- Validate role token is uppercase and matches the policy key exactly.
- Confirm overlay adds restrictions only.

## 5) Update policy (policy/role-permissions.json and policy/transitions.json if needed)
Policy updates MUST follow least privilege and default deny.

Rules:
- Every new role MUST have an explicit entry in `policy/role-permissions.json`.
- Any unspecified action MUST be denied by default.
- `policy/transitions.json` MUST be updated when the role can mutate status/state.
- Draft-only roles MUST have write and mutation actions set to `false`.

Example: `policy/role-permissions.json` entry for a no-write role
```json
{
  "ARCHITECT": {
    "mode": "draft_only",
    "can_read_repo": true,
    "can_invoke_write_tools": false,
    "can_update_issue_state": false,
    "can_update_project_fields": false,
    "allowed_endpoints": ["/internal/architect-draft"]
  }
}
```

Verification checkpoint:
- Unit-check policy loader with the new role.
- Assert denied-by-default behavior for unknown actions.

Role capability matrix (reference model; policy remains source of truth):

| Role | Draft-only | Writes Code | Writes GitHub | Comments | Status Transitions |
| --- | --- | --- | --- | --- | --- |
| ARCHITECT | ✅ | ❌ | ❌ | ❌ | ❌ |
| SECURITY_SENTRY | ✅ | ❌ | ❌ | ✅ | ❌ |
| ORCHESTRATOR | ❌ | ❌ | ✅ | ✅ | Backlog -> Ready |
| EXECUTOR | ❌ | ✅ | ✅ | ✅ | Ready -> In Review |
| REVIEWER | ❌ | ❌ | ✅ | ✅ | In Review -> Needs Human Approval |

## 6) Wire runner endpoint(s)
You MUST choose one of:
- Dedicated endpoint per role (for example, `POST /internal/architect-draft`), or
- Generic agent-run endpoint with explicit role parameter.

Rules:
- Role MUST be explicitly provided and validated; role MUST NOT be inferred.
- Preflight MUST PASS before any model call that could lead to writes.
- Draft-only endpoint handlers MUST enforce non-mutating mode.

Example endpoint contract template:
```http
POST /internal/architect-draft
Content-Type: application/json

{
  "role": "ARCHITECT",
  "repo": {
    "owner": "<owner>",
    "name": "<repo>",
    "ref": "<branch-or-sha>"
  },
  "task": {
    "id": "<issue-or-task-id>",
    "prompt": "<draft request>"
  },
  "limits": {
    "max_input_tokens": 12000,
    "max_output_tokens": 1500
  },
  "output_mode": "draft_json"
}
```

Example minimal response schema for draft-only outputs:
```json
{
  "type": "object",
  "required": ["role", "mode", "result", "bundle_hash"],
  "properties": {
    "role": { "type": "string", "const": "ARCHITECT" },
    "mode": { "type": "string", "const": "draft_only" },
    "bundle_hash": { "type": "string" },
    "result": {
      "type": "object",
      "required": ["summary", "proposed_steps", "risks"],
      "properties": {
        "summary": { "type": "string" },
        "proposed_steps": { "type": "array", "items": { "type": "string" } },
        "risks": { "type": "array", "items": { "type": "string" } }
      }
    }
  },
  "additionalProperties": false
}
```

Verification checkpoint:
- Endpoint rejects missing/unknown role.
- Endpoint rejects any write-capable path for draft-only roles.

## 7) Implement enforcement hooks
Enforcement MUST happen before side effects.

Rules:
- Permissions MUST be checked BEFORE any tool invocation.
- Transitions MUST be checked BEFORE any status mutation.
- Fail-closed behavior MUST be used for policy read errors or unknown role/action.

Recommended order:
1. Load and validate bundle + policy.
2. Validate role and endpoint binding.
3. Check preflight status.
4. Check permission for requested action/tool.
5. Execute action.
6. Check transition policy before state/status updates.

Verification checkpoint:
- Add tests that prove blocked operations fail before any tool/state mutation call site.

## 8) Add tests
Each new role endpoint MUST include at least one PASS and one FAIL test.

Required coverage:
- Temp repo fixtures for bundle loading/preflight context.
- PASS case: valid role, valid policy, valid preflight, valid output contract.
- FAIL case: disallowed action, invalid role, or preflight failure.

Suggested minimum tests:
1. `POST` endpoint returns draft output for valid draft-only role.
2. `POST` endpoint returns 4xx/5xx and no side effects when write action is attempted by draft-only role.

Verification checkpoint:
- Test assertions MUST include “no write side effect” on FAIL paths.

## 9) Logging & cost controls
New role execution MUST include deterministic metadata and budget controls.

Rules:
- Logs MUST include `bundle_hash` for reproducibility.
- Requests MUST enforce token caps (input/output).
- Draft endpoints SHOULD enforce JSON-only outputs.
- Logs SHOULD capture model, latency, estimated/actual token usage, and tool calls.

Verification checkpoint:
- Confirm logs include `role`, `bundle_hash`, token caps, and execution outcome.

## 10) Rollout checklist
Use this order for first deployment of each role:

1. Dry-run mode only (no writes).
2. Limited scope first run (single repo/task scope).
3. Human review gate on outputs and any proposed mutations.
4. Promote to broader scope only after PASS/FAIL telemetry is stable.

Verification checkpoint:
- Human reviewer signs off before enabling broader or mutating usage.

## 11) Appendix: Recommended starter roles and safe defaults
Recommended defaults:

- `ARCHITECT`: draft-only.
- `SECURITY_SENTRY`: draft-only.
- `TEST_ENGINEER`: optional write, enable only with strict transition policy.
- `DOCSTRING_SCRIBE`: optional write, default to file-scoped changes only.
- `PERF_TUNER`: draft-only initially.
- `REFACTORER`: enable only after strong tests and rollback safety are proven.

Safe default policy pattern:
- Start every new role as draft-only.
- Require explicit policy change + tests to enable writes.
- Keep transition permissions narrower than tool permissions.

## 12) Anti-patterns (Do Not Implement)

- A single agent performing planning + execution + review in one role.
- Role inference from natural language instead of explicit role parameter.
- Draft-only roles calling endpoints that import write-capable clients.
- Retry logic that can repeat GitHub writes after partial failure without idempotency control.
- Allowing agents to auto-fix preflight failures instead of stopping and reporting.
