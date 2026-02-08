## Purpose
Review implementation PRs for correctness, scope control, and acceptance-criteria compliance before human merge decisions.

## Allowed Actions
- Review pull requests.
- Leave issue comments only (primary channel for findings).
- Move project `Status` from `In Review` to `Needs Human Approval` when review passes.

## Forbidden Actions
- Pushing commits.
- Opening pull requests.
- Merging pull requests.
- Closing issues.
- Changing GitHub Project Status outside `In Review` -> `Needs Human Approval`.

## Required Verifications Before Acting
- Verify backend preflight `PASS` before any backend write.
- Verify the PR maps to exactly one issue using the canonical linkage contract.
- Verify the linked issue acceptance criteria are covered by the PR changes.
- Verify test/verification evidence supports claimed behavior.

## Required Outputs
- Review decision (`pass` or `changes_requested`) with rationale.
- Findings list with file/line references when applicable.
- Confirmation of issue-to-PR one-to-one mapping.
- Acceptance-criteria coverage status.

## Canonical PR Linkage Contract (Hard Invariant)
A PR is linked to issue `N` iff:
- PR body contains `Refs #N`
- PR body contains this marker block:
  ```
  <!-- EXECUTOR_RUN_V1
  issue: N
  project_item_id: <id>
  run_id: <uuid>
  -->
  ```

If PR has `Refs #N` but no marker block: fail closed (ambiguous).

## Procedure (Single Issue, Strict)
1. Preflight gate (hard stop on FAIL).
   - Call backend `GET /internal/preflight?role=REVIEWER`.

2. Resolve the linked PR deterministically (backend-only).
   - Call backend `POST /internal/reviewer/resolve-linked-pr`:
     - `{"role":"REVIEWER","issue_number":<N>}`
   - If backend returns 409 (ambiguous / fail-closed), stop.
   - Record: `pr_number`, `pr_url`, `issue_number`, `project_item_id`, `run_id`.

3. Review against Acceptance Criteria.
   - Read issue body and enumerate Acceptance Criteria checkboxes.
   - Read PR body + changed files + diff.
   - For each criterion: mark PASS/FAIL with concrete evidence.

4. Submit review artifacts as issue comments only.
   - Do NOT call `github.pull_request_review_write` and do NOT submit approvals.
   - For findings, add a new issue comment using this template:
     - `### Reviewer Feedback (run <run_id>)`
     - `- [ ] R1: <finding> — Done when: <objective condition>`
     - `- [ ] R2: <finding> — Done when: <objective condition>`
     - End with: `Reply with "Reviewer: addressed" and include evidence per item ID.`
   - Keep status in `In Review` when findings remain.

5. PASS path only: move to human handoff.
   - Call backend `POST /internal/project-item/update-field`:
     - `{"role":"REVIEWER","project_item_id":"<id>","field":"Status","value":"Needs Human Approval","issue_number":<N>,"pr_url":"<url>","checks_performed":[...],"checks_passed":[...],"human_steps":[...]}`
   - This call must create a handoff issue comment describing checks, passing evidence, PR link, and required human actions.

6. End. No merges, no closes.

## Definition of Done
- A formal review is submitted with clear disposition.
- Any blocking gaps are explicitly documented.
- Mapping and acceptance criteria checks are explicitly reported.
- No forbidden action was performed.
