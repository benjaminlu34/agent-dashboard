import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { assertZeroLinkedPullRequests, ExecutorPrLinkageError } from "../internal/executor-pr-linkage.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { isRoleAllowedForRepo, isStatusTransitionAllowedForRepo } from "../internal/policy/enforcement.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const ROLE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CLAIM_MARKER_START = "<!-- EXECUTOR_CLAIM_V1";
const DEFAULT_CLAIM_TTL_MINUTES = 15;
const PROJECT_SCHEMA_PATH = "policy/project-schema.json";
const PROJECT_IDENTITY_PATH = "policy/github-project.json";

let claimQueue = Promise.resolve();

export class ExecutorClaimError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecutorClaimError";
    this.details = details;
  }
}

function runWithClaimLock(callback) {
  const run = claimQueue.then(callback, callback);
  claimQueue = run.catch(() => {});
  return run;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function createReplyRecorder() {
  return {
    statusCode: 200,
    code(nextStatusCode) {
      this.statusCode = nextStatusCode;
      return this;
    },
  };
}

function parseProjectIdentity(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    return { error: "missing project identity policy" };
  }

  try {
    const parsed = JSON.parse(identityFile.content);
    return { projectIdentity: parsed };
  } catch {
    return { error: "invalid project identity policy JSON" };
  }
}

function parseProjectSchema(bundle) {
  const schemaFile = bundle.files.find((file) => file.path === PROJECT_SCHEMA_PATH);
  if (!schemaFile) {
    return { error: "missing project schema policy" };
  }

  try {
    return { schema: JSON.parse(schemaFile.content) };
  } catch {
    return { error: "invalid project schema policy JSON" };
  }
}

function validateSprint({ sprint, projectSchema }) {
  if (!isNonEmptyString(sprint)) {
    return { ok: true };
  }

  const sprintField = Array.isArray(projectSchema?.required_fields)
    ? projectSchema.required_fields.find((field) => field?.name === "Sprint")
    : null;
  const allowedOptions = Array.isArray(sprintField?.allowed_options) ? sprintField.allowed_options : [];
  if (!allowedOptions.includes(sprint)) {
    return { error: "body.sprint is not allowed by project schema policy" };
  }
  return { ok: true };
}

function buildBranchName(issueNumber) {
  return `executor/issue-${issueNumber}`;
}

function buildClaimPayload(candidate) {
  const issueNumber = candidate.issue_number;
  const issueUrl = candidate.issue_url;
  const projectItemId = candidate.project_item_id;
  return {
    issue_number: issueNumber,
    issue_url: issueUrl,
    project_item_id: projectItemId,
    branch: buildBranchName(issueNumber),
    fields_set: {
      Status: "In Progress",
    },
  };
}

function buildClaimComment({ issueNumber, projectItemId, runId, claimedAt }) {
  return [
    "<!-- EXECUTOR_CLAIM_V1",
    `issue: ${issueNumber}`,
    `project_item_id: ${projectItemId}`,
    `run_id: ${runId}`,
    `claimed_at: ${claimedAt}`,
    "-->",
  ].join("\n");
}

function parseClaimComment(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  const markerMatch = body.match(/<!-- EXECUTOR_CLAIM_V1\s*\n([\s\S]*?)\n-->/);
  if (!markerMatch) {
    if (body.includes(CLAIM_MARKER_START)) {
      throw new ExecutorClaimError("malformed claim marker block", { ambiguous: true });
    }
    return null;
  }

  const lines = markerMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const values = new Map();

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      throw new ExecutorClaimError("malformed claim marker line", { ambiguous: true });
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    values.set(key, value);
  }

  const issue = Number(values.get("issue"));
  const projectItemId = values.get("project_item_id");
  const runId = values.get("run_id");
  const claimedAt = values.get("claimed_at");

  if (!Number.isInteger(issue) || issue <= 0) {
    throw new ExecutorClaimError("invalid claim marker issue", { ambiguous: true });
  }
  if (!isNonEmptyString(projectItemId)) {
    throw new ExecutorClaimError("invalid claim marker project_item_id", { ambiguous: true });
  }
  if (!isNonEmptyString(runId) || !UUID_RE.test(runId)) {
    throw new ExecutorClaimError("invalid claim marker run_id", { ambiguous: true });
  }
  if (!isNonEmptyString(claimedAt) || !ISO_RE.test(claimedAt)) {
    throw new ExecutorClaimError("invalid claim marker claimed_at", { ambiguous: true });
  }

  return {
    issue,
    project_item_id: projectItemId,
    run_id: runId,
    claimed_at: claimedAt,
  };
}

function resolveClaimTtlMinutes() {
  const raw = process.env.EXECUTOR_CLAIM_TTL_MINUTES;
  if (!isNonEmptyString(raw)) {
    return DEFAULT_CLAIM_TTL_MINUTES;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ExecutorClaimError("EXECUTOR_CLAIM_TTL_MINUTES must be a positive integer", { ambiguous: true });
  }
  return parsed;
}

