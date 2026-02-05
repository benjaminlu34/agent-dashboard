import type { Provider } from "./models.js";

export type StreamEventType =
  | "run_started"
  | "delta"
  | "usage"
  | "run_done"
  | "run_error";

export interface StreamEventBase {
  type: StreamEventType;
  turnId: string;
  runId: string;
  provider: Provider;
  model: string;
  timestamp: string;
}

export interface RunStartedEvent extends StreamEventBase {
  type: "run_started";
}

export interface DeltaEvent extends StreamEventBase {
  type: "delta";
  textDelta: string;
}

export interface UsageEvent extends StreamEventBase {
  type: "usage";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
}

export interface RunDoneEvent extends StreamEventBase {
  type: "run_done";
  finalText: string;
  latencyMs: number;
}

export interface RunErrorEvent extends StreamEventBase {
  type: "run_error";
  errorCode: string;
  errorMessage: string;
}

export type StreamEvent =
  | RunStartedEvent
  | DeltaEvent
  | UsageEvent
  | RunDoneEvent
  | RunErrorEvent;

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function hasBaseShape(value: unknown): value is StreamEventBase {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Record<string, unknown>;

  return (
    typeof maybe.type === "string" &&
    typeof maybe.turnId === "string" &&
    typeof maybe.runId === "string" &&
    (maybe.provider === "openai" || maybe.provider === "gemini") &&
    typeof maybe.model === "string" &&
    typeof maybe.timestamp === "string" &&
    isIsoTimestamp(maybe.timestamp)
  );
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  if (!hasBaseShape(value)) {
    return false;
  }

  const maybe = value as StreamEventBase & Record<string, unknown>;

  switch (maybe.type) {
    case "run_started":
      return true;
    case "delta":
      return typeof maybe.textDelta === "string";
    case "usage":
      return (
        (typeof maybe.promptTokens === "number" || maybe.promptTokens === null) &&
        (typeof maybe.completionTokens === "number" ||
          maybe.completionTokens === null) &&
        (typeof maybe.totalTokens === "number" || maybe.totalTokens === null) &&
        (typeof maybe.costUsd === "string" || maybe.costUsd === null)
      );
    case "run_done":
      return (
        typeof maybe.finalText === "string" &&
        typeof maybe.latencyMs === "number"
      );
    case "run_error":
      return (
        typeof maybe.errorCode === "string" &&
        typeof maybe.errorMessage === "string"
      );
    default:
      return false;
  }
}
