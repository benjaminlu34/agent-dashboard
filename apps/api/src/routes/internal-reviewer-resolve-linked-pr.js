import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { resolveLinkedPullRequestForIssue, ReviewerPrLinkageError } from "../internal/reviewer-pr-linkage.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const ROLE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_IDENTITY_PATH = "policy/github-project.json";

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
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

export function buildInternalReviewerResolveLinkedPrHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalReviewerResolveLinkedPrHandler(request, reply) {
    const roleInput = request?.body?.role;
    const issueNumber = request?.body?.issue_number;

    if (!isNonEmptyString(roleInput)) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    const normalizedRole = roleInput.trim().toUpperCase();
    if (!ROLE_TOKEN_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }
    if (normalizedRole !== "REVIEWER") {
      reply.code(400);
      return { error: "body.role must be REVIEWER" };
    }
    if (!isPositiveInteger(issueNumber)) {
      reply.code(400);
      return { error: "body.issue_number must be a positive integer" };
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
      const linked = await resolveLinkedPullRequestForIssue({
        githubClient,
        issueNumber,
      });
      reply.code(200).type("application/json").send(linked);
      return;
    } catch (error) {
      if (error instanceof ReviewerPrLinkageError) {
        const details = error.details ?? {};
        const errorCode = typeof details.code === "string" && details.code.length > 0 ? details.code : "ambiguous_linked_pr";
        const { code: _ignoredCode, ...restDetails } = details;
        reply.code(409).type("application/json").send({
          error: errorCode,
          ...restDetails,
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

export async function registerInternalReviewerResolveLinkedPrRoute(fastify, options = {}) {
  fastify.post("/internal/reviewer/resolve-linked-pr", buildInternalReviewerResolveLinkedPrHandler(options));
}
