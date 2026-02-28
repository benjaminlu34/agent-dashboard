import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { readAgentSwarmTarget } from "../internal/agent-swarm-config.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { resolveTargetIdentity, TargetIdentityError } from "../internal/target-identity.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const ORCHESTRATOR_ROLE = "ORCHESTRATOR";
const GITHUB_API_BASE_URL = "https://api.github.com";
const ROLE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parsePositiveIntegerQueryParam(rawValue, paramName) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return { error: `query parameter '${paramName}' is required` };
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: `query parameter '${paramName}' must be a positive integer` };
  }

  return { value: parsed };
}

function parseRequiredRoleQueryParam(rawValue) {
  if (!hasNonEmptyString(rawValue)) {
    return { error: "query parameter 'role' is required" };
  }
  const normalizedRole = rawValue.trim().toUpperCase();
  if (!ROLE_TOKEN_RE.test(normalizedRole)) {
    return { error: "role must be a valid filename token (letters, digits, underscore)" };
  }
  return { value: normalizedRole };
}

function parseOptionalNonEmptyQueryParam(rawValue, paramName) {
  if (rawValue === undefined) {
    return { value: null };
  }
  if (!hasNonEmptyString(rawValue)) {
    return { error: `query parameter '${paramName}' must be a non-empty string when provided` };
  }
  return { value: rawValue.trim() };
}

function parseProjectIdentityPolicy(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    return { error: "required project identity policy is missing" };
  }

  try {
    return { repoPolicy: JSON.parse(identityFile.content) };
  } catch {
    return { error: "project identity policy is not valid JSON" };
  }
}

function readGitHubToken(env) {
  if (!hasNonEmptyString(env?.GITHUB_TOKEN)) {
    return "";
  }
  return env.GITHUB_TOKEN.trim();
}

function buildClientIdentity(targetIdentity) {
  const hasProjectNumber = Number.isInteger(targetIdentity.project_v2_number) && targetIdentity.project_v2_number > 0;
  return {
    owner_login: targetIdentity.owner_login,
    owner_type: targetIdentity.owner_type,
    project_name: targetIdentity.project_name,
    ...(hasProjectNumber ? { project_v2_number: targetIdentity.project_v2_number } : {}),
    repository_name: targetIdentity.repo_name,
  };
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

function sanitizeLabel(label) {
  if (hasNonEmptyString(label)) {
    return label.trim();
  }
  if (hasNonEmptyString(label?.name)) {
    return label.name.trim();
  }
  return null;
}

function sanitizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels.map((label) => sanitizeLabel(label)).filter((label) => label !== null);
}

function sanitizeAssignee(assignee) {
  if (!assignee || typeof assignee !== "object" || !hasNonEmptyString(assignee.login)) {
    return null;
  }

  return {
    login: assignee.login.trim(),
  };
}

function sanitizeAssignees(assignees) {
  if (!Array.isArray(assignees)) {
    return [];
  }

  return assignees
    .map((assignee) => sanitizeAssignee(assignee))
    .filter((assignee) => assignee !== null);
}

function sanitizeDate(value) {
  return hasNonEmptyString(value) ? value.trim() : null;
}

function sanitizeHtmlUrl(value) {
  return hasNonEmptyString(value) ? value.trim() : null;
}

function sanitizeIssuePayload(payload) {
  return {
    number: Number.isInteger(payload?.number) ? payload.number : null,
    title: typeof payload?.title === "string" ? payload.title : "",
    body: typeof payload?.body === "string" ? payload.body : "",
    state: hasNonEmptyString(payload?.state) ? payload.state.trim() : "",
    labels: sanitizeLabels(payload?.labels),
    assignee: sanitizeAssignee(payload?.assignee),
    assignees: sanitizeAssignees(payload?.assignees),
    html_url: sanitizeHtmlUrl(payload?.html_url),
    created_at: sanitizeDate(payload?.created_at),
    updated_at: sanitizeDate(payload?.updated_at),
    closed_at: sanitizeDate(payload?.closed_at),
  };
}

function sanitizeGitRef(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const ref = hasNonEmptyString(payload.ref) ? payload.ref.trim() : null;
  const sha = hasNonEmptyString(payload.sha) ? payload.sha.trim() : null;
  if (!ref && !sha) {
    return null;
  }

  return { ref, sha };
}

