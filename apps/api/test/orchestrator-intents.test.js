import assert from "node:assert/strict";
import test from "node:test";

import { buildRunIntents, buildRunPlan } from "../../orchestrator/src/intents.js";
import { computeSprintPlanMetadata, pathsOverlap } from "../src/internal/sprint-ownership.js";

const ALLOWED_STATUSES = ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"];

test("buildRunPlan filters one sprint and emits deterministic intents with role caps", () => {
  const runIds = ["run-1", "run-2", "run-3"];
  let runIndex = 0;

  const result = buildRunPlan({
    projectItems: [
      { issue_number: 40, project_item_id: "PVTI_40", fields: { Sprint: "M2", Status: "Ready" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "Ready" } },
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Ready" } },
      { issue_number: 30, project_item_id: "PVTI_30", fields: { Sprint: "M1", Status: "In Review" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    maxExecutors: 1,
    maxReviewers: 1,
    uuidFactory: () => runIds[runIndex++],
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(result.summary.in_scope_total, 3);
  assert.equal(result.summary.skipped.not_in_scope, 1);
  assert.equal(result.intents.length, 2);
  assert.deepEqual(result.intents[0], {
    type: "RUN_INTENT",
    role: "EXECUTOR",
    run_id: "run-1",
    endpoint: "/internal/executor/claim-ready-item",
    body: {
      role: "EXECUTOR",
      run_id: "run-1",
      sprint: "M1",
    },
  });
  assert.deepEqual(result.intents[1], {
    type: "RUN_INTENT",
    role: "REVIEWER",
    run_id: "run-2",
    endpoint: "/internal/reviewer/resolve-linked-pr",
    body: {
      role: "REVIEWER",
      issue_number: 30,
      run_id: "run-2",
    },
  });
});

test("buildRunPlan fails closed when Sprint is missing", () => {
  assert.throws(
    () =>
      buildRunPlan({
        projectItems: [{ issue_number: 55, project_item_id: "PVTI_55", fields: { Status: "Ready" } }],
        allowedStatusOptions: ALLOWED_STATUSES,
        sprint: "M1",
      }),
    /missing Sprint/,
  );
});

test("buildRunPlan fails closed when Status is missing for scoped item", () => {
  assert.throws(
    () =>
      buildRunPlan({
        projectItems: [{ issue_number: 56, project_item_id: "PVTI_56", fields: { Sprint: "M1" } }],
        allowedStatusOptions: ALLOWED_STATUSES,
        sprint: "M1",
      }),
    /missing Status/,
  );
});

test("buildRunPlan dedupes repeated polls for unchanged status", () => {
  const first = buildRunPlan({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Ready" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "In Review" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    uuidFactory: () => "run-a",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(first.intents.length, 2);

  const second = buildRunPlan({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Ready" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "In Review" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: first.nextState,
    uuidFactory: () => "run-b",
    nowIso: "2026-02-07T12:05:00.000Z",
  });

  assert.equal(second.intents.length, 0);
  assert.equal(second.summary.skipped.dedupe_same_status, 2);
});

test("buildRunPlan emits again when status changes to a dispatchable role", () => {
  const first = buildRunPlan({
    projectItems: [{ issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Ready" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    uuidFactory: () => "run-1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  const second = buildRunPlan({
    projectItems: [{ issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "In Progress" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: first.nextState,
    uuidFactory: () => "run-2",
    nowIso: "2026-02-07T12:10:00.000Z",
  });

  assert.equal(second.intents.length, 0);

  const third = buildRunPlan({
    projectItems: [{ issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: second.nextState,
    uuidFactory: () => "run-3",
    nowIso: "2026-02-07T12:20:00.000Z",
  });

  assert.equal(third.intents.length, 1);
  assert.equal(third.intents[0].role, "REVIEWER");
  assert.equal(third.intents[0].body.issue_number, 10);
});

test("buildRunPlan marks sprint complete when no active statuses remain and backlog is empty", () => {
  const result = buildRunPlan({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Done" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "Blocked" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(result.completed, true);
  assert.equal(result.summary.completed, true);
  assert.equal(result.intents.length, 0);
});

test("buildRunPlan does not mark sprint complete when backlog remains", () => {
  const result = buildRunPlan({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Done" } },
      { issue_number: 30, project_item_id: "PVTI_30", fields: { Sprint: "M1", Status: "Backlog" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(result.completed, false);
  assert.equal(result.summary.completed, false);
});

test("buildRunPlan includes stalled In Progress entries in summary", () => {
  const result = buildRunPlan({
    projectItems: [{ issue_number: 99, project_item_id: "PVTI_99", fields: { Sprint: "M1", Status: "In Progress" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: {
      poll_count: 4,
      items: {
        PVTI_99: {
          last_seen_status: "In Progress",
          status_since_at: "2026-02-07T08:00:00.000Z",
          status_since_poll: 1,
          last_activity_at: "2026-02-07T08:00:00.000Z",
          last_activity_indicator: "status_changed",
        },
      },
    },
    stallMinutes: 120,
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(result.summary.needs_attention.stalled_in_progress.length, 1);
  assert.equal(result.summary.needs_attention.stalled_in_progress[0].issue_number, 99);
  assert.equal(result.summary.needs_attention.stalled_in_progress[0].project_item_id, "PVTI_99");
  assert.equal(result.summary.needs_attention.stalled_in_progress[0].stuck_minutes, 240);
  assert.equal(result.summary.needs_attention.stalled_in_progress[0].last_activity_indicator, "status_changed");
});

test("buildRunPlan reports in-review churn after repeated polls in same status", () => {
  const first = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    uuidFactory: () => "run-review-1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  const second = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: first.nextState,
    reviewChurnPolls: 2,
    nowIso: "2026-02-07T12:10:00.000Z",
  });

  assert.equal(second.summary.needs_attention.in_review_churn.length, 1);
  assert.equal(second.summary.needs_attention.in_review_churn[0].issue_number, 88);
  assert.equal(second.summary.processed_items.length, 1);
  assert.equal(second.summary.processed_items[0].issue_number, 88);
});

test("buildRunPlan redispatches reviewer once after stall threshold", () => {
  const result = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: {
      poll_count: 50,
      items: {
        PVTI_88: {
          last_seen_status: "In Review",
          last_seen_sprint: "M1",
          last_seen_issue_number: 88,
          last_seen_at: "2026-02-07T12:00:00.000Z",
          status_since_at: "2026-02-07T10:00:00.000Z",
          status_since_poll: 1,
          last_activity_at: "2026-02-07T10:00:00.000Z",
          last_activity_indicator: "status_changed",
          last_dispatched_role: "REVIEWER",
          last_dispatched_status: "In Review",
          last_dispatched_at: "2026-02-07T12:00:00.000Z",
          last_dispatched_poll: 1,
          last_run_id: "run-review-1",
          reviewer_dispatches_for_current_status: 1,
        },
      },
    },
    maxReviewers: 1,
    maxReviewerDispatchesPerStatus: 2,
    reviewerRetryPolls: 50,
    uuidFactory: () => "run-review-2",
    nowIso: "2026-02-07T13:00:00.000Z",
  });

  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].role, "REVIEWER");
  assert.equal(result.intents[0].run_id, "run-review-2");
});

test("buildRunPlan alternates In Review between reviewer and executor after feedback", () => {
  const first = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    uuidFactory: () => "run-review-1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });
  assert.equal(first.intents.length, 1);
  assert.equal(first.intents[0].role, "REVIEWER");

  const second = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: {
      ...first.nextState,
      items: {
        ...first.nextState.items,
        PVTI_88: {
          ...first.nextState.items.PVTI_88,
          last_reviewer_outcome: "FAIL",
          last_reviewer_feedback_at: "2026-02-07T12:01:00.000Z",
          last_executor_response_at: "",
          review_cycle_count: 1,
        },
      },
    },
    uuidFactory: () => "run-exec-1",
    nowIso: "2026-02-07T12:02:00.000Z",
  });
  assert.equal(second.intents.length, 1);
  assert.equal(second.intents[0].role, "EXECUTOR");
  assert.equal(second.intents[0].endpoint, "/internal/reviewer/resolve-linked-pr");

  const third = buildRunPlan({
    projectItems: [{ issue_number: 88, project_item_id: "PVTI_88", fields: { Sprint: "M1", Status: "In Review" } }],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    previousState: {
      ...second.nextState,
      items: {
        ...second.nextState.items,
        PVTI_88: {
          ...second.nextState.items.PVTI_88,
          last_reviewer_outcome: "FAIL",
          last_reviewer_feedback_at: "2026-02-07T12:01:00.000Z",
          last_executor_response_at: "2026-02-07T12:03:00.000Z",
          review_cycle_count: 1,
        },
      },
    },
    uuidFactory: () => "run-review-2",
    nowIso: "2026-02-07T12:04:00.000Z",
  });
  assert.equal(third.intents.length, 1);
  assert.equal(third.intents[0].role, "REVIEWER");
});

test("buildRunIntents returns only intents array for compatibility", () => {
  const runIds = ["run-x", "run-y"];
  let index = 0;

  const intents = buildRunIntents({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Ready" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "In Review" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    uuidFactory: () => runIds[index++],
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(Array.isArray(intents), true);
  assert.equal(intents.length, 2);
  assert.equal(intents[0].run_id, "run-x");
  assert.equal(intents[1].run_id, "run-y");
});

test("computeSprintPlanMetadata uses prefix overlap and chains conflicting ownership", () => {
  assert.equal(pathsOverlap("apps/api", "apps/api/src"), true);
  assert.equal(pathsOverlap("apps/api/src", "apps/api/src/routes"), true);
  assert.equal(pathsOverlap("apps/api", "apps/api2"), false);

  const { sprintPlan, ownershipIndex } = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 2,
        title: "[TASK] API work",
        priority: "P0",
        files_likely_touched: ["apps/api/src/"],
      },
      {
        issue_number: 3,
        title: "[TASK] API follow-up",
        priority: "P1",
        files_likely_touched: ["apps/api/src/routes/"],
      },
      {
        issue_number: 4,
        title: "[TASK] Runner task",
        priority: "P0",
        files_likely_touched: ["apps/runner/src/"],
      },
    ],
    buckets: ["apps/api", "apps/runner", "apps", "docs", "policy"],
    sharedCorePaths: new Set(),
  });
  const second = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 2,
        title: "[TASK] API work",
        priority: "P0",
        files_likely_touched: ["apps/api/src/"],
      },
      {
        issue_number: 3,
        title: "[TASK] API follow-up",
        priority: "P1",
        files_likely_touched: ["apps/api/src/routes/"],
      },
      {
        issue_number: 4,
        title: "[TASK] Runner task",
        priority: "P0",
        files_likely_touched: ["apps/runner/src/"],
      },
    ],
    buckets: ["apps/api", "apps/runner", "apps", "docs", "policy"],
    sharedCorePaths: new Set(),
  });
  assert.deepEqual(second.sprintPlan, sprintPlan);
  assert.deepEqual(second.ownershipIndex, ownershipIndex);

  assert.equal(sprintPlan["2"].isolation_mode, "CHAINED");
  assert.deepEqual(sprintPlan["2"].conflicts_with, [3]);
  assert.deepEqual(sprintPlan["2"].depends_on, []);
  assert.equal(sprintPlan["3"].isolation_mode, "CHAINED");
  assert.deepEqual(sprintPlan["3"].conflicts_with, [2]);
  assert.deepEqual(sprintPlan["3"].depends_on, [2]);
  assert.equal(sprintPlan["4"].isolation_mode, "ISOLATED");
  assert.deepEqual(sprintPlan["4"].conflicts_with, []);

  assert.equal(ownershipIndex["apps/api"], 2);
  assert.equal(ownershipIndex["apps/runner"], 4);
});

test("computeSprintPlanMetadata infers granular ownership when only top-level bucket matches", () => {
  const first = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 2,
        title: "[TASK] Data catalogs",
        priority: "P0",
        files_likely_touched: ["Assets/Scripts/Data/*.cs"],
      },
      {
        issue_number: 3,
        title: "[TASK] Event channels",
        priority: "P0",
        files_likely_touched: ["Assets/Scripts/Events/*.cs"],
      },
      {
        issue_number: 4,
        title: "[TASK] Scene setup",
        priority: "P0",
        files_likely_touched: ["Assets/Scenes/VerticalSlice.unity"],
      },
    ],
    buckets: ["Assets", "docs"],
    sharedCorePaths: new Set(),
  });

  const second = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 2,
        title: "[TASK] Data catalogs",
        priority: "P0",
        files_likely_touched: ["Assets/Scripts/Data/*.cs"],
      },
      {
        issue_number: 3,
        title: "[TASK] Event channels",
        priority: "P0",
        files_likely_touched: ["Assets/Scripts/Events/*.cs"],
      },
      {
        issue_number: 4,
        title: "[TASK] Scene setup",
        priority: "P0",
        files_likely_touched: ["Assets/Scenes/VerticalSlice.unity"],
      },
    ],
    buckets: ["Assets", "docs"],
    sharedCorePaths: new Set(),
  });

  assert.deepEqual(second, first);
  assert.deepEqual(first.sprintPlan["2"].owns_paths, ["Assets/Scripts/Data"]);
  assert.deepEqual(first.sprintPlan["3"].owns_paths, ["Assets/Scripts/Events"]);
  assert.deepEqual(first.sprintPlan["4"].owns_paths, ["Assets/Scenes"]);
  assert.equal(first.sprintPlan["2"].isolation_mode, "ISOLATED");
  assert.equal(first.sprintPlan["3"].isolation_mode, "ISOLATED");
  assert.equal(first.sprintPlan["4"].isolation_mode, "ISOLATED");
  assert.deepEqual(first.sprintPlan["2"].conflicts_with, []);
  assert.deepEqual(first.sprintPlan["3"].conflicts_with, []);
  assert.deepEqual(first.sprintPlan["4"].conflicts_with, []);
  assert.equal(first.ownershipIndex["Assets/Scripts/Data"], 2);
  assert.equal(first.ownershipIndex["Assets/Scripts/Events"], 3);
  assert.equal(first.ownershipIndex["Assets/Scenes"], 4);
});

test("computeSprintPlanMetadata does not assign ownership to sprint goal issues", () => {
  const { sprintPlan } = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 1,
        title: "[ORCHESTRATOR] [SPRINT GOAL] M1: Example goal",
        priority: "P0",
        labels: ["meta:sprint-goal"],
        files_likely_touched: ["Assets/Game/Runtime/"],
      },
      {
        issue_number: 2,
        title: "[TASK] A",
        priority: "P0",
        files_likely_touched: ["Assets/Game/Runtime/Ship/"],
      },
    ],
    buckets: ["Assets/Game/Runtime", "Assets"],
    sharedCorePaths: new Set(),
  });

  assert.deepEqual(sprintPlan["1"].owns_paths, []);
  assert.equal(sprintPlan["1"].isolation_mode, "ISOLATED");
});

test("computeSprintPlanMetadata orders chained dependencies by plan_order", () => {
  const { sprintPlan } = computeSprintPlanMetadata({
    issues: [
      {
        issue_number: 2,
        plan_order: 1,
        title: "[TASK] Zeta",
        priority: "P0",
        files_likely_touched: ["docs/a.md"],
      },
      {
        issue_number: 3,
        plan_order: 2,
        title: "[TASK] Alpha",
        priority: "P0",
        files_likely_touched: ["docs/b.md"],
      },
      {
        issue_number: 4,
        plan_order: 3,
        title: "[TASK] Beta",
        priority: "P0",
        files_likely_touched: ["docs/c.md"],
      },
    ],
    buckets: ["docs"],
    sharedCorePaths: new Set(),
  });

  assert.equal(sprintPlan["2"].isolation_mode, "CHAINED");
  assert.deepEqual(sprintPlan["2"].depends_on, []);
  assert.deepEqual(sprintPlan["3"].depends_on, [2]);
  assert.deepEqual(sprintPlan["4"].depends_on, [3]);
});
