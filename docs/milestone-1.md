# Milestone 1 Plan (1-2 days)

## Objective
Ship a demoable end-to-end flow where one prompt fans out to OpenAI + Gemini, streams side-by-side, and persists final responses with metadata in Postgres.

## Scope in
- Next.js chat UI with one conversation view.
- Fastify API for turn creation + **one SSE stream per turn**.
- Parallel provider execution (OpenAI + Gemini).
- Postgres persistence for conversations, turns, messages, and agent runs.
- Basic guardrails: provider/model allowlist, request timeout, max agents per turn.
- Minimal adapter behavior: streaming text + final usage only.

## Scope out
- Auth/teams.
- Redis/BullMQ workers.
- Per-token event persistence.
- Collaborative features / WebSocket.

## Implementation slices (PR-sized)
1. DB schema + repositories for core entities.
2. Fastify endpoints: create conversation, create turn, load conversation, per-turn SSE stream.
3. Provider adapters: OpenAI + Gemini behind common minimal interface.
4. Orchestrator: fan-out, emit SSE events (`run_started`, `delta`, `usage`, `run_done`, `run_error`), finalize run metadata.
5. Next.js UI: input + per-agent streaming panes + history reload.
6. Validation: one integration test + manual demo script in docs.

## Demo acceptance checklist
- Sending one user prompt triggers both providers in parallel.
- UI shows live streamed text per provider without waiting for the slowest run.
- Final assistant outputs are persisted and visible after refresh.
- Run metadata is persisted and visible (`provider`, `model`, `status`, `latency`, `tokens`, `cost`).
- If one provider fails, the other still completes and persists.
- SSE stream endpoint is scoped to a single `turnId`.

## Manual demo script
1. Start Postgres + API + web app.
2. Create a conversation and send one prompt.
3. Observe OpenAI/Gemini streaming side-by-side.
4. Refresh page and confirm deterministic replay from DB.
5. Trigger one provider failure (bad key/model) and verify isolated failure behavior.

## Exit criteria
Milestone 1 is done when the acceptance checklist passes locally with real provider APIs.