function sanitizePullRequestPayload(payload) {
  return {
    ...sanitizeIssuePayload(payload),
    draft: Boolean(payload?.draft),
    merged_at: sanitizeDate(payload?.merged_at),
    head: sanitizeGitRef(payload?.head),
    base: sanitizeGitRef(payload?.base),
  };
}

function sanitizeProjectItemPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (!hasNonEmptyString(payload.project_item_id) || !Number.isInteger(payload.issue_number) || payload.issue_number <= 0) {
    return null;
  }

  return {
    project_item_id: payload.project_item_id.trim(),
    issue_number: payload.issue_number,
    issue_title: hasNonEmptyString(payload.issue_title) ? payload.issue_title.trim() : "",
    issue_url: hasNonEmptyString(payload.issue_url) ? payload.issue_url.trim() : "",
    status: hasNonEmptyString(payload.fields?.Status) ? payload.fields.Status.trim() : "",
    sprint: hasNonEmptyString(payload.fields?.Sprint) ? payload.fields.Sprint.trim() : "",
  };
}

async function requestGitHubJson({
  url,
  githubToken,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      payload: null,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

async function resolveMetadataTargetIdentity({ repoRoot, env }) {
  const bundle = await loadAgentContextBundle({
    repoRoot,
    role: ORCHESTRATOR_ROLE,
  });

  const parsedPolicy = parseProjectIdentityPolicy(bundle);
  if (parsedPolicy.error) {
    throw new Error(parsedPolicy.error);
  }

  const agentSwarmTarget = await readAgentSwarmTarget({ repoRoot });
  return resolveTargetIdentity({
    env,
    repoPolicy: parsedPolicy.repoPolicy,
    agentSwarmTarget,
  });
}

function buildNotFoundResponse({
  resourceType,
  number,
  targetIdentity,
}) {
  return {
    error: "not_found",
    resource: resourceType,
    number,
    owner_login: targetIdentity.owner_login,
    repo_name: targetIdentity.repo_name,
  };
}

export function buildIssueMetadataHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  fetchImpl = fetch,
  apiBaseUrl = GITHUB_API_BASE_URL,
} = {}) {
  return async function issueMetadataHandler(request, reply) {
    const parsedIssueNumber = parsePositiveIntegerQueryParam(request?.query?.issue_number, "issue_number");
    if (parsedIssueNumber.error) {
      reply.code(400);
      return { error: parsedIssueNumber.error };
    }

    const githubToken = readGitHubToken(env);
    if (!githubToken) {
      reply.code(500);
      return { error: "GITHUB_TOKEN is required" };
    }

    let targetIdentity;
    try {
      targetIdentity = await resolveMetadataTargetIdentity({ repoRoot, env });
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }

      if (error instanceof TargetIdentityError) {
        reply.code(500);
        return {
          error: error.message,
          ...error.details,
        };
      }

      if (error instanceof Error) {
        reply.code(500);
        return { error: error.message };
      }

      throw error;
    }

    const requestUrl =
      `${apiBaseUrl.replace(/\/+$/u, "")}/repos/${encodeURIComponent(targetIdentity.owner_login)}` +
      `/${encodeURIComponent(targetIdentity.repo_name)}/issues/${parsedIssueNumber.value}`;
    const result = await requestGitHubJson({
      url: requestUrl,
      githubToken,
      fetchImpl,
    });

    if (!result.ok) {
      if (result.status === 404) {
        reply.code(404);
        return buildNotFoundResponse({
          resourceType: "issue",
          number: parsedIssueNumber.value,
          targetIdentity,
        });
      }

      reply.code(502);
      return {
        error: "github_request_failed",
        status: result.status,
        message: hasNonEmptyString(result.payload?.message)
          ? result.payload.message
          : `GitHub request failed (HTTP ${result.status || 0})`,
      };
    }

    return {
      issue: sanitizeIssuePayload(result.payload),
    };
  };
}

