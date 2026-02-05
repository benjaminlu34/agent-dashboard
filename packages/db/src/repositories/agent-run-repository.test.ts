import { describe, expect, it } from "vitest";

import { dedupeRequestedRuns } from "./agent-run-repository.js";

describe("dedupeRequestedRuns", () => {
  it("keeps one run per provider/model pair", () => {
    const deduped = dedupeRequestedRuns([
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "gemini", model: "gemini-2.5-flash" },
    ]);

    expect(deduped).toEqual([
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "gemini", model: "gemini-2.5-flash" },
    ]);
  });
});
