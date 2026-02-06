import assert from "node:assert/strict";
import test from "node:test";

import { isRoleAllowed, isStatusTransitionAllowed } from "../src/internal/policy/enforcement.js";

test("Executor cannot create issues", async () => {
  const allowed = await isRoleAllowed("Executor", "can_create_issues");
  assert.equal(allowed, false);
});

test("Executor can transition Ready -> In Progress", async () => {
  const result = await isStatusTransitionAllowed("Executor", "Ready", "In Progress");
  assert.deepEqual(result, {
    allowed: true,
    automation_allowed: true,
  });
});

test("In Review -> Done is Human-only and marked non-automation", async () => {
  const executorResult = await isStatusTransitionAllowed("Executor", "In Review", "Done");
  assert.deepEqual(executorResult, {
    allowed: false,
    automation_allowed: false,
  });

  const humanResult = await isStatusTransitionAllowed("Human", "In Review", "Done");
  assert.deepEqual(humanResult, {
    allowed: true,
    automation_allowed: false,
  });
});
