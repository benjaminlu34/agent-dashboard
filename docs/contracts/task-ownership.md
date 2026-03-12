# Task Ownership (Why It Exists)

Concurrent executors are valuable, but they also amplify merge conflicts when two tasks modify overlapping files.
This project adds deterministic "ownership" metadata to sprint issues so the orchestration layer can prevent
conflicting work from being in `Ready` at the same time.

Runner autopromotion uses this metadata to maintain the Ready buffer when enabled.

## Metadata

Each sprint task issue includes a `## Scope` section with:

- `touch_paths`: paths the executor is allowed to modify.
- `owns_paths`: exclusive-writer paths (subset of `touch_paths`) used for conflict detection.
- `conflicts_with`: issue numbers that overlap on `owns_paths` (prefix-based).
- `depends_on`: issue numbers that must reach `Done` before this task can be promoted.
- `group_id`: stable grouping label (used to chain related tasks deterministically).
- `isolation_mode`: `ISOLATED` or `CHAINED`.

Overlap detection is prefix-based:

- `apps/api` overlaps `apps/api/src`
- `apps/api/src` overlaps `apps/api/src/routes`

## Promotion Rules

Backlog -> Ready promotion is gated:

- `ISOLATED`: can be promoted only if its `owns_paths` do not overlap any `Ready` issue or any active issue
  (`In Progress`, `In Review`, `Needs Human Approval`).
- `CHAINED`: can be promoted only if all `depends_on` issues have reached `Done`.
  Overlaps with `Ready`/`In Progress`/`In Review` issues remain blocked; overlaps with prerequisites already in
  `Done` are allowed.

## Dependency Sanitization

- `depends_on` edges are pruned when the tasks do not overlap on `owns_paths` (prefix-based).
- `depends_on` edges from non-doc tasks to doc-only tasks are pruned.
- Doc-only tasks are tasks whose `touch_paths` stay within documentation paths or doc-only file extensions (`.md`, `.txt`, `.rst`).
- Cycles are invalid and must be resolved before promotion can proceed.

## Scope Expansion

Executors must only modify files under `touch_paths`. If more scope is required:

1. Comment on the issue requesting scope expansion.
2. List the exact files/directories needed and why.
3. Stop the run (do not proceed out-of-scope).

Humans can then decide whether to update the issue scope or split/re-sequence work.
