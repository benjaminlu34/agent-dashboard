# Executor v1 Runbook (Single Issue)

This runbook defines a minimal Executor v1 workflow for one issue at a time.

## Inputs

- Backend endpoints:
  - `GET /internal/preflight?role=EXECUTOR`
  - `POST /internal/executor/claim-ready-item`
  - `POST /internal/project-item/update-field`
- MCP tools:
  - `github.issue_read`
  - `github.list_pull_requests`
  - `github.pull_request_read`
  - `github.create_branch`
  - `github.push_files`
  - `github.create_pull_request`
  - `github.add_issue_comment`

## Invariants

- Never use `Closes/Fixes/Resolves #N`; use `Refs #N` only.
- Exactly one PR per issue.
- Status transitions only through backend `POST /internal/project-item/update-field`.
- Fail closed on ambiguity.
- Executor never merges PRs and never closes issues.

## Procedure

1. Preflight gate.
   - Call backend `GET /internal/preflight?role=EXECUTOR`.
   - If response status is `FAIL`, stop.

2. Generate `run_id`.
   - Generate UUID v4 for this run.

3. Claim one Ready item.
   - Call backend `POST /internal/executor/claim-ready-item` with:
     - `{ "role": "EXECUTOR", "run_id": "<uuid>", "sprint": "<optional>" }`
   - If response has `claimed: null`, stop (no work).
   - Otherwise record:
     - `issue_number`
     - `issue_url`
     - `project_item_id`
     - `branch` (must be `executor/issue-<N>`)

4. Enforce one-PR-per-issue before any branch/PR create.
   - Use `github.list_pull_requests` with `state=all`.
   - For each candidate PR, read body (from list payload; use `github.pull_request_read(get)` if body missing/truncated).
   - Determine linked PRs by:
     - If PR body contains `Refs #<issue_number>`:
       - If it contains `<!-- EXECUTOR_RUN_V1 ... -->` marker:
         - Parse marker and require:
           - `issue: <issue_number>`
           - `project_item_id` equals claimed `project_item_id`
       - If marker is missing: treat as linked with reason `unmarked_refs`
   - If linked PR count > 1, stop (ambiguous).
   - If linked PR count == 1, stop, or reuse only if marker matches claimed `project_item_id` and marker `run_id` matches current run `run_id`.
   - If linked PR count == 0, continue.

4.5. Rerun behavior.
   - If an existing linked PR is found:
     - If marker matches claimed `project_item_id`, do not create a new PR; proceed directly to Step 9.
     - Else stop and report ambiguity.

5. Create branch.
   - Use `github.create_branch` with the exact claimed branch name.
   - Branch must equal `claimed.branch`.

6. Implement issue changes.
   - Read issue via `github.issue_read(method=get)`.
   - Follow issue acceptance criteria.
   - Make minimal PR-sized changes only.
   - Use `github.push_files` to commit to claimed branch.

7. Open PR.
   - Use `github.create_pull_request`:
     - Title: `[EXECUTOR] <issue title>`
     - Head: claimed branch
     - Base: default branch (or repository policy base)
   - PR body must include:
     - `Refs #<issue_number>`
     - Marker block:
       - `<!-- EXECUTOR_RUN_V1`
       - `issue: <issue_number>`
       - `project_item_id: <project_item_id>`
       - `run_id: <run_id>`
       - `-->`
     - Short `How to test` section.
   - Reject/stop if body contains any auto-close keyword targeting the issue.

8. Comment on issue.
   - Use `github.add_issue_comment` on issue number with:
     - PR URL
     - `run_id`
     - branch name

9. Move project status to In Review.
   - Call backend `POST /internal/project-item/update-field` with:
     - `{ "role": "EXECUTOR", "project_item_id": "<id>", "field": "Status", "value": "In Review" }`
   - If backend returns `403`/`409`, stop and report.

10. Return run result.
   - Report:
     - issue number + URL
     - branch name
     - PR number + URL
     - status transition response payload

## Stop Conditions

- Preflight `FAIL` or backend `409`.
- Backend policy denial (`403`).
- Cannot prove PR linkage count is exactly 0 or 1 deterministically.
- PR linkage ambiguous (`>1` matches for `Refs #N`).
- Existing linked PR present with matching marker: reuse path only (skip new branch/PR creation, proceed to Step 9).
- Existing linked PR with mismatched marker: stop as ambiguous.
- Any failure during branch creation, commit/push, PR creation, or status update.

## PR Body Template

```md
Refs #<issue_number>

<!-- EXECUTOR_RUN_V1
issue: <issue_number>
project_item_id: <project_item_id>
run_id: <run_id>
-->

## How to test
- <step 1>
- <step 2>
```

## Output Template

```md
- Issue: #<issue_number> <issue_url>
- Branch: <branch>
- PR: #<pr_number> <pr_url>
- Status update: <backend response JSON>
```
