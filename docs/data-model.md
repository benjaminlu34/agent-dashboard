# Data Model (Milestone 1)

## Core entities

### `conversations`
- `id` (uuid, pk)
- `title` (text)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

### `turns`
- `id` (uuid, pk)
- `conversation_id` (uuid, fk -> conversations.id)
- `user_message_id` (uuid, fk -> messages.id)
- `created_at` (timestamptz)

### `messages`
- `id` (uuid, pk)
- `conversation_id` (uuid, fk -> conversations.id)
- `turn_id` (uuid, fk -> turns.id)
- `role` (`user` | `assistant`)
- `content` (text)
- `agent_run_id` (uuid, nullable, fk -> agent_runs.id) // set for assistant messages
- `created_at` (timestamptz)

### `agent_runs`
- `id` (uuid, pk)
- `turn_id` (uuid, fk -> turns.id)
- `provider` (`openai` | `gemini`)
- `model` (text)
- `status` (`queued` | `running` | `completed` | `failed` | `timed_out`)
- `started_at` (timestamptz, nullable)
- `ended_at` (timestamptz, nullable)
- `latency_ms` (int, nullable)
- `prompt_tokens` (int, nullable)
- `completion_tokens` (int, nullable)
- `total_tokens` (int, nullable)
- `cost_usd` (numeric(12,6), nullable)
- `error_code` (text, nullable)
- `error_message` (text, nullable)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

## Relationships
- One `conversation` has many `turns`.
- One `turn` has exactly one user `message` and many `agent_runs`.
- One successful `agent_run` has exactly one assistant `message`.

## Invariants (M1)
- Exactly one `user` message per turn.
- At most one assistant message per `agent_run`.
- `status=completed` requires assistant message + token/cost fields when available.
- Failed/timed-out runs never block other runs from completing.

## Persistence scope (locked)
Persist only:
- Final assistant message content (`messages.content` for `role=assistant`).
- Final `agent_runs` metadata (`status`, latency, usage, cost, errors).

Do not persist per-token stream events in Milestone 1.

## Deferred for later
- Per-token event storage (`agent_run_events`).
- Multi-branch conversation trees beyond "one turn -> many agent responses".

## Suggested indexes
- `turns(conversation_id, created_at)`
- `messages(conversation_id, created_at)`
- `agent_runs(turn_id, created_at)`
- `agent_runs(status)`
