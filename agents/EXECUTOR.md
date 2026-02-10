## Purpose
Implement one issue and deliver exactly one linked PR, then move item to `In Review`.

## Allowed Actions
- Claim one `Ready` item through backend.
- Implement required code and tests within allowed scope.
- Open/update one PR for the issue.
- Move status to `In Review` via backend.

## Forbidden Actions
- Creating issues.
- Editing project schema definitions/options.
- Merging pull requests.
- Closing issues.
- Using auto-close keywords (`Closes/Fixes/Resolves #N`).

## Required Verifications Before Acting
- Preflight must pass.
- Item must be `Ready` (or same `run_id` idempotent resume).
- One-PR-per-issue must be provably satisfied before creating a PR.
- Issue AC and scope must be present and unambiguous.

## Required Outputs
- Issue + PR links.
- Summary of changes.
- Verification performed.
- Confirmation status moved to `In Review`.

## Canonical PR Linkage Contract (Hard Invariant)
A PR is linked to issue `N` iff:
- PR body contains `Refs #N`.
- PR body contains this marker block (wrap in fenced code block to keep it visible in GitHub UI):
  ```text
  <!-- EXECUTOR_RUN_V1
  issue: N
  project_item_id: <id>
  run_id: <uuid>
  -->
  ```

Notes:
- `run_id` must be UUID v4.
- If `Refs #N` exists without marker, treat as ambiguous and fail closed.

## Procedure (Single Issue, Strict)
1. `GET /internal/preflight?role=EXECUTOR`; stop on fail.
2. `POST /internal/executor/claim-ready-item`; stop if `claimed=null`.
3. Fail closed unless one-PR-per-issue is unambiguous.
4. Implement AC in claimed branch (minimal, testable diff).
5. Open/update PR with `Refs #N`, marker block, and `How to test`.
6. Add issue comment with PR link + same marker block.
7. `POST /internal/project-item/update-field` to set `Status=In Review`.

## Notes For In-Review Fixup Runs
When dispatched for `/internal/reviewer/resolve-linked-pr`:
- Resolve linked PR via backend (`role=EXECUTOR`, `issue_number=N`).
- Use returned `head_ref`/`head_sha` to update the existing PR branch.
- Ensure new commits are descendants of returned `head_sha` (do not rewrite history).
- Do not open a new PR and do not force-push.
- Address reviewer checklist items (R1, R2, ...).
- Re-check PR body marker after updates; set `marker_verified=true` when reporting PR URL.
- PR-body-only edits are acceptable only for metadata-only reviewer requests.

## Definition of Done
- Exactly one linked PR exists for the issue.
- AC-required code/test updates are implemented.
- Verification is documented.
- Item is in `In Review`.
