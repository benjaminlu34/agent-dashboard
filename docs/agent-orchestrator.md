## 1. Purpose
Define how the orchestrator runs role-scoped agents by wrapping the base prompt with role and policy context, so behavior is deterministic, auditable, and governance-compliant.

## 2. Inputs (role, user request, repo state)
- `role`: explicit role token selected by the caller (for example: Orchestrator, Executor, Reviewer).
- `user request`: the current instruction payload to execute.
- `repo state`: working tree status, current branch, and required governance files available in-repo.

## 3. Context bundle composition
The orchestrator must assemble a fixed context bundle before execution:
- `AGENTS.md` as global governance and operating contract.
- `agents/<ROLE>.md` as the role overlay for allowed/forbidden actions and required outputs.
- `policy/*.json` as machine-readable enforcement inputs for schema, transitions, and permissions.

## 4. Role selection (explicit, never inferred)
- Role is caller-provided and must be validated against existing role files.
- The orchestrator must never infer role from task text.
- If role is missing, ambiguous, or unsupported, execution must stop and report validation failure.

## 5. Tool gating driven by policy/role-permissions.json
- Tool/action permissions are derived from `policy/role-permissions.json` for the active role.
- The orchestrator must deny disallowed actions before tool invocation, not after.
- Role overlays in `agents/*.md` may add stricter constraints; they must never loosen policy constraints.

## 6. Mandatory preflight checks
Execution must not start until both checks pass:
- Issue template exists and is unchanged:
  - Required path: `.github/ISSUE_TEMPLATE/milestone-task.yml` in the resolved target repo/ref.
  - Missing file or contract drift is a hard stop.
- Project schema matches `policy/project-schema.json`:
  - Required project and required field options must match exactly.
  - Any mismatch is a hard stop and must be reported.

## 7. What must be logged for each agent run (inputs, outputs, metadata, tool calls)
- Inputs: role, request payload, selected repository, branch/commit context.
- Context snapshot: versions or hashes of `AGENTS.md`, role prompt, and policy files used.
- Outputs: final response payload and any structured artifacts produced.
- Metadata: model identifier, latency, cost/accounting fields (if available), run start/end timestamps, run outcome.
- Tool calls: ordered list of tools invoked, parameters, results, errors, and blocked actions due to policy gating.
