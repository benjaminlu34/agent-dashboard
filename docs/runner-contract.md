# Runner Contract (Mode A)

This document defines the runner's inputs/outputs and the non-negotiable safety contract.

## Inputs

### 1) Dispatch interface: Orchestrator stdout

`apps/orchestrator` emits JSONL lines to stdout. Each line must be a JSON object with:

```json
{
  "type": "RUN_INTENT",
  "role": "EXECUTOR" | "REVIEWER",
  "run_id": "<uuid>",
  "endpoint": "/internal/...",
  "body": { "role": "EXECUTOR|REVIEWER", "run_id": "<uuid>", "...": "..." }
}
```

Runner must fail closed if:
- JSON is invalid
- unknown fields are present
- role is not `EXECUTOR` or `REVIEWER`
- `body.role` does not match `role`
- `body.run_id` does not match `run_id`
- `endpoint` is not allowed for the role

Runner must pass the backend base URL into the worker prompt. The worker must call:
- `<BACKEND_BASE_URL> + intent.endpoint` with JSON body `intent.body`

### 2) Bundle injection: Backend agent context

Runner fetches bundles via:
- `GET /internal/agent-context?role=<ROLE>`

Rules:
- Inject bundle files verbatim.
- Do not summarize or reinterpret.
- Missing bundle or missing role file is a hard stop.

### 3) Policy authority: Backend endpoints

Backend endpoints are the sole authority for:
- preflight
- claiming work
- resolving linked PRs
- status transitions

Runner must not bypass backend policy gates.

### 4) Kickoff mode (control-plane, optional)

Runner may run a gated kickoff step before starting the scheduler loop:
- Generates a sprint goal issue plus a bounded task set via Codex MCP (JSON-only contract).
- Applies issues via `POST /internal/plan-apply` (role `ORCHESTRATOR`).
- Auto-promotes up to `K<=3` dependency-free `P0` tasks to `Status=Ready` via `POST /internal/project-item/update-field`.

Goal issue requirements:
- Must be labeled `meta:sprint-goal`.
- Must remain non-dispatchable by scheduler state (Status stays `Backlog`).

Note: Scheduler dispatch is status-driven; the GitHub adapter used for `listProjectItems()` does not currently include issue labels, so labels are not used for dispatch filtering.

## Dry-run semantics

In dry-run mode, runner:
- does not execute worker intents (EXECUTOR/REVIEWER)
- does not call backend write endpoints
- logs planned actions only
- does not persist ledger updates

In kickoff dry-run mode, runner may still spawn Codex MCP to generate the kickoff JSON plan, but must not apply it (no `plan-apply` or status updates).

## Ledger semantics

Ledger is a JSON file keyed by `run_id`:

```json
{
  "<run_id>": {
    "run_id": "<run_id>",
    "role": "EXECUTOR",
    "intent_hash": "<sha256>",
    "received_at": "<iso>",
    "status": "queued|running|succeeded|failed",
    "result": {
      "run_id": "<run_id>",
      "role": "EXECUTOR",
      "status": "succeeded|failed",
      "summary": "...",
      "urls": {},
      "errors": []
    }
  }
}
```

Idempotency:
- If a `run_id` is already `succeeded`, runner must skip executing it.
- Failed intents are not auto-retried unless explicitly classified transient.

## Failure classification

Runner classifications:
- `HARD_STOP`: exit immediately (schema/template drift, invalid intent, invalid bundle, preflight FAIL)
- `ITEM_STOP`: stop processing that item (ambiguity: multiple PRs, marker mismatch)
- `TRANSIENT`: bounded retries, then exit `4`

## Exit codes

- `0`: normal completion / no hard stop
- `2`: hard-stop due to policy/template/schema/identity/validation failure
- `3`: malformed item data / unknown status/sprint in scope
- `4`: transient error retries exhausted
- `5`: sanitization regen exhausted (all regen attempts failed; full attempt history emitted)
- `6`: sanitization regen handoff requested (external planner regen request file written)

## MCP execution requirement

Runner must not invent an ad-hoc protocol to talk to `codex mcp-server`.

Runner uses Codex CLI as an MCP server (`codex mcp-server`) and speaks MCP stdio (line-delimited JSON-RPC 2.0).

Runner uses:
- `initialize` + `notifications/initialized`
- `tools/list`
- `tools/call` for tool `codex`

Tool result parsing (per Codex docs):
- Prefer `structuredContent.content` if present.
- Otherwise fall back to `content` text blocks.

Runner requires Codex CLI to have GitHub MCP servers enabled (checked via `codex mcp list`):
- `github`: enabled
- `github_projects`: enabled

## Endpoint allowlist (MVP)

Runner enforces a strict per-role allowlist:
- `EXECUTOR`: `/internal/executor/claim-ready-item`, `/internal/reviewer/resolve-linked-pr`
- `REVIEWER`: `/internal/reviewer/resolve-linked-pr`

## Human Rework Loop

When a task is already in `Needs Human Approval`, humans request additional work by moving:
- `Needs Human Approval` -> `In Review`

Runner/orchestrator behavior for this transition epoch:
- Orchestrator marks the `In Review` origin as `needs_human_approval`.
- First dispatch is `EXECUTOR` to `/internal/reviewer/resolve-linked-pr` (existing PR branch fixup).
- After executor response, orchestrator dispatches `REVIEWER` for re-review.
- On reviewer `PASS`, runner transitions back to `Needs Human Approval`.
- Human can then merge and move the item to `Done`.

Failure handling:
- If executor fixup fails while status is `In Review`, runner transitions the item to `Blocked`
  with structured failure metadata and issue comment audit trail.
