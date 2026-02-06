export type MessageRole = "user" | "assistant";

export type Provider = "openai" | "gemini";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out";

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Turn {
  id: string;
  conversationId: string;
  userMessageId: string;
  createdAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  turnId: string;
  role: MessageRole;
  content: string;
  agentRunId: string | null;
  createdAt: Date;
}

export interface AgentRun {
  id: string;
  turnId: string;
  provider: Provider;
  model: string;
  status: AgentRunStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}