export function buildPullRequestMetadataHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  fetchImpl = fetch,
  apiBaseUrl = GITHUB_API_BASE_URL,
} = {}) {
  return async function pullRequestMetadataHandler(request, reply) {
    const parsedPrNumber = parsePositiveIntegerQueryParam(request?.query?.pr_number, "pr_number");
    if (parsedPrNumber.error) {
      reply.code(400);
      return { error: parsedPrNumber.error };
    }

    const githubToken = readGitHubToken(env);
    if (!githubToken) {
      reply.code(500);
      return { error: "GITHUB_TOKEN is required" };
    }

    let targetIdentity;
    try {
      targetIdentity = await resolveMetadataTargetIdentity({ repoRoot, env });
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }

      if (error instanceof TargetIdentityError) {
        reply.code(500);
        return {
          error: error.message,
          ...error.details,
        };
      }

      if (error instanceof Error) {
        reply.code(500);
        return { error: error.message };
      }

      throw error;
    }

    const requestUrl =
      `${apiBaseUrl.replace(/\/+$/u, "")}/repos/${encodeURIComponent(targetIdentity.owner_login)}` +
      `/${encodeURIComponent(targetIdentity.repo_name)}/pulls/${parsedPrNumber.value}`;
    const result = await requestGitHubJson({
      url: requestUrl,
      githubToken,
      fetchImpl,
    });

    if (!result.ok) {
      if (result.status === 404) {
        reply.code(404);
        return buildNotFoundResponse({
          resourceType: "pull_request",
          number: parsedPrNumber.value,
          targetIdentity,
        });
      }

      reply.code(502);
      return {
        error: "github_request_failed",
        status: result.status,
        message: hasNonEmptyString(result.payload?.message)
          ? result.payload.message
          : `GitHub request failed (HTTP ${result.status || 0})`,
      };
    }

    return {
      pr: sanitizePullRequestPayload(result.payload),
    };
  };
}

export function buildProjectItemsMetadataHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function projectItemsMetadataHandler(request, reply) {
    const parsedRole = parseRequiredRoleQueryParam(request?.query?.role);
    if (parsedRole.error) {
      reply.code(400);
      return { error: parsedRole.error };
    }
    if (parsedRole.value !== ORCHESTRATOR_ROLE) {
      reply.code(400);
      return { error: "query parameter 'role' must be ORCHESTRATOR" };
    }

    const parsedSprint = parseOptionalNonEmptyQueryParam(request?.query?.sprint, "sprint");
    if (parsedSprint.error) {
      reply.code(400);
      return { error: parsedSprint.error };
    }

    const preflightReply = createReplyRecorder();
    const preflightResult = await resolvedPreflightHandler({ query: { role: parsedRole.value } }, preflightReply);
    if (preflightReply.statusCode !== 200) {
      reply.code(preflightReply.statusCode);
      return preflightResult;
    }
    if (preflightResult?.status === "FAIL") {
      reply.code(409);
      return preflightResult;
    }

    let targetIdentity;
    try {
      targetIdentity = await resolveMetadataTargetIdentity({ repoRoot, env });
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }

      if (error instanceof TargetIdentityError) {
        reply.code(500);
        return {
          error: error.message,
          ...error.details,
        };
      }

      if (error instanceof Error) {
        reply.code(500);
        return { error: error.message };
      }

      throw error;
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({
        repoRoot,
        projectIdentity: buildClientIdentity(targetIdentity),
      });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    try {
      const allItems = await githubClient.listProjectItems();
      if (!Array.isArray(allItems)) {
        reply.code(502);
        return { error: "github project items response is invalid" };
      }
      const sanitizedItems = allItems
        .map((item) => sanitizeProjectItemPayload(item))
        .filter((item) => item !== null)
        .filter((item) => (parsedSprint.value ? item.sprint === parsedSprint.value : true))
        .sort((left, right) => {
          if (left.issue_number !== right.issue_number) {
            return left.issue_number - right.issue_number;
          }
          return left.project_item_id.localeCompare(right.project_item_id);
        });

      return {
        role: ORCHESTRATOR_ROLE,
        sprint: parsedSprint.value,
        as_of: new Date().toISOString(),
        items: sanitizedItems,
      };
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }
  };
}

export async function registerInternalMetadataRoute(fastify, options = {}) {
  fastify.get("/internal/metadata/issue", buildIssueMetadataHandler(options));
  fastify.get("/internal/metadata/pr", buildPullRequestMetadataHandler(options));
  fastify.get("/internal/metadata/project-items", buildProjectItemsMetadataHandler(options));
}