function isClaimMarkerExpired({ claimedAt, ttlMinutes, nowMs }) {
  const claimedAtMs = Date.parse(claimedAt);
  if (Number.isNaN(claimedAtMs)) {
    // parseClaimComment() should prevent this; treat as ambiguous if it happens.
    throw new ExecutorClaimError("invalid claim marker claimed_at", { ambiguous: true });
  }
  const ageMinutes = Math.floor((nowMs - claimedAtMs) / 60000);
  return ageMinutes >= ttlMinutes;
}

async function evaluateClaimState({ githubClient, issueNumber, projectItemId, runId }) {
  const comments = await githubClient.listIssueComments({ issueNumber });
  const claimMarkers = [];
  const ttlMinutes = resolveClaimTtlMinutes();
  const nowMs = Date.now();

  for (const comment of comments) {
    const marker = parseClaimComment(comment.body);
    if (!marker || marker.issue !== issueNumber) {
      continue;
    }
    if (marker.project_item_id !== projectItemId) {
      throw new ExecutorClaimError("claim marker project_item_id mismatch for issue", {
        ambiguous: true,
        issue_number: issueNumber,
        project_item_id: projectItemId,
        marker_project_item_id: marker.project_item_id,
      });
    }

    // Lease semantics: ignore stale claim markers to prevent permanent deadlocks when an executor crashes
    // after writing a claim marker but before transitioning Status to In Progress.
    if (isClaimMarkerExpired({ claimedAt: marker.claimed_at, ttlMinutes, nowMs })) {
      continue;
    }

    claimMarkers.push({
      id: comment.id,
      ...marker,
    });
  }

  claimMarkers.sort((left, right) => left.id - right.id);
  if (claimMarkers.length === 0) {
    return { claimed: false };
  }

  // Winner rule for concurrent claims: earliest claim marker (lowest comment id) wins.
  // This resolves races deterministically and avoids permanently deadlocking an item.
  const winningMarker = claimMarkers[0];
  const claimedRunId = winningMarker.run_id;
  if (claimedRunId === runId) {
    return { claimed: true, ownedByRun: true, claimedByRunId: claimedRunId };
  }
  return { claimed: true, ownedByRun: false, claimedByRunId: claimedRunId };
}

async function claimCandidate({ githubClient, normalizedRole, candidate, repoRoot, runId }) {
  const initialClaimState = await evaluateClaimState({
    githubClient,
    issueNumber: candidate.issue_number,
    projectItemId: candidate.project_item_id,
    runId,
  });

  const alreadyClaimedByThisRun = initialClaimState.claimed && initialClaimState.ownedByRun;
  if (initialClaimState.claimed && !initialClaimState.ownedByRun) {
    return { skipped: true, reason: "already_claimed_by_other_run" };
  }

  // Only enforce "zero linked PR" when *acquiring* a new claim.
  // For idempotent reruns (claim marker already exists for runId), linkage may legitimately exist.
  if (!alreadyClaimedByThisRun) {
    const linkage = await assertZeroLinkedPullRequests({
      githubClient,
      issueNumber: candidate.issue_number,
      projectItemId: candidate.project_item_id,
    });

    if (linkage.linked) {
      return { skipped: true, reason: linkage.reason ?? "linked_pr_exists", linkage };
    }
  }

  const transitionResult = await isStatusTransitionAllowedForRepo(normalizedRole, "Ready", "In Progress", { repoRoot });
  if (!transitionResult.allowed) {
    return {
      denied: true,
      payload: {
        error: "status transition is not allowed by policy",
        from: "Ready",
        to: "In Progress",
      },
    };
  }

  if (!alreadyClaimedByThisRun) {
    const claimedAt = new Date().toISOString();
    await githubClient.createIssueComment({
      issueNumber: candidate.issue_number,
      body: buildClaimComment({
        issueNumber: candidate.issue_number,
        projectItemId: candidate.project_item_id,
        runId,
        claimedAt,
      }),
    });

    const afterWriteClaimState = await evaluateClaimState({
      githubClient,
      issueNumber: candidate.issue_number,
      projectItemId: candidate.project_item_id,
      runId,
    });

    if (!afterWriteClaimState.claimed || !afterWriteClaimState.ownedByRun) {
      return { skipped: true, reason: "already_claimed_by_other_run" };
    }
  }

  const currentStatus = await githubClient.getProjectItemFieldValue({
    projectItemId: candidate.project_item_id,
    field: "Status",
  });
  if (currentStatus !== "Ready" && currentStatus !== "In Progress") {
    return { skipped: true, reason: "status_changed" };
  }

  if (currentStatus === "Ready") {
    await githubClient.updateProjectItemField({
      projectItemId: candidate.project_item_id,
      field: "Status",
      value: "In Progress",
    });
  }

  const finalStatus = await githubClient.getProjectItemFieldValue({
    projectItemId: candidate.project_item_id,
    field: "Status",
  });
  if (finalStatus !== "In Progress") {
    return { skipped: true, reason: "status_not_committed" };
  }

  return { claimed: buildClaimPayload(candidate) };
}

export function buildInternalExecutorClaimReadyItemHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalExecutorClaimReadyItemHandler(request, reply) {
    const roleInput = request?.body?.role;
    const sprint = request?.body?.sprint;
    const runId = request?.body?.run_id;

    if (!isNonEmptyString(roleInput)) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    const normalizedRole = roleInput.trim().toUpperCase();
    if (!ROLE_TOKEN_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }
    if (normalizedRole !== "EXECUTOR") {
      reply.code(400);
      return { error: "body.role must be EXECUTOR" };
    }
    if (!isNonEmptyString(runId) || !UUID_RE.test(runId.trim())) {
      reply.code(400);
      return { error: "body.run_id must be a valid UUID" };
    }
    if (sprint !== undefined && !isNonEmptyString(sprint)) {
      reply.code(400);
      return { error: "body.sprint must be a non-empty string when provided" };
    }

    const preflightReply = createReplyRecorder();
    const preflightResult = await resolvedPreflightHandler({ query: { role: normalizedRole } }, preflightReply);
    if (preflightReply.statusCode !== 200) {
      reply.code(preflightReply.statusCode).type("application/json").send(preflightResult);
      return;
    }
    if (preflightResult?.status === "FAIL") {
      reply.code(409).type("application/json").send(preflightResult);
      return;
    }

    let bundle;
    try {
      bundle = await loadAgentContextBundle({ repoRoot, role: normalizedRole });
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500).type("application/json").send({
          error: error.message,
          path: error.details.path,
        });
        return;
      }
      throw error;
    }

    const schemaResult = parseProjectSchema(bundle);
    if (schemaResult.error) {
      reply.code(500).type("application/json").send({ error: schemaResult.error });
      return;
    }

    const sprintValidation = validateSprint({ sprint, projectSchema: schemaResult.schema });
    if (sprintValidation.error) {
      reply.code(400).type("application/json").send({ error: sprintValidation.error });
      return;
    }

    const canSetProjectFields = await isRoleAllowedForRepo(normalizedRole, "can_set_project_fields", { repoRoot });
    const canUpdateStatusOnly = await isRoleAllowedForRepo(normalizedRole, "can_update_status_only", { repoRoot });
    if (!canSetProjectFields && !canUpdateStatusOnly) {
      reply.code(403).type("application/json").send({ error: "role is not allowed to update status" });
      return;
    }

    const projectIdentityResult = parseProjectIdentity(bundle);
    if (projectIdentityResult.error) {
      reply.code(500).type("application/json").send({ error: projectIdentityResult.error });
      return;
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({
        repoRoot,
        projectIdentity: projectIdentityResult.projectIdentity,
      });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502).type("application/json").send({ error: error.message });
        return;
      }
      throw error;
    }

    try {
      const claimResult = await runWithClaimLock(async () => {
        const projectItems = await githubClient.listProjectItems();
        const candidates = projectItems
          .filter((item) => item?.fields?.Status === "Ready")
          .filter((item) => (isNonEmptyString(sprint) ? item?.fields?.Sprint === sprint : true))
          .sort((left, right) => left.issue_number - right.issue_number);

        for (const candidate of candidates) {
          const result = await claimCandidate({
            githubClient,
            normalizedRole,
            candidate,
            repoRoot,
            runId: runId.trim(),
          });

          if (result.denied) {
            return result;
          }
          if (result.claimed) {
            return result;
          }
        }

        return { none: true };
      });

      if (claimResult.denied) {
        reply.code(403).type("application/json").send(claimResult.payload);
        return;
      }

      if (!claimResult.claimed) {
        reply.code(200).type("application/json").send({
          role: normalizedRole,
          run_id: runId.trim(),
          claimed: null,
          reason: "no_claimable_ready_item_found",
        });
        return;
      }

      reply.code(200).type("application/json").send({
        role: normalizedRole,
        run_id: runId.trim(),
        claimed: claimResult.claimed,
      });
      return;
    } catch (error) {
      if (error instanceof ExecutorPrLinkageError || error instanceof ExecutorClaimError) {
        reply.code(409).type("application/json").send({
          error: error.message,
          ...(error.details ?? {}),
        });
        return;
      }
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502).type("application/json").send({ error: error.message });
        return;
      }
      throw error;
    }
  };
}

export async function registerInternalExecutorClaimReadyItemRoute(fastify, options = {}) {
  // Manual call example:
  // curl -X POST http://localhost:4000/internal/executor/claim-ready-item \
  //   -H 'content-type: application/json' \
  //   -d '{"role":"EXECUTOR","run_id":"11111111-1111-4111-8111-111111111111","sprint":"M1"}'
  fastify.post("/internal/executor/claim-ready-item", buildInternalExecutorClaimReadyItemHandler(options));
}
