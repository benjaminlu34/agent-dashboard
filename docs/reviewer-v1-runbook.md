# Reviewer v1 Runbook (Single Issue)

This runbook defines a minimal Reviewer v1 workflow. Reviewer is comment-only for review artifacts; runner performs status handoff on reviewer `PASS`.

## Inputs

- Backend endpoints:
  - `GET /internal/preflight?role=REVIEWER`
  - `POST /internal/reviewer/resolve-linked-pr`
- MCP tools:
  - `github.issue_read`
  - `github.pull_request_read`
  - `github.add_issue_comment`

## Invariants

- Reviewer must not modify code.
- Reviewer does not change project status directly.
- Reviewer must not merge PRs or close issues.
- One PR per issue enforced with deterministic linkage.
- Fail closed on ambiguity.
- PASS review must emit reviewer outcome `PASS`; runner applies status handoff.
- Human change requests are routed by status transition, not reviewer status edits.

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

7. Emit merge-ready human signal (PASS path only).
   - Add PR comment via `github.add_issue_comment` on PR number:
     - Include `@<HUMAN> merge-ready`.
     - Include reviewed head SHA and short verification checklist.
  - Return worker outcome `PASS` in structured runner result.
  - Runner transitions `In Review` -> `Needs Human Approval` and records handoff comment.
   - Do not merge and do not close issue.

8. End.
   - No merge actions.
   - No issue close actions.

## Human Rework Request (Post-PASS)

If a human requests changes after an item is in `Needs Human Approval`:
- Human should move project status to `In Review` (not `Ready`).
- Include a clear rework reason in issue/PR comments.
- Orchestrator will dispatch `EXECUTOR` first to fix the existing linked PR branch.
- Reviewer runs again after executor response and returns `PASS`/`FAIL`/`INCOMPLETE`.

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
