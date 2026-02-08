# Reviewer v1 Runbook (Single Issue)

This runbook defines a minimal Reviewer v1 workflow. Reviewer is read/write for review artifacts only (reviews/comments), and never mutates project status or repository code.

## Inputs

- Backend endpoints:
  - `GET /internal/preflight?role=REVIEWER`
  - `POST /internal/reviewer/resolve-linked-pr`
- MCP tools:
  - `github.issue_read`
  - `github.pull_request_read`
  - `github.pull_request_review_write`
  - `github.add_issue_comment`

## Invariants

- Reviewer must not modify code.
- Reviewer must not change GitHub Project Status.
- Reviewer must not merge PRs or close issues.
- One PR per issue enforced with deterministic linkage.
- Fail closed on ambiguity.
- Reviewer feedback does not change project status.

## Procedure

1. Preflight gate.
   - Call backend `GET /internal/preflight?role=REVIEWER`.
   - If status is `FAIL`, stop.

2. Resolve linked PR deterministically.
   - Call backend `POST /internal/reviewer/resolve-linked-pr` with:
     - `{ "role": "REVIEWER", "issue_number": <N> }`
   - If backend returns `409`, stop.
   - Record:
     - `pr_number`
     - `pr_url`
     - `issue_number`
     - `project_item_id`
     - `run_id`

3. Read issue and parse Acceptance Criteria.
   - Use `github.issue_read(method=get)` for the issue.
   - Extract Acceptance Criteria checklist items.
   - If Acceptance Criteria is missing/unparseable, fail closed and submit `REQUEST_CHANGES` with explicit reason.

4. Read PR details and diff.
   - Use `github.pull_request_read(method=get)` for metadata/head SHA/body.
   - Use `github.pull_request_read(method=get_files)` and/or `method=get_diff`.
   - Require PR state is open and non-draft for merge-ready decision.

5. Evaluate each criterion.
   - For each Acceptance Criterion, assign `PASS` or `FAIL`.
   - Include concrete evidence from changed files, behavior, or tests.
   - If evidence is missing, mark as `FAIL`.

6. Submit review outcome.
   - If any criterion is `FAIL`:
     - Use `github.pull_request_review_write(method=create, event=REQUEST_CHANGES)`.
     - Include actionable, specific remediation points.
   - If all criteria are `PASS`:
     - Use `github.pull_request_review_write(method=create, event=APPROVE)`.

7. Emit merge-ready human signal (PASS path only).
   - Add PR comment via `github.add_issue_comment` on PR number:
     - Include `@<HUMAN> merge-ready`.
     - Include reviewed head SHA and short verification checklist.
   - Do not merge and do not close issue.

8. End.
   - No status updates.
   - No merge actions.
   - No issue close actions.

## Stop Conditions

- Preflight `FAIL`.
- Linked PR cannot be resolved uniquely.
- Unmarked `Refs #N` PR (ambiguous for Reviewer v1).
- Multiple linked PRs for same issue.
- Mismatch between issue and marker.
- PR not open or repository state cannot be evaluated deterministically.

## Output Template

```md
- Issue: #<issue_number>
- PR: #<pr_number> <pr_url>
- Head SHA: <sha>
- Review outcome: APPROVE | REQUEST_CHANGES
- Criteria summary:
  - [PASS|FAIL] <criterion> — <evidence>
```

## Comment Templates

### Request Changes

```md
Reviewer v1 outcome: REQUEST_CHANGES

Blocking findings:
- <criterion>: missing/incorrect <evidence>
- <criterion>: expected <x>, found <y>

Please update the PR and request re-review.
```

### Merge Ready

```md
Reviewer v1 outcome: APPROVE

@<HUMAN> merge-ready

Verified:
- Acceptance Criteria satisfied
- Required files reviewed
- Tests/evidence checked

Reviewed head SHA: <sha>
Linked issue: #<issue_number>
```
