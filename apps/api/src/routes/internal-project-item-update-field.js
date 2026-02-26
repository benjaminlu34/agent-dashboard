import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import {
  isRoleAllowedForRepo,
  isStatusTransitionAllowedForRepo,
} from "../internal/policy/enforcement.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const ROLE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_SCHEMA_PATH = "policy/project-schema.json";
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const NEEDS_HUMAN_APPROVAL_STATUS = "Needs Human Approval";
const IN_REVIEW_STATUS = "In Review";
const IN_PROGRESS_STATUS = "In Progress";
const BLOCKED_STATUS = "Blocked";
const READY_STATUS = "Ready";
const HUMAN_ROLE = "HUMAN";
const ORCHESTRATOR_ROLE = "ORCHESTRATOR";

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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function buildHumanApprovalComment({
  issueNumber,
  prUrl,
  checksPerformed,
  checksPassed,
  humanSteps,
  projectItemId,
  runId = "",
}) {
  const lines = [
    "Reviewer handoff: Needs Human Approval",
    "",
    `Linked issue: #${issueNumber}`,
    `Linked PR: ${prUrl}`,
    "",
    "What was checked:",
    ...checksPerformed.map((entry) => `- ${entry}`),
    "",
    "What passed:",
    ...checksPassed.map((entry) => `- ${entry}`),
    "",
    "Human steps:",
    ...humanSteps.map((entry) => `- ${entry}`),
    "",
    "<!-- NEEDS_HUMAN_APPROVAL_HANDOFF_V1",
    `project_item_id: ${projectItemId}`,
  ];
  if (isNonEmptyString(runId)) {
    lines.push(`run_id: ${runId}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

function buildHumanReworkRequestComment({
  issueNumber,
  reworkReason,
  requestedActions,
  projectItemId,
  role,
  runId = "",
}) {
  const lines = [
    "Human rework request: Needs Human Approval -> In Review",
    "",
    `Linked issue: #${issueNumber}`,
    `Reason: ${reworkReason}`,
    "",
    "Requested actions:",
    ...requestedActions.map((entry) => `- ${entry}`),
    "",
    "<!-- HUMAN_REWORK_REQUEST_V1",
    `project_item_id: ${projectItemId}`,
    "from: Needs Human Approval",
    "to: In Review",
    `requested_by_role: ${role}`,
  ];
  if (isNonEmptyString(runId)) {
    lines.push(`run_id: ${runId}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

function buildExecutionFailureBlockedComment({
  issueNumber,
  fromStatus,
  failureClassification,
  failureMessage,
  suggestedNextSteps,
  projectItemId,
  runId = "",
}) {
  const lines = [
    "Executor failure handoff: Blocked",
    "",
    `Linked issue: #${issueNumber}`,
    `Failure stage: ${fromStatus} -> Blocked`,
    `Failure classification: ${failureClassification}`,
    "",
    "Failure message:",
    failureMessage,
    "",
    "Suggested next steps:",
    ...suggestedNextSteps.map((entry) => `- ${entry}`),
    "",
    "<!-- EXECUTOR_FAILURE_BLOCKED_V1",
    `project_item_id: ${projectItemId}`,
  ];
  if (isNonEmptyString(runId)) {
    lines.push(`run_id: ${runId}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

function buildBlockedRetryComment({
  issueNumber,
  retryReason,
  failureClassification,
  failureErrorCode,
  blockedMinutes,
  suggestedNextSteps,
  projectItemId,
  runId = "",
}) {
  const lines = [
    "Orchestrator retry handoff: Blocked -> Ready",
    "",
    `Linked issue: #${issueNumber}`,
    `Retry reason: ${retryReason}`,
    `Previous failure classification: ${failureClassification}`,
    `Previous error code: ${failureErrorCode}`,
    `Blocked duration minutes: ${blockedMinutes}`,
    "",
    "Suggested next steps:",
    ...suggestedNextSteps.map((entry) => `- ${entry}`),
    "",
    "<!-- BLOCKED_RETRY_READY_V1",
    `project_item_id: ${projectItemId}`,
  ];
  if (isNonEmptyString(runId)) {
    lines.push(`run_id: ${runId}`);
  }
  lines.push("-->");
  return lines.join("\n");
}

function parseNeedsHumanApprovalMetadata(body) {
  const issueNumber = body?.issue_number;
  const prUrl = body?.pr_url;
  const checksPerformed = normalizeStringArray(body?.checks_performed);
  const checksPassed = normalizeStringArray(body?.checks_passed);
  const humanSteps = normalizeStringArray(body?.human_steps);
  const runId = isNonEmptyString(body?.run_id) ? body.run_id.trim() : "";

  if (!isPositiveInteger(issueNumber)) {
    return { error: "body.issue_number must be a positive integer for Needs Human Approval transition" };
  }
  if (!isNonEmptyString(prUrl)) {
    return { error: "body.pr_url is required for Needs Human Approval transition" };
  }
  if (checksPerformed.length === 0) {
    return { error: "body.checks_performed must be a non-empty array of strings for Needs Human Approval transition" };
  }
  if (checksPassed.length === 0) {
    return { error: "body.checks_passed must be a non-empty array of strings for Needs Human Approval transition" };
  }
  if (humanSteps.length === 0) {
    return { error: "body.human_steps must be a non-empty array of strings for Needs Human Approval transition" };
  }

  return {
    issueNumber,
    prUrl: prUrl.trim(),
    checksPerformed,
    checksPassed,
    humanSteps,
    runId,
  };
}

function parseHumanReworkMetadata(body) {
  const issueNumber = body?.issue_number;
  const requestedActions = normalizeStringArray(body?.requested_actions);
  const runId = isNonEmptyString(body?.run_id) ? body.run_id.trim() : "";
  const reasonCandidate = isNonEmptyString(body?.human_rework_reason)
    ? body.human_rework_reason
    : isNonEmptyString(body?.human_step)
      ? body.human_step
      : "";

  if (!isPositiveInteger(issueNumber)) {
    return { error: "body.issue_number must be a positive integer for Needs Human Approval -> In Review transition" };
  }
  if (!isNonEmptyString(reasonCandidate)) {
    return { error: "body.human_rework_reason (or body.human_step) is required for Needs Human Approval -> In Review transition" };
  }

  const normalizedRequestedActions = requestedActions.length > 0 ? requestedActions : [reasonCandidate.trim()];
  return {
    issueNumber,
    reworkReason: reasonCandidate.trim(),
    requestedActions: normalizedRequestedActions,
    runId,
  };
}

function parseExecutionFailureBlockedMetadata(body, { fromStatus }) {
  const transitionLabel = `${fromStatus} -> Blocked`;
  const issueNumber = body?.issue_number;
  const failureClassification = body?.failure_classification;
  const failureMessage = body?.failure_message;
  const suggestedNextSteps = normalizeStringArray(body?.suggested_next_steps);
  const runId = isNonEmptyString(body?.run_id) ? body.run_id.trim() : "";

  if (!isPositiveInteger(issueNumber)) {
    return { error: `body.issue_number must be a positive integer for ${transitionLabel} transition` };
  }
  if (!isNonEmptyString(failureClassification)) {
    return { error: `body.failure_classification is required for ${transitionLabel} transition` };
  }
  if (!isNonEmptyString(failureMessage)) {
    return { error: `body.failure_message is required for ${transitionLabel} transition` };
  }
  if (suggestedNextSteps.length === 0) {
    return { error: `body.suggested_next_steps must be a non-empty array of strings for ${transitionLabel} transition` };
  }

  return {
    issueNumber,
    fromStatus,
    failureClassification: failureClassification.trim(),
    failureMessage: failureMessage.trim(),
    suggestedNextSteps,
    runId,
  };
}

function parseBlockedRetryMetadata(body) {
  const issueNumber = body?.issue_number;
  const retryReason = body?.retry_reason;
  const failureClassification = body?.failure_classification;
  const failureErrorCode = body?.failure_error_code;
  const blockedMinutes = body?.blocked_minutes;
  const suggestedNextSteps = normalizeStringArray(body?.suggested_next_steps);
  const runId = isNonEmptyString(body?.run_id) ? body.run_id.trim() : "";

  if (!isPositiveInteger(issueNumber)) {
    return { error: "body.issue_number must be a positive integer for Blocked -> Ready transition" };
  }
  if (!isNonEmptyString(retryReason)) {
    return { error: "body.retry_reason is required for Blocked -> Ready transition" };
  }
  if (!isNonEmptyString(failureClassification)) {
    return { error: "body.failure_classification is required for Blocked -> Ready transition" };
  }
  if (!isNonEmptyString(failureErrorCode)) {
    return { error: "body.failure_error_code is required for Blocked -> Ready transition" };
  }
  if (!Number.isInteger(blockedMinutes) || blockedMinutes < 0) {
    return { error: "body.blocked_minutes must be a non-negative integer for Blocked -> Ready transition" };
  }
  if (suggestedNextSteps.length === 0) {
    return { error: "body.suggested_next_steps must be a non-empty array of strings for Blocked -> Ready transition" };
  }

  return {
    issueNumber,
    retryReason: retryReason.trim(),
    failureClassification: failureClassification.trim(),
    failureErrorCode: failureErrorCode.trim(),
    blockedMinutes,
    suggestedNextSteps,
    runId,
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
    const schema = JSON.parse(schemaFile.content);
    const requiredFields = Array.isArray(schema?.required_fields) ? schema.required_fields : [];
    const byName = new Map(requiredFields.map((field) => [field.name, field]));
    return { fieldsByName: byName };
  } catch {
    return { error: "invalid project schema policy JSON" };
  }
}

function validateFieldValueAgainstSchema({ fieldsByName, field, value }) {
  const schemaField = fieldsByName.get(field);
  if (!schemaField) {
    return { error: "field is not allowed by project schema policy" };
  }

  const fieldType = typeof schemaField.type === "string" ? schemaField.type.trim().toLowerCase() : "";
  if (fieldType !== "single_select") {
    return { error: "only single_select fields are supported" };
  }

  const options = Array.isArray(schemaField.allowed_options) ? schemaField.allowed_options : [];
  if (!options.includes(value)) {
    return { error: "value is not allowed for field by project schema policy" };
  }

  return { ok: true };
}

function hasStatusPermission({ canSetProjectFields, canUpdateStatusOnly, field }) {
  if (field === "Status") {
    return canSetProjectFields || canUpdateStatusOnly;
  }
  return canSetProjectFields;
}

export function buildInternalProjectItemUpdateFieldHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalProjectItemUpdateFieldHandler(request, reply) {
    const roleInput = request?.body?.role;
    const projectItemId = request?.body?.project_item_id;
    const field = request?.body?.field;
    const value = request?.body?.value;

    if (!isNonEmptyString(roleInput)) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    const normalizedRole = roleInput.trim().toUpperCase();
    if (!ROLE_TOKEN_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }

    if (!isNonEmptyString(projectItemId)) {
      reply.code(400);
      return { error: "body.project_item_id is required" };
    }
    if (!isNonEmptyString(field)) {
      reply.code(400);
      return { error: "body.field is required" };
    }
    if (!isNonEmptyString(value)) {
      reply.code(400);
      return { error: "body.value is required" };
    }

    const preflightReply = createReplyRecorder();
    const preflightResult = await resolvedPreflightHandler({ query: { role: normalizedRole } }, preflightReply);

    if (preflightReply.statusCode !== 200) {
      reply.code(preflightReply.statusCode);
      return preflightResult;
    }

    if (preflightResult?.status === "FAIL") {
      reply.code(409);
      return preflightResult;
    }

    let bundle;
    try {
      bundle = await loadAgentContextBundle({ repoRoot, role: normalizedRole });
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }
      throw error;
    }

    const schemaResult = parseProjectSchema(bundle);
    if (schemaResult.error) {
      reply.code(500);
      return { error: schemaResult.error };
    }

    const schemaValidation = validateFieldValueAgainstSchema({
      fieldsByName: schemaResult.fieldsByName,
      field,
      value,
    });
    if (schemaValidation.error) {
      reply.code(400);
      return { error: schemaValidation.error };
    }

    const canSetProjectFields = await isRoleAllowedForRepo(normalizedRole, "can_set_project_fields", { repoRoot });
    const canUpdateStatusOnly = await isRoleAllowedForRepo(normalizedRole, "can_update_status_only", { repoRoot });
    if (!hasStatusPermission({ canSetProjectFields, canUpdateStatusOnly, field })) {
      reply.code(403);
      return { error: "role is not allowed to update this project field" };
    }

    const projectIdentityResult = parseProjectIdentity(bundle);
    if (projectIdentityResult.error) {
      reply.code(500);
      return { error: projectIdentityResult.error };
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({
        repoRoot,
        projectIdentity: projectIdentityResult.projectIdentity,
      });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    let currentStatus = "";
    if (field === "Status") {
      try {
        currentStatus = await githubClient.getProjectItemFieldValue({
          projectItemId,
          field: "Status",
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }

      if (!isNonEmptyString(currentStatus)) {
        reply.code(400);
        return { error: "unable to resolve current status for transition validation" };
      }

      const transitionResult = await isStatusTransitionAllowedForRepo(normalizedRole, currentStatus, value, { repoRoot });
      if (!transitionResult.allowed) {
        reply.code(403);
        return {
          error: "status transition is not allowed by policy",
          from: currentStatus,
          to: value,
        };
      }
    }

    const requiresHumanApprovalHandoff =
      field === "Status" &&
      normalizedRole === ORCHESTRATOR_ROLE &&
      value === NEEDS_HUMAN_APPROVAL_STATUS &&
      currentStatus === IN_REVIEW_STATUS;
    const requiresHumanReworkHandoff =
      field === "Status" &&
      (normalizedRole === HUMAN_ROLE || normalizedRole === ORCHESTRATOR_ROLE) &&
      value === IN_REVIEW_STATUS &&
      currentStatus === NEEDS_HUMAN_APPROVAL_STATUS;
    const requiresExecutionFailureHandoff =
      field === "Status" &&
      normalizedRole === ORCHESTRATOR_ROLE &&
      value === BLOCKED_STATUS &&
      (currentStatus === IN_PROGRESS_STATUS || currentStatus === IN_REVIEW_STATUS);
    const requiresBlockedRetryHandoff =
      field === "Status" &&
      normalizedRole === ORCHESTRATOR_ROLE &&
      value === READY_STATUS &&
      currentStatus === BLOCKED_STATUS;
    let handoffMetadata = null;
    let humanReworkMetadata = null;
    let failureMetadata = null;
    let blockedRetryMetadata = null;
    if (requiresHumanApprovalHandoff) {
      handoffMetadata = parseNeedsHumanApprovalMetadata(request?.body);
      if (handoffMetadata.error) {
        reply.code(400);
        return { error: handoffMetadata.error };
      }
    }
    if (requiresHumanReworkHandoff) {
      humanReworkMetadata = parseHumanReworkMetadata(request?.body);
      if (humanReworkMetadata.error) {
        reply.code(400);
        return { error: humanReworkMetadata.error };
      }
    }
    if (requiresExecutionFailureHandoff) {
      failureMetadata = parseExecutionFailureBlockedMetadata(request?.body, { fromStatus: currentStatus });
      if (failureMetadata.error) {
        reply.code(400);
        return { error: failureMetadata.error };
      }
    }
    if (requiresBlockedRetryHandoff) {
      blockedRetryMetadata = parseBlockedRetryMetadata(request?.body);
      if (blockedRetryMetadata.error) {
        reply.code(400);
        return { error: blockedRetryMetadata.error };
      }
    }

    try {
      await githubClient.updateProjectItemField({
        projectItemId,
        field,
        value,
      });
    } catch (error) {
      reply.code(502);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    let handoffComment = null;
    if (handoffMetadata) {
      const commentBody = buildHumanApprovalComment({
        issueNumber: handoffMetadata.issueNumber,
        prUrl: handoffMetadata.prUrl,
        checksPerformed: handoffMetadata.checksPerformed,
        checksPassed: handoffMetadata.checksPassed,
        humanSteps: handoffMetadata.humanSteps,
        projectItemId,
        runId: handoffMetadata.runId,
      });
      try {
        handoffComment = await githubClient.createIssueComment({
          issueNumber: handoffMetadata.issueNumber,
          body: commentBody,
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    let failureComment = null;
    if (failureMetadata) {
      const commentBody = buildExecutionFailureBlockedComment({
        issueNumber: failureMetadata.issueNumber,
        fromStatus: failureMetadata.fromStatus,
        failureClassification: failureMetadata.failureClassification,
        failureMessage: failureMetadata.failureMessage,
        suggestedNextSteps: failureMetadata.suggestedNextSteps,
        projectItemId,
        runId: failureMetadata.runId,
      });
      try {
        failureComment = await githubClient.createIssueComment({
          issueNumber: failureMetadata.issueNumber,
          body: commentBody,
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    let humanReworkComment = null;
    if (humanReworkMetadata) {
      const commentBody = buildHumanReworkRequestComment({
        issueNumber: humanReworkMetadata.issueNumber,
        reworkReason: humanReworkMetadata.reworkReason,
        requestedActions: humanReworkMetadata.requestedActions,
        projectItemId,
        role: normalizedRole,
        runId: humanReworkMetadata.runId,
      });
      try {
        humanReworkComment = await githubClient.createIssueComment({
          issueNumber: humanReworkMetadata.issueNumber,
          body: commentBody,
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
    let blockedRetryComment = null;
    if (blockedRetryMetadata) {
      const commentBody = buildBlockedRetryComment({
        issueNumber: blockedRetryMetadata.issueNumber,
        retryReason: blockedRetryMetadata.retryReason,
        failureClassification: blockedRetryMetadata.failureClassification,
        failureErrorCode: blockedRetryMetadata.failureErrorCode,
        blockedMinutes: blockedRetryMetadata.blockedMinutes,
        suggestedNextSteps: blockedRetryMetadata.suggestedNextSteps,
        projectItemId,
        runId: blockedRetryMetadata.runId,
      });
      try {
        blockedRetryComment = await githubClient.createIssueComment({
          issueNumber: blockedRetryMetadata.issueNumber,
          body: commentBody,
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }

    const payload = {
      role: normalizedRole,
      project_item_id: projectItemId,
      updated: {
        [field]: value,
      },
      ...(handoffComment
        ? {
            handoff_comment: {
              id: handoffComment.id,
              html_url: handoffComment.html_url,
            },
          }
        : {}),
      ...(failureComment
        ? {
            failure_comment: {
              id: failureComment.id,
              html_url: failureComment.html_url,
            },
          }
        : {}),
      ...(humanReworkComment
        ? {
            rework_comment: {
              id: humanReworkComment.id,
              html_url: humanReworkComment.html_url,
            },
          }
        : {}),
      ...(blockedRetryComment
        ? {
            retry_comment: {
              id: blockedRetryComment.id,
              html_url: blockedRetryComment.html_url,
            },
          }
        : {}),
    };

    reply.code(200).type("application/json").send(payload);
    return;
  };
}

export async function registerInternalProjectItemUpdateFieldRoute(fastify, options = {}) {
  fastify.post("/internal/project-item/update-field", buildInternalProjectItemUpdateFieldHandler(options));
}
