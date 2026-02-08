# Reviewer v1 Runbook (Single Issue)

This runbook defines a minimal Reviewer v1 workflow. Reviewer is read/write for review artifacts and the `In Review` -> `Needs Human Approval` project handoff only.

## Inputs

- Backend endpoints:
  - `GET /internal/preflight?role=REVIEWER`
  - `POST /internal/reviewer/resolve-linked-pr`
  - `POST /internal/project-item/update-field`
- MCP tools:
  - `github.issue_read`
  - `github.pull_request_read`
  - `github.add_issue_comment`

## Invariants

- Reviewer must not modify code.
- Reviewer may only change GitHub Project Status for `In Review` -> `Needs Human Approval`.
- Reviewer must not merge PRs or close issues.
- One PR per issue enforced with deterministic linkage.
- Fail closed on ambiguity.
- PASS review must hand off by changing project status to `Needs Human Approval`.

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
   - If Acceptance Criteria is missing/unparseable, fail closed and submit a blocking feedback issue comment.

4. Read PR details and diff.
   - Use `github.pull_request_read(method=get)` for metadata/head SHA/body.
   - Use `github.pull_request_read(method=get_files)` and/or `method=get_diff`.
   - Require PR state is open and non-draft for merge-ready decision.

5. Evaluate each criterion.
   - For each Acceptance Criterion, assign `PASS` or `FAIL`.
   - Include concrete evidence from changed files, behavior, or tests.
   - If evidence is missing, mark as `FAIL`.

6. Submit review outcome as issue comments only.
   - If any criterion is `FAIL`:
     - Use `github.add_issue_comment` on the linked issue with this structure:
       - `### Reviewer Feedback (run <run_id>)`
       - Checklist items with stable IDs: `R1`, `R2`, ...
       - Each item must include a clear done condition.
       - End with: `Reply with "Reviewer: addressed" and include evidence per item ID.`
     - Keep project status unchanged (`In Review`).
   - If all criteria are `PASS`:
     - Do not submit any PR approval.
     - Continue to handoff step.

7. Emit merge-ready human signal and handoff (PASS path only).
   - Add PR comment via `github.add_issue_comment` on PR number:
     - Include `@<HUMAN> merge-ready`.
     - Include reviewed head SHA and short verification checklist.
   - Call backend `POST /internal/project-item/update-field` with:
     - `role=REVIEWER`
     - `project_item_id=<project_item_id>`
     - `field=Status`
     - `value=Needs Human Approval`
     - `issue_number=<issue_number>`
     - `pr_url=<pr_url>`
     - `checks_performed=<list of checks executed>`
     - `checks_passed=<list of checks that passed>`
     - `human_steps=<list, e.g. approve/merge PR and verify deployment>`
   - This call records the human handoff comment on the issue.
   - Do not merge and do not close issue.

8. End.
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
- Review outcome: PASS | CHANGES_REQUESTED
- Criteria summary:
  - [PASS|FAIL] <criterion> — <evidence>
```

## Comment Templates

### Changes Requested

```md
### Reviewer Feedback (run <run_id>)

Blocking findings:
- [ ] R1: <criterion> — Done when: <objective condition>
- [ ] R2: <criterion> — Done when: <objective condition>

Reply with "Reviewer: addressed" and include evidence per item ID.
```

### Human Handoff

```md
Reviewer v1 outcome: PASS

@<HUMAN> merge-ready

Verified:
- Acceptance Criteria satisfied
- Required files reviewed
- Tests/evidence checked

Reviewed head SHA: <sha>
Linked issue: #<issue_number>
```
