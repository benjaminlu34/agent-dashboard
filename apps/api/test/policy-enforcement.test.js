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

test("In Review -> Needs Human Approval is Reviewer-only", async () => {
  const reviewerResult = await isStatusTransitionAllowed("Reviewer", "In Review", "Needs Human Approval");
  assert.deepEqual(reviewerResult, {
    allowed: true,
    automation_allowed: true,
  });

  const executorResult = await isStatusTransitionAllowed("Executor", "In Review", "Needs Human Approval");
  assert.deepEqual(executorResult, {
    allowed: false,
    automation_allowed: true,
  });
});

test("Needs Human Approval -> Done is Human-only and marked non-automation", async () => {
  const executorResult = await isStatusTransitionAllowed("Executor", "Needs Human Approval", "Done");
  assert.deepEqual(executorResult, {
    allowed: false,
    automation_allowed: false,
  });

  const humanResult = await isStatusTransitionAllowed("Human", "Needs Human Approval", "Done");
  assert.deepEqual(humanResult, {
    allowed: true,
    automation_allowed: false,
  });
});

test("In Progress -> Blocked is Orchestrator-only", async () => {
  const orchestratorResult = await isStatusTransitionAllowed("Orchestrator", "In Progress", "Blocked");
  assert.deepEqual(orchestratorResult, {
    allowed: true,
    automation_allowed: true,
  });

  const executorResult = await isStatusTransitionAllowed("Executor", "In Progress", "Blocked");
  assert.deepEqual(executorResult, {
    allowed: false,
    automation_allowed: true,
  });
});
