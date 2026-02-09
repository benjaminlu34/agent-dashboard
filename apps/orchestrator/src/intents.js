import { randomUUID } from "node:crypto";

const INTENT_TYPE = "RUN_INTENT";
function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function malformedItemError(message) {
  const error = new Error(message);
  error.code = "malformed_item_data";
  return error;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function compareItems(left, right) {
  if (left.issue_number !== right.issue_number) {
    return left.issue_number - right.issue_number;
  }
  return String(left.project_item_id).localeCompare(String(right.project_item_id));
}

function normalizeState(previousState) {
  if (!previousState || typeof previousState !== "object") {
    return { poll_count: 0, items: {} };
  }

  const pollCount = Number.isInteger(previousState.poll_count) && previousState.poll_count >= 0 ? previousState.poll_count : 0;
  const items = previousState.items && typeof previousState.items === "object" ? previousState.items : {};

  return {
    poll_count: pollCount,
    items,
  };
}

function toIsoTimestamp(value) {
  if (!hasNonEmptyString(value)) {
    return "";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function minutesBetween(startIso, endIso) {
  const start = toIsoTimestamp(startIso);
  const end = toIsoTimestamp(endIso);
  if (!start || !end) {
    return 0;
  }

  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  if (diffMs <= 0) {
    return 0;
  }

  return Math.floor(diffMs / 60000);
}

function isAfterIso(leftIso, rightIso) {
  const left = toIsoTimestamp(leftIso);
  const right = toIsoTimestamp(rightIso);
  if (!left || !right) {
    return false;
  }
  return new Date(left).getTime() > new Date(right).getTime();
}

function buildDispatchBody({ role, runId, sprint, issueNumber, endpoint }) {
  if (role === "EXECUTOR" && endpoint === "/internal/executor/claim-ready-item") {
    return {
      role,
      run_id: runId,
      sprint,
    };
  }

  return {
    role,
    issue_number: issueNumber,
    run_id: runId,
  };
}

function updateSeenState({
  stateByItemId,
  item,
  status,
  sprint,
  nowIso,
  pollCount,
}) {
  const previous = stateByItemId[item.project_item_id] ?? {};
  const statusChanged = previous.last_seen_status !== status;
  const statusSinceAt = statusChanged ? nowIso : toIsoTimestamp(previous.status_since_at) || nowIso;
  const statusSincePoll = statusChanged
    ? pollCount
    : Number.isInteger(previous.status_since_poll)
      ? previous.status_since_poll
      : pollCount;
  const lastActivityAt = statusChanged ? nowIso : toIsoTimestamp(previous.last_activity_at) || statusSinceAt;
  const lastActivityIndicator = statusChanged ? "status_changed" : previous.last_activity_indicator ?? "status_unchanged";
  const reviewerDispatchesForCurrentStatus = statusChanged
    ? 0
    : Number.isInteger(previous.reviewer_dispatches_for_current_status)
      ? previous.reviewer_dispatches_for_current_status
      : 0;
  const reviewCycleCount = statusChanged
    ? 0
    : Number.isInteger(previous.review_cycle_count) && previous.review_cycle_count >= 0
      ? previous.review_cycle_count
      : 0;
  const lastReviewerOutcome = statusChanged
    ? ""
    : hasNonEmptyString(previous.last_reviewer_outcome)
      ? previous.last_reviewer_outcome.trim().toUpperCase()
      : "";
  const lastReviewerFeedbackAt = statusChanged ? "" : toIsoTimestamp(previous.last_reviewer_feedback_at);
  const lastExecutorResponseAt = statusChanged ? "" : toIsoTimestamp(previous.last_executor_response_at);

  stateByItemId[item.project_item_id] = {
    last_seen_status: status,
    last_seen_sprint: sprint,
    last_seen_issue_number: item.issue_number,
    last_seen_at: nowIso,
    status_since_at: statusSinceAt,
    status_since_poll: statusSincePoll,
    last_activity_at: lastActivityAt,
    last_activity_indicator: lastActivityIndicator,
    last_dispatched_role: hasNonEmptyString(previous.last_dispatched_role) ? previous.last_dispatched_role : "",
    last_dispatched_status: hasNonEmptyString(previous.last_dispatched_status) ? previous.last_dispatched_status : "",
    last_dispatched_at: toIsoTimestamp(previous.last_dispatched_at),
    last_dispatched_poll:
      Number.isInteger(previous.last_dispatched_poll) && previous.last_dispatched_poll >= 0
        ? previous.last_dispatched_poll
        : 0,
    last_run_id: hasNonEmptyString(previous.last_run_id) ? previous.last_run_id : "",
    reviewer_dispatches_for_current_status: reviewerDispatchesForCurrentStatus,
    review_cycle_count: reviewCycleCount,
    last_reviewer_outcome: lastReviewerOutcome,
    last_reviewer_feedback_at: lastReviewerFeedbackAt,
    last_executor_response_at: lastExecutorResponseAt,
  };

  return stateByItemId[item.project_item_id];
}

function markDispatched({ stateItem, role, status, runId, nowIso, pollCount }) {
  stateItem.last_dispatched_role = role;
  stateItem.last_dispatched_status = status;
  stateItem.last_dispatched_at = nowIso;
  stateItem.last_dispatched_poll = pollCount;
  stateItem.last_run_id = runId;
  if (role === "REVIEWER" && status === "In Review") {
    stateItem.reviewer_dispatches_for_current_status += 1;
  }
}

export function buildRunPlan({
  projectItems,
  allowedStatusOptions,
  maxExecutors = 1,
  maxReviewers = 1,
  sprint,
  previousState,
  uuidFactory = randomUUID,
  nowIso = new Date().toISOString(),
  stallMinutes = 120,
  reviewChurnPolls = 3,
  maxReviewerDispatchesPerStatus = 1,
  reviewerRetryPolls = 0,
  maxReviewCycles = 5,
} = {}) {
  if (!Array.isArray(projectItems)) {
    throw new Error("projectItems must be an array");
  }
  if (!Array.isArray(allowedStatusOptions) || allowedStatusOptions.length === 0) {
    throw new Error("allowedStatusOptions must be a non-empty array");
  }
  if (!hasNonEmptyString(sprint)) {
    throw new Error("sprint is required");
  }
  assertPositiveInteger(maxExecutors, "maxExecutors");
  assertPositiveInteger(maxReviewers, "maxReviewers");
  assertPositiveInteger(stallMinutes, "stallMinutes");
  assertPositiveInteger(reviewChurnPolls, "reviewChurnPolls");
  assertPositiveInteger(maxReviewerDispatchesPerStatus, "maxReviewerDispatchesPerStatus");
  assertPositiveInteger(maxReviewCycles, "maxReviewCycles");
  if (!Number.isInteger(reviewerRetryPolls) || reviewerRetryPolls < 0) {
    throw new Error("reviewerRetryPolls must be a non-negative integer");
  }

  const normalizedNowIso = toIsoTimestamp(nowIso);
  if (!normalizedNowIso) {
    throw new Error("nowIso must be a valid ISO timestamp");
  }

  const normalizedSprint = sprint.trim();
  const allowedStatuses = new Set(allowedStatusOptions);
  const previous = normalizeState(previousState);
  const pollCount = previous.poll_count + 1;
  const nextState = {
    poll_count: pollCount,
    items: { ...previous.items },
  };

  const summary = {
    sprint: normalizedSprint,
    poll_count: pollCount,
    in_scope_total: 0,
    status_counts: {
      Backlog: 0,
      Ready: 0,
      "In Progress": 0,
      "In Review": 0,
      "Needs Human Approval": 0,
      Blocked: 0,
      Done: 0,
    },
    intents_emitted: {
      EXECUTOR: 0,
      REVIEWER: 0,
      total: 0,
    },
    skipped: {
      not_in_scope: 0,
      dedupe_same_status: 0,
      concurrency_limit: 0,
    },
    needs_attention: {
      stalled_in_progress: [],
      in_review_churn: [],
    },
    processed_items: [],
  };

  const scopedItems = [];

  for (const item of projectItems) {
    if (!Number.isInteger(item?.issue_number) || item.issue_number <= 0) {
      throw malformedItemError("project item issue_number must be a positive integer");
    }

    if (!hasNonEmptyString(item?.project_item_id)) {
      throw malformedItemError(`project item ${item.issue_number} missing project_item_id`);
    }

    const itemSprint = item?.fields?.Sprint;
    if (!hasNonEmptyString(itemSprint)) {
      throw malformedItemError(`project item ${item.issue_number} missing Sprint`);
    }

    if (itemSprint !== normalizedSprint) {
      summary.skipped.not_in_scope += 1;
      continue;
    }

    const status = item?.fields?.Status;
    if (!hasNonEmptyString(status)) {
      throw malformedItemError(`project item ${item.issue_number} missing Status`);
    }

    if (!allowedStatuses.has(status)) {
      throw malformedItemError(`project item ${item.issue_number} has unknown Status=${status}`);
    }

    summary.in_scope_total += 1;
    summary.status_counts[status] += 1;

    updateSeenState({
      stateByItemId: nextState.items,
      item,
      status,
      sprint: normalizedSprint,
      nowIso: normalizedNowIso,
      pollCount,
    });

    scopedItems.push({
      project_item_id: item.project_item_id,
      issue_number: item.issue_number,
      issue_url: item.issue_url,
      status,
      sprint: normalizedSprint,
    });
  }

  scopedItems.sort(compareItems);

  const intents = [];

  function maybeDispatch(item, role, endpoint, maxCount) {
    const stateItem = nextState.items[item.project_item_id];
    const wasDispatchedForCurrentStatusSinceLastChange =
      stateItem.last_dispatched_role === role &&
      stateItem.last_dispatched_status === item.status &&
      stateItem.last_dispatched_poll >= stateItem.status_since_poll;

    if (wasDispatchedForCurrentStatusSinceLastChange) {
      const canRetryReviewer =
        role === "REVIEWER" &&
        item.status === "In Review" &&
        stateItem.reviewer_dispatches_for_current_status < maxReviewerDispatchesPerStatus &&
        pollCount - stateItem.last_dispatched_poll >= reviewerRetryPolls;

      if (!canRetryReviewer) {
        summary.skipped.dedupe_same_status += 1;
        return;
      }
    }

    if (summary.intents_emitted[role] >= maxCount) {
      summary.skipped.concurrency_limit += 1;
      return;
    }

    const runId = uuidFactory();
    const body = buildDispatchBody({
      role,
      runId,
      sprint: normalizedSprint,
      issueNumber: item.issue_number,
      endpoint,
    });

    intents.push({
      type: INTENT_TYPE,
      role,
      run_id: runId,
      endpoint,
      body,
    });

    markDispatched({
      stateItem,
      role,
      status: item.status,
      runId,
      nowIso: normalizedNowIso,
      pollCount,
    });

    summary.intents_emitted[role] += 1;
    summary.intents_emitted.total += 1;
  }

  for (const item of scopedItems) {
    if (item.status === "Ready") {
      maybeDispatch(item, "EXECUTOR", "/internal/executor/claim-ready-item", maxExecutors);
      continue;
    }

    if (item.status === "In Review") {
      const stateItem = nextState.items[item.project_item_id];
      const lastOutcome = hasNonEmptyString(stateItem.last_reviewer_outcome)
        ? stateItem.last_reviewer_outcome.trim().toUpperCase()
        : "";
      const reviewCycleCount = Number.isInteger(stateItem.review_cycle_count) ? stateItem.review_cycle_count : 0;

      if (lastOutcome === "PASS") {
        continue;
      }
      if (reviewCycleCount >= maxReviewCycles) {
        continue;
      }

      const hasReviewerFeedback = hasNonEmptyString(stateItem.last_reviewer_feedback_at);
      const hasExecutorResponse = hasNonEmptyString(stateItem.last_executor_response_at);
      const executorRespondedAfterFeedback =
        hasReviewerFeedback && hasExecutorResponse
          ? isAfterIso(stateItem.last_executor_response_at, stateItem.last_reviewer_feedback_at)
          : false;

      if (!hasNonEmptyString(lastOutcome)) {
        maybeDispatch(item, "REVIEWER", "/internal/reviewer/resolve-linked-pr", maxReviewers);
        continue;
      }

      if (lastOutcome === "FAIL" || lastOutcome === "INCOMPLETE") {
        if (!executorRespondedAfterFeedback) {
          maybeDispatch(item, "EXECUTOR", "/internal/reviewer/resolve-linked-pr", maxExecutors);
        } else {
          maybeDispatch(item, "REVIEWER", "/internal/reviewer/resolve-linked-pr", maxReviewers);
        }
      }
    }
  }

  for (const item of scopedItems) {
    const stateItem = nextState.items[item.project_item_id];
    const stuckMinutes = minutesBetween(stateItem.status_since_at, normalizedNowIso);
    const inReviewPolls = pollCount - stateItem.status_since_poll + 1;

    if (item.status === "In Progress" && stuckMinutes >= stallMinutes) {
      summary.needs_attention.stalled_in_progress.push({
        issue_number: item.issue_number,
        project_item_id: item.project_item_id,
        stuck_minutes: stuckMinutes,
        status_since_at: stateItem.status_since_at,
        last_activity_indicator: stateItem.last_activity_indicator,
        last_activity_at: stateItem.last_activity_at,
      });
    }

    if (
      item.status === "In Review" &&
      inReviewPolls >= reviewChurnPolls &&
      stateItem.last_dispatched_role === "REVIEWER" &&
      stateItem.last_dispatched_status === "In Review"
    ) {
      summary.needs_attention.in_review_churn.push({
        issue_number: item.issue_number,
        project_item_id: item.project_item_id,
        in_review_polls: inReviewPolls,
        last_run_id: stateItem.last_run_id,
        last_dispatched_at: stateItem.last_dispatched_at,
      });
    }

    summary.processed_items.push({
      issue_number: item.issue_number,
      project_item_id: item.project_item_id,
      status: item.status,
      last_dispatch:
        stateItem.last_dispatched_status === item.status && hasNonEmptyString(stateItem.last_dispatched_role)
          ? {
              role: stateItem.last_dispatched_role,
              run_id: stateItem.last_run_id,
              dispatched_at: stateItem.last_dispatched_at,
            }
          : null,
      stall:
        item.status === "In Progress"
          ? {
              stuck_minutes: stuckMinutes,
              is_stalled: stuckMinutes >= stallMinutes,
            }
          : null,
    });
  }

  const activeCount =
    summary.status_counts.Ready + summary.status_counts["In Progress"] + summary.status_counts["In Review"];
  const completed = activeCount === 0;
  summary.completed = completed;

  return {
    intents,
    nextState,
    summary,
    completed,
  };
}

export function buildRunIntents(options = {}) {
  return buildRunPlan(options).intents;
}
