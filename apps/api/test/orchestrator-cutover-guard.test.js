import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("runtime code and policy contain no legacy PLANNER references", () => {
  try {
    const output = execFileSync(
      "rg",
      [
        "-n",
        "PLANNER|Planner|role=PLANNER|agents/PLANNER\\.md",
        "apps/api/src",
        "apps/orchestrator/src",
        "policy",
        "agents",
        "AGENTS.md",
      ],
      { encoding: "utf8" },
    );
    assert.equal(output.trim(), "");
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) {
      return;
    }
    throw error;
  }
});
