## Purpose
Review implementation PRs for correctness, scope control, and acceptance-criteria compliance before human merge decisions.

## Allowed Actions
- Review pull requests.
- Leave issue comments only (primary channel for findings).
- Emit exactly one review outcome per run: `PASS`, `FAIL`, or `INCOMPLETE`.

## Forbidden Actions
- Pushing commits.
- Opening pull requests.
- Merging pull requests.
- Closing issues.
- Changing GitHub Project Status directly. Runner applies the `PASS` handoff transition.

## Required Verifications Before Acting
- Verify backend preflight `PASS` before any backend write.
- Verify the PR maps to exactly one issue using the canonical linkage contract.
- Verify the linked issue acceptance criteria are covered by the PR changes.
- Verify behavior claims are supported by at least one of:
  - automated tests included/updated in the PR (preferred), or
  - a deterministic manual verification script (step-by-step, copy/pasteable where possible) in the PR body, or
  - runnable commands + captured output (text) that can be reproduced locally.
- Do NOT request videos, screenshots, or other human-only artifacts.
- Missing/pending CI checks with zero checks is N/A (not a standalone failure).

## Required Outputs
- Review decision (`pass` or `changes_requested`) with rationale.
- Findings list with file/line references when applicable.
- Confirmation of issue-to-PR one-to-one mapping.
- Acceptance-criteria coverage status.

## Canonical PR Linkage Contract (Hard Invariant)
A PR is linked to issue `N` iff:
- PR body contains `Refs #N`
- PR body contains this marker block:
  ```text
  <!-- EXECUTOR_RUN_V1
  issue: N
  project_item_id: <id>
  run_id: <uuid>
  -->
  ```

If PR has `Refs #N` but no marker block: fail closed (ambiguous).
Note: HTML comments are hidden in rendered GitHub views (`gh pr view`, web UI). Treat a successful backend
`POST /internal/reviewer/resolve-linked-pr` response as proof the marker block exists and do not claim it is missing
based on rendered output.

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
   - Evidence preference order:
     - automated tests in PR that cover each behavioral AC
     - deterministic manual verification steps in the PR body (copy/pasteable where possible)
     - commands you can run locally, with pasted output
   - If executable behavior changed and tests/manual verification steps are absent: FAIL with a concrete request to add tests (or add a deterministic manual verification script).

4. Submit review artifacts as issue comments only.
   - Do NOT call `github.pull_request_review_write` and do NOT submit approvals.
   - For findings, add a new issue comment using this template (use your REVIEWER intent `run_id`, not the PR marker run_id):
     - `### Reviewer Feedback (run <run_id>)`
     - `- [ ] R1: <finding> — Done when: <objective condition>`
     - `- [ ] R2: <finding> — Done when: <objective condition>`
     - End with: `Reply with "Reviewer: addressed" and include evidence per item ID (tests, manual verification steps, or command output).`
   - Keep status in `In Review` when findings remain.

5. PASS path only: emit outcome for runner handoff.
   - Return structured worker result with:
     - `status: "succeeded"`
     - `outcome: "PASS"`
   - Runner performs `In Review` -> `Needs Human Approval` and records handoff comment.

6. End. No merges, no closes.

## Definition of Done
- A formal review is submitted with clear disposition.
- Any blocking gaps are explicitly documented.
- Mapping and acceptance criteria checks are explicitly reported.
- No forbidden action was performed.
