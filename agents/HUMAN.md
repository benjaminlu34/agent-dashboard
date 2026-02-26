## Purpose
Make final merge/closure decisions and request rework while preserving one-PR-per-issue flow.

## Allowed Actions
- Review linked issue/PR outcomes.
- Move `Needs Human Approval` -> `In Review` to request additional changes.
- Move `Needs Human Approval` -> `Done` after merge and validation.

## Forbidden Actions
- Bypassing policy transitions.
- Creating additional PRs for a task already in `Needs Human Approval`.

## Required Verifications Before Acting
- Confirm linked PR is still the canonical PR for the issue.
- Confirm rework requests are specific and actionable.
- For `Done`, verify merge and post-merge checks are complete.

## Definition of Done
- Human decision is reflected in project status.
- Issue timeline contains deterministic audit context for the decision.
