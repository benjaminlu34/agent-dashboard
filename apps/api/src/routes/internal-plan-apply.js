import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { buildPreflightHandler } from "./internal-preflight.js";
import { resolveTargetIdentity, TargetIdentityError } from "../internal/target-identity.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const VALID_SPRINTS = new Set(["M1", "M2", "M3", "M4"]);
const VALID_SIZES = new Set(["S", "M", "L"]);
const VALID_AREAS = new Set(["db", "api", "web", "providers", "infra", "docs"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2"]);
const VALID_INITIAL_STATUSES = new Set(["Backlog", "Ready"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry));
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

function parseProjectIdentityPolicyFromBundle(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    throw new GitHubPlanApplyError("missing project identity policy");
  }

  try {
    return JSON.parse(identityFile.content);
  } catch {
    throw new GitHubPlanApplyError("invalid project identity policy JSON");
  }
}

function normalizeIssue(issue) {
  const normalizedStatus = isNonEmptyString(issue?.initial_status) ? issue.initial_status : "Backlog";

  return {
    title: issue?.title,
    goal: issue?.goal,
    non_goals: issue?.non_goals,
    acceptance_criteria: issue?.acceptance_criteria,
    files_likely_touched: issue?.files_likely_touched,
    definition_of_done: issue?.definition_of_done,
    size: issue?.size,
    area: issue?.area,
    priority: issue?.priority,
    initial_status: normalizedStatus === "Ready" ? "Ready" : "Backlog",
    labels: issue?.labels,
  };
}

function validateDraftIssue(issue, index) {
  if (!isNonEmptyString(issue.title)) {
    return `draft.issues[${index}].title is required`;
  }
  if (!isNonEmptyString(issue.goal)) {
    return `draft.issues[${index}].goal is required`;
  }
  if (!ensureStringArray(issue.non_goals)) {
    return `draft.issues[${index}].non_goals must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.acceptance_criteria)) {
    return `draft.issues[${index}].acceptance_criteria must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.files_likely_touched)) {
    return `draft.issues[${index}].files_likely_touched must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.definition_of_done)) {
    return `draft.issues[${index}].definition_of_done must be a non-empty string array`;
  }
  if (!VALID_SIZES.has(issue.size)) {
    return `draft.issues[${index}].size must be one of S, M, L`;
  }
  if (!VALID_AREAS.has(issue.area)) {
    return `draft.issues[${index}].area must be one of db, api, web, providers, infra, docs`;
  }
  if (!VALID_PRIORITIES.has(issue.priority)) {
    return `draft.issues[${index}].priority must be one of P0, P1, P2`;
  }
  if (!VALID_INITIAL_STATUSES.has(issue.initial_status)) {
    return `draft.issues[${index}].initial_status must be Backlog or Ready`;
  }
  if (issue.labels !== undefined && !ensureStringArray(issue.labels)) {
    return `draft.issues[${index}].labels must be a non-empty string array`;
  }
  return "";
}

function toBulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function toCheckboxList(items) {
  return items.map((item) => `- [ ] ${item}`).join("\n");
}

function formatIssueBody(issue) {
  return [
    "## Goal",
    issue.goal,
    "",
    "## Non-goals",
    toBulletList(issue.non_goals),
    "",
    "## Acceptance Criteria",
    toCheckboxList(issue.acceptance_criteria),
    "",
    "## Files Likely Touched",
    toBulletList(issue.files_likely_touched),
    "",
    "## Definition of Done",
    toCheckboxList(issue.definition_of_done),
    "",
    "## Size",
    issue.size,
  ].join("\n");
}

function buildFieldValues({ draftSprint, issue }) {
  return {
    Status: issue.initial_status === "Ready" ? "Ready" : "Backlog",
    Size: issue.size,
    Area: issue.area,
    Priority: issue.priority,
    Sprint: draftSprint,
  };
}

function buildPartialFailResponse({ created, index, step, error }) {
  return {
    status: "PARTIAL_FAIL",
    created,
    failed: {
      index,
      step,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function buildIssueTitle(rawTitle) {
  const trimmed = rawTitle.trim();
  if (trimmed.startsWith("[")) {
    return trimmed;
  }
  return `[TASK] ${trimmed}`;
}

export function buildInternalPlanApplyHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalPlanApplyHandler(request, reply) {
    const role = request?.body?.role;
    const draft = request?.body?.draft;

    if (typeof role !== "string" || role.trim().toUpperCase() !== "ORCHESTRATOR") {
      reply.code(400);
      return { error: "body.role must be ORCHESTRATOR" };
    }

    if (!draft || typeof draft !== "object") {
      reply.code(400);
      return { error: "body.draft is required" };
    }

    const sprint = draft.sprint;
    if (typeof sprint !== "string" || !VALID_SPRINTS.has(sprint)) {
      reply.code(400);
      return { error: "body.draft.sprint must be one of M1, M2, M3, M4" };
    }

    if (!Array.isArray(draft.issues) || draft.issues.length === 0) {
      reply.code(400);
      return { error: "body.draft.issues must be a non-empty array" };
    }

    const normalizedIssues = draft.issues.map(normalizeIssue);
    for (let index = 0; index < normalizedIssues.length; index += 1) {
      const validationError = validateDraftIssue(normalizedIssues[index], index);
      if (validationError) {
        reply.code(400);
        return { error: validationError };
      }
    }

    const preflightReply = createReplyRecorder();
    const preflight = await resolvedPreflightHandler({ query: { role: "ORCHESTRATOR" } }, preflightReply);

    if (preflightReply.statusCode !== 200) {
      reply.code(preflightReply.statusCode);
      return preflight;
    }

    if (preflight?.status === "FAIL") {
      reply.code(409);
      return preflight;
    }

    let bundle;
    try {
      bundle = await loadAgentContextBundle({ repoRoot, role: "ORCHESTRATOR" });
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

    let projectIdentity;
    try {
      const repoPolicy = parseProjectIdentityPolicyFromBundle(bundle);
      const target = resolveTargetIdentity({ env, repoPolicy });
      projectIdentity = {
        owner_login: target.owner_login,
        owner_type: target.owner_type,
        project_name: target.project_name,
        repository_name: target.repo_name,
      };
    } catch (error) {
      if (error instanceof TargetIdentityError) {
        reply.code(500);
        return { error: error.message, ...(error.details ?? {}) };
      }
      if (error instanceof GitHubPlanApplyError) {
        reply.code(500);
        return { error: error.message };
      }
      throw error;
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({ repoRoot, projectIdentity });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    const created = [];

    for (let index = 0; index < normalizedIssues.length; index += 1) {
      const issue = normalizedIssues[index];
      const fieldsSet = buildFieldValues({ draftSprint: sprint, issue });

      let createdIssue;
      try {
        createdIssue = await githubClient.createIssue({
          title: buildIssueTitle(issue.title),
          body: formatIssueBody(issue),
          ...(Array.isArray(issue.labels) ? { labels: issue.labels } : {}),
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "create_issue", error });
      }

      let projectItem;
      try {
        projectItem = await githubClient.addIssueToProject({
          issueNodeId: createdIssue.issue_node_id,
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "add_to_project", error });
      }

      try {
        await githubClient.setProjectFields({
          projectItemId: projectItem.project_item_id,
          values: fieldsSet,
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "set_project_fields", error });
      }

      created.push({
        index,
        issue_number: createdIssue.issue_number,
        issue_url: createdIssue.issue_url,
        project_item_id: projectItem.project_item_id,
        fields_set: fieldsSet,
      });
    }

    return {
      role: "ORCHESTRATOR",
      sprint,
      created,
      status: "APPLIED",
    };
  };
}

export async function registerInternalPlanApplyRoute(fastify, options = {}) {
  fastify.post("/internal/plan-apply", buildInternalPlanApplyHandler(options));
}
