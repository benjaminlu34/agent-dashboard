# Architecture (Milestone 1)

## Locked decisions
- Frontend: `Next.js`.
- Backend: separate `Fastify` service (Node/TypeScript).
- Providers: `OpenAI` + `Gemini` only.
- Persistence: Postgres stores final outputs + run metadata (not per-token events yet).
- Conversation model: one canonical conversation; each turn fans out into multiple agent responses.
- Streaming transport: SSE with **one connection per turn**.

## Components
- `apps/web` (Next.js): chat UI, per-agent response columns, per-turn SSE client.
- `apps/api` (Fastify): turn orchestration, provider calls, SSE stream, persistence API.
- `packages/adapters`: provider-specific clients behind one minimal interface.
- `packages/db`: Postgres schema + repository layer.

## Request + stream flow
1. User sends prompt from web UI.
2. API creates `Turn` + user `Message`, then creates one `AgentRun` per enabled provider/model.
3. UI opens `GET /v1/turns/:turnId/stream` SSE for that turn.
4. API starts provider calls in parallel.
5. As provider chunks arrive, API forwards SSE `delta` events immediately.
6. Each run completes/fails independently (no cross-blocking).
7. On completion, API writes final assistant `Message` + `AgentRun` metadata (`latency`, `tokens`, `cost`, `status`).
8. UI refresh reconstructs conversation from persisted rows.

## SSE event contract (stable/minimal)
Common fields on all events:
- `type`: event name
- `turnId`: UUID
- `runId`: UUID
- `provider`: `openai | gemini`
- `model`: model id string
- `timestamp`: ISO-8601

Event types:
- `run_started`: run entered `running` state.
- `delta`: incremental text chunk (`textDelta`).
- `usage`: final usage/cost data (`promptTokens`, `completionTokens`, `totalTokens`, `costUsd`).
- `run_done`: run completed (`finalText`, `latencyMs`).
- `run_error`: run failed/timed out (`errorCode`, `errorMessage`).

## API shape (M1)
- `POST /v1/conversations` create conversation.
- `GET /v1/conversations/:id` load conversation + turns + agent responses.
- `POST /v1/conversations/:id/turns` create turn and trigger fan-out.
- `GET /v1/turns/:turnId/stream` SSE stream for exactly one turn.

## Determinism rules
- Turn order is append-only and monotonic by `created_at` + `id` tie-breaker.
- Provider execution is parallel, but persisted final responses are normalized by run creation order.
- No hidden in-memory state; DB is source of truth.

## Why Fastify over Next routes (for M1)
- Clear backend boundary for orchestration complexity and provider fan-out.
- Easier to test as an API service independently from UI.
- Keeps Next app focused on UX and rendering.
