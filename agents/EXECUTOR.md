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

## Required Verifications Before Acting
- Verify selected issue is in `Codex Task Board` and currently `Status=Ready`.
- Verify no existing active PR already fulfills the same issue (enforce one PR per issue).
- Verify issue scope and acceptance criteria are present before implementation.

## Required Outputs
- Issue number and URL.
- PR number and URL linked to the issue.
- Summary of implemented changes.
- Test and verification steps executed, with outcomes.
- Confirmation `Status` was set to `In Review`.

## Definition of Done
- Code implementation is complete for one issue.
- Exactly one PR is open and linked to that issue.
- Verification steps are included in the PR description or delivery notes.
- Issue status is `In Review`.
- No forbidden action was performed.
