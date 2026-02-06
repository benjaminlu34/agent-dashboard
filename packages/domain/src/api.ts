import type { AgentRun, Conversation, Message, Provider, Turn } from "./models.js";

export interface RequestedRun {
  provider: Provider;
  model: string;
}

export interface CreateConversationRequest {
  title?: string;
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

export interface CreateTurnRequest {
  content: string;
  runs: RequestedRun[];
}

export interface CreateTurnResponse {
  turnId: string;
  userMessageId: string;
  runIds: string[];
}

export interface AgentRunView {
  run: AgentRun;
  assistantMessage: Message | null;
}

export interface ConversationTurnView {
  turn: Turn;
  userMessage: Message;
  agentRuns: AgentRunView[];
}

export interface GetConversationResponse {
  conversation: Conversation;
  turns: ConversationTurnView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function isRequestedRun(value: unknown): value is RequestedRun {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.provider === "openai" || value.provider === "gemini") &&
    typeof value.model === "string" &&
    value.model.trim().length > 0
  );
}

export function isCreateTurnRequest(value: unknown): value is CreateTurnRequest {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.content !== "string" || value.content.trim().length === 0) {
    return false;
  }

  if (!Array.isArray(value.runs) || value.runs.length === 0) {
    return false;
  }

  return value.runs.every(isRequestedRun);
}
