import assert from "node:assert/strict";
import test from "node:test";

import { generatePlanDraft, PlanDraftGenerationError } from "../src/internal/plan-draft-generator.js";

function buildFetchStub(outputObject) {
  return async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify(outputObject),
      };
    },
  });
}

test("generatePlanDraft accepts files_likely_touched as high-level paths", async () => {
  const output = {
    sprint: "M1",
    issues: [
      {
        title: "Add DB run metadata support",
        goal: "Track run metadata in a persistence layer.",
        non_goals: ["No dashboard changes"],
        acceptance_criteria: [
          "When run executes, metadata is stored with role and timestamp.",
          "When storage fails, API returns an explicit error code.",
        ],
        files_likely_touched: ["packages/db/migrations/", "apps/api/src/routes/"],
        definition_of_done: ["Tests cover success and failure paths."],
        size: "M",
        area: "db",
        priority: "P1",
        initial_status: "Backlog",
      },
    ],
  };

  const draft = await generatePlanDraft({
    sprint: "M1",
    goal: "Prepare sprint scope.",
    bundle: { files: [] },
    apiKey: "test-key",
    fetchImpl: buildFetchStub(output),
  });

  assert.equal(draft.sprint, "M1");
  assert.equal(draft.issues[0].files_likely_touched[0], "packages/db/migrations/");
});

test("generatePlanDraft rejects files_likely_touched exact migration filenames", async () => {
  const output = {
    sprint: "M1",
    issues: [
      {
        title: "Add DB run metadata support",
        goal: "Track run metadata in a persistence layer.",
        non_goals: ["No dashboard changes"],
        acceptance_criteria: [
          "When run executes, metadata is stored with role and timestamp.",
          "When storage fails, API returns an explicit error code.",
        ],
        files_likely_touched: ["packages/db/migrations/0003_run_logs.sql"],
        definition_of_done: ["Tests cover success and failure paths."],
        size: "M",
        area: "db",
        priority: "P1",
        initial_status: "Backlog",
      },
    ],
  };

  await assert.rejects(
    () =>
      generatePlanDraft({
        sprint: "M1",
        goal: "Prepare sprint scope.",
        bundle: { files: [] },
        apiKey: "test-key",
        fetchImpl: buildFetchStub(output),
      }),
    (error) =>
      error instanceof PlanDraftGenerationError &&
      /files_likely_touched must not include exact migration filenames/.test(error.message),
  );
});
