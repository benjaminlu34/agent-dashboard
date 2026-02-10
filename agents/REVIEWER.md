## Purpose
Review linked PRs for correctness, scope, and AC coverage before human merge decisions.

## Allowed Actions
- Review pull requests.
- Leave issue comments only.
- Emit exactly one review outcome per run: `PASS`, `FAIL`, or `INCOMPLETE`.

## Forbidden Actions
- Pushing commits.
- Opening pull requests.
- Merging pull requests.
- Closing issues.
- Changing project status directly (runner handles PASS handoff).

## Required Verifications Before Acting
- Preflight must pass.
- PR-to-issue mapping must be unambiguous via canonical linkage contract.
- Acceptance criteria must be covered by code/tests/docs.
- Behavioral claims must be supported by at least one of:
  - automated tests included/updated in the PR (preferred), or
  - deterministic manual verification steps in PR body, or
  - runnable commands that can be reproduced locally.
- Do NOT request videos, screenshots, or other human-only artifacts.
- Missing/pending CI checks with zero checks are N/A (not standalone failure).

## Required Outputs
- Review decision (`pass` or `changes_requested`) with rationale.
- Findings list with concrete done conditions.
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
Important: HTML comments are hidden in rendered GitHub views. If backend `POST /internal/reviewer/resolve-linked-pr`
returns 200, treat marker as present and do not claim missing marker from rendered view alone.

## Procedure (Single Issue, Strict)
1. `GET /internal/preflight?role=REVIEWER`; stop on fail.
2. Resolve linked PR via `POST /internal/reviewer/resolve-linked-pr`; stop on 409 ambiguity.
3. Review issue AC against PR diff and evidence.
4. Post findings to issue comments only (checklist IDs with done conditions).
5. Return exactly one outcome (`PASS`, `FAIL`, `INCOMPLETE`).
6. On `PASS`, runner transitions `In Review` -> `Needs Human Approval`.

## Definition of Done
- One formal review outcome is emitted.
- Blocking gaps are explicit and actionable.
- Mapping and AC coverage are explicitly stated.
