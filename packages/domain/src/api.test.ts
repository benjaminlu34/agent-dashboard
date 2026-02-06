import { describe, expect, it } from "vitest";

import { isCreateTurnRequest, isRequestedRun } from "./api.js";

describe("isRequestedRun", () => {
  it("accepts valid provider + model", () => {
    expect(
      isRequestedRun({
        provider: "openai",
        model: "gpt-4.1-mini",
      }),
    ).toBe(true);
  });

  it("rejects unknown provider", () => {
    expect(
      isRequestedRun({
        provider: "anthropic",
        model: "claude-3-7-sonnet",
      }),
    ).toBe(false);
  });
});

describe("isCreateTurnRequest", () => {
  it("accepts valid payload", () => {
    expect(
      isCreateTurnRequest({
        content: "Draft release notes",
        runs: [
          { provider: "openai", model: "gpt-4.1-mini" },
          { provider: "gemini", model: "gemini-2.0-flash" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects empty runs array", () => {
    expect(
      isCreateTurnRequest({
        content: "hello",
        runs: [],
      }),
    ).toBe(false);
  });
});
