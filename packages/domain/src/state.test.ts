import { describe, expect, it } from "vitest";

import {
  assertAgentRunStatusTransition,
  canTransitionAgentRunStatus,
  isTerminalAgentRunStatus,
} from "./state.js";

describe("canTransitionAgentRunStatus", () => {
  it("allows queued -> running", () => {
    expect(canTransitionAgentRunStatus("queued", "running")).toBe(true);
  });

  it("allows idempotent transition", () => {
    expect(canTransitionAgentRunStatus("running", "running")).toBe(true);
  });

  it("rejects completed -> running", () => {
    expect(canTransitionAgentRunStatus("completed", "running")).toBe(false);
  });
});

describe("assertAgentRunStatusTransition", () => {
  it("throws on invalid transition", () => {
    expect(() => assertAgentRunStatusTransition("timed_out", "completed")).toThrow(
      "Invalid agent run status transition",
    );
  });
});

describe("isTerminalAgentRunStatus", () => {
  it("marks terminal states correctly", () => {
    expect(isTerminalAgentRunStatus("completed")).toBe(true);
    expect(isTerminalAgentRunStatus("running")).toBe(false);
  });
});
