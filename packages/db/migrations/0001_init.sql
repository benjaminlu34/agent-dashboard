CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE message_role AS ENUM ('user', 'assistant');
CREATE TYPE provider AS ENUM ('openai', 'gemini');
CREATE TYPE agent_run_status AS ENUM ('queued', 'running', 'completed', 'failed', 'timed_out');

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  provider provider NOT NULL,
  model text NOT NULL,
  status agent_run_status NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  ended_at timestamptz,
  latency_ms integer,
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  cost_usd numeric(12,6),
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  role message_role NOT NULL,
  content text NOT NULL,
  agent_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE UNIQUE INDEX messages_agent_run_unique_idx ON messages (agent_run_id);
CREATE INDEX turns_conversation_created_at_idx ON turns (conversation_id, created_at);
CREATE INDEX messages_conversation_created_at_idx ON messages (conversation_id, created_at);
CREATE INDEX agent_runs_turn_created_at_idx ON agent_runs (turn_id, created_at);
CREATE INDEX agent_runs_status_idx ON agent_runs (status);
