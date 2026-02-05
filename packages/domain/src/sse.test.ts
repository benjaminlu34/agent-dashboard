import { describe, expect, it } from "vitest";

import { isStreamEvent } from "./sse.js";

describe("isStreamEvent", () => {
  const baseEvent = {
    turnId: "turn_1",
    runId: "run_1",
    provider: "openai",
    model: "gpt-4.1-mini",
    timestamp: new Date().toISOString(),
  } as const;

  it("accepts a delta event", () => {
    expect(
      isStreamEvent({
        ...baseEvent,
        type: "delta",
        textDelta: "hello",
      }),
    ).toBe(true);
  });

  it("rejects an invalid usage event", () => {
    expect(
      isStreamEvent({
        ...baseEvent,
        type: "usage",
        promptTokens: "10",
        completionTokens: 2,
        totalTokens: 12,
        costUsd: "0.000120",
      }),
    ).toBe(false);
  });

  it("accepts a run_done event", () => {
    expect(
      isStreamEvent({
        ...baseEvent,
        type: "run_done",
        finalText: "done",
        latencyMs: 900,
      }),
    ).toBe(true);
  });
});
