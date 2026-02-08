## Roles
| Role | Purpose | Allowed | Forbidden | Prompt File |
|---|---|---|---|---|
| Orchestrator | Control-plane dispatch of worker runs | Read project state, call backend gates, emit run intents | Code changes, opening PRs, reviewing PRs, merging PRs, closing issues | `agents/ORCHESTRATOR.md` |
| Executor | Implement ready issues and deliver one PR per issue | Pull `Status=Ready` issues, implement code, open one PR per issue, set `Status=In Review` | Creating issues, modifying project schema, merging PRs, closing issues | `agents/EXECUTOR.md` |
| Reviewer | Evaluate PR quality and requirement coverage | Review PRs, comment, request changes | Pushing commits, opening PRs, merging PRs, closing issues | `agents/REVIEWER.md` |

## Invocation patterns
- `Orchestrator: <instruction>`
- `Executor: <instruction>`
- `Reviewer: <instruction>`

## Current active roles
- Orchestrator
- Executor
- Reviewer
