import assert from "node:assert/strict";
import test from "node:test";

import { buildRunIntents, buildRunPlan } from "../../orchestrator/src/intents.js";

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

test("buildRunPlan marks sprint complete when no active statuses remain", () => {
  const result = buildRunPlan({
    projectItems: [
      { issue_number: 10, project_item_id: "PVTI_10", fields: { Sprint: "M1", Status: "Done" } },
      { issue_number: 20, project_item_id: "PVTI_20", fields: { Sprint: "M1", Status: "Blocked" } },
      { issue_number: 30, project_item_id: "PVTI_30", fields: { Sprint: "M1", Status: "Backlog" } },
    ],
    allowedStatusOptions: ALLOWED_STATUSES,
    sprint: "M1",
    nowIso: "2026-02-07T12:00:00.000Z",
  });

  assert.equal(result.completed, true);
  assert.equal(result.summary.completed, true);
  assert.equal(result.intents.length, 0);
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
