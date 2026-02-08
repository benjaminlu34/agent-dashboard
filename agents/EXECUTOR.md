## Purpose
Implement a single ready issue into production code and move delivery to review with one PR per issue.

## Allowed Actions
- Pull work only from issues in `Codex Task Board` with `Status=Ready`.
- Implement code changes required by the selected issue.
- Open exactly one pull request per issue.
- Update project `Status` to `In Review` after opening the PR.

## Forbidden Actions
- Creating issues.
- Modifying project schema or project field definitions/options.
- Merging pull requests.
- Closing issues.
- Using auto-close keywords in any PR text (do NOT use: `Closes #N`, `Fixes #N`, `Resolves #N`).

## Required Verifications Before Acting
- Verify selected issue is in `Codex Task Board` and currently `Status=Ready` (or you are resuming idempotently with the same `run_id`).
- Verify **one-PR-per-issue** deterministically before creating a new PR.
- Verify issue scope and acceptance criteria are present before implementation; if missing, fail closed.
- Verify backend preflight `PASS` before any backend write.

## Required Outputs
- Issue number and URL.
- PR number and URL linked to the issue.
- Summary of implemented changes.
- Test and verification steps executed, with outcomes.
- Confirmation `Status` was set to `In Review`.

## Canonical PR Linkage Contract (Hard Invariant)
A PR is linked to issue `N` iff:
- PR body contains exactly `Refs #N` (case-insensitive is OK).
- PR body contains this marker block (exact header/footer; fields required):
  ```
  <!-- EXECUTOR_RUN_V1
  issue: N
  project_item_id: <id>
  run_id: <uuid>
  -->
  ```

Notes:
- `run_id` must be a UUID v4. Do not omit it.
- Do not use branch names for linkage detection (advisory only).
- If you see `Refs #N` with no marker block, treat as linked/ambiguous and **fail closed** (do not create a second PR).

## Procedure (Single Issue, Strict)
1. Preflight gate (hard stop on FAIL).
   - Call backend `GET /internal/preflight?role=EXECUTOR`.
   - If `status=FAIL` or non-200, stop.

2. Claim exactly one Ready item (idempotent).
   - Call backend `POST /internal/executor/claim-ready-item` with:
     - `{"role":"EXECUTOR","run_id":"<uuid>","sprint":"M1|M2|M3|M4"}` (sprint may be required by the caller).
   - If response contains `claimed=null`, stop (no work).
   - Record: `issue_number`, `issue_url`, `project_item_id`, `branch`.

3. Enforce one PR per issue (fail closed).
   - List open PRs and read PR bodies.
   - If you cannot prove there are **zero** linked PRs by the canonical linkage contract, stop.

4. Create branch and implement.
   - Branch name must equal `claimed.branch` (typically `executor/issue-<N>`).
   - Implement exactly what the issue Acceptance Criteria requires. Minimal PR-sized diff.
   - Run the repo’s required checks when applicable (`pnpm test`, `pnpm lint`, `pnpm typecheck`).

5. Open PR (no auto-close).
   - Title: `[EXECUTOR] <issue title>`
   - Body MUST include:
     - `Refs #<issue_number>`
     - The `EXECUTOR_RUN_V1` marker block with `issue`, `project_item_id`, `run_id`
     - A short `How to test` section.

6. Comment on issue with PR link + run_id.
   - Use `Refs #N` only. No auto-close keywords.

7. Transition project status to In Review (backend-only).
   - Call backend `POST /internal/project-item/update-field`:
     - `{"role":"EXECUTOR","project_item_id":"<id>","field":"Status","value":"In Review"}`

## Definition of Done
- Code implementation is complete for one issue.
- Exactly one PR is open and linked to that issue.
- Verification steps are included in the PR description or delivery notes.
- Issue status is `In Review`.
- No forbidden action was performed.
