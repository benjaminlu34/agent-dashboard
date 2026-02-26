import assert from "node:assert/strict";
import test from "node:test";

import { parseIssueTaskBrief } from "../src/internal/task-brief-parser.js";

test("parseIssueTaskBrief extracts known markdown headings", () => {
  const parsed = parseIssueTaskBrief([
    "### Goal",
    "Deliver feature X.",
    "",
    "### Non-goals",
    "- No frontend changes",
    "",
    "### Acceptance Criteria",
    "- All tests pass",
    "",
    "### Files Likely Touched",
    "- apps/api/src/routes/internal-agent-context.js",
    "",
    "### Definition of Done",
    "- merged",
  ].join("\n"));

  assert.deepEqual(parsed, {
    goal: "Deliver feature X.",
    non_goals: "- No frontend changes",
    acceptance_criteria: "- All tests pass",
    files_likely_touched: "- apps/api/src/routes/internal-agent-context.js",
    definition_of_done: "- merged",
  });
});

test("parseIssueTaskBrief falls back to raw_description when headings are missing", () => {
  const parsed = parseIssueTaskBrief("Fix backend validation around run payload.");
  assert.deepEqual(parsed, {
    raw_description: "Fix backend validation around run payload.",
  });
});
