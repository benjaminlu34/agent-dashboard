import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { readAgentSwarmTarget } from "../internal/agent-swarm-config.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { generateRunnerStateFromProjectSprint } from "../internal/sprint-state-generator.js";
import { resolveTargetIdentity, TargetIdentityError } from "../internal/target-identity.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const DEFAULT_ORCHESTRATOR_STATE_PATH = "./.orchestrator-state.json";
const RUNNER_SPRINT_PLAN_PATH = "./.runner-sprint-plan.json";
const RUNNER_LEDGER_PATH = "./.runner-ledger.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStatePathToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveOrchestratorStatePath({ repoRoot, env, ownerLogin, repoName }) {
  const hasScopedIdentity = isNonEmptyString(ownerLogin) && isNonEmptyString(repoName);
  const defaultPath = hasScopedIdentity
    ? `./.orchestrator-state.${sanitizeStatePathToken(ownerLogin)}.${sanitizeStatePathToken(repoName)}.json`
    : DEFAULT_ORCHESTRATOR_STATE_PATH;
  const configuredPath = isNonEmptyString(env?.ORCHESTRATOR_STATE_PATH)
    ? env.ORCHESTRATOR_STATE_PATH.trim()
    : defaultPath;
  return resolve(repoRoot, configuredPath);
}

function resolveRunnerLedgerPathToken({ env, ownerLogin, repoName }) {
  const hasScopedIdentity = isNonEmptyString(ownerLogin) && isNonEmptyString(repoName);
  const defaultPath = hasScopedIdentity
    ? `./.runner-ledger.${sanitizeStatePathToken(ownerLogin)}.${sanitizeStatePathToken(repoName)}.json`
    : RUNNER_LEDGER_PATH;
  return isNonEmptyString(env?.RUNNER_LEDGER_PATH) ? env.RUNNER_LEDGER_PATH.trim() : defaultPath;
}

function resolveRunnerSprintPlanPathToken({ env }) {
  return isNonEmptyString(env?.RUNNER_SPRINT_PLAN_PATH)
    ? env.RUNNER_SPRINT_PLAN_PATH.trim()
    : RUNNER_SPRINT_PLAN_PATH;
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

export function buildInternalSprintSealHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalSprintSealHandler(request, reply) {
    const body = request?.body;
    const sprint = body?.sprint;

    if (!isNonEmptyString(sprint)) {
      reply.code(400);
      return { error: "body.sprint is required" };
    }

    const role = body?.role;
    if (role !== undefined && (!isNonEmptyString(role) || role.trim().toUpperCase() !== "ORCHESTRATOR")) {
      reply.code(400);
      return { error: "body.role must be ORCHESTRATOR when provided" };
    }

    const normalizedSprint = sprint.trim();

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

    let targetIdentity;
    let projectIdentity;
    try {
      const repoPolicy = parseProjectIdentityPolicyFromBundle(bundle);
      const agentSwarmTarget = await readAgentSwarmTarget({ repoRoot });
      const target = resolveTargetIdentity({ env, repoPolicy, agentSwarmTarget });
      targetIdentity = target;
      projectIdentity = {
        owner_login: target.owner_login,
        owner_type: target.owner_type,
        project_name: target.project_name,
        project_v2_number: target.project_v2_number,
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

    const orchestratorStatePath = resolveOrchestratorStatePath({
      repoRoot,
      env,
      ownerLogin: targetIdentity?.owner_login,
      repoName: targetIdentity?.repo_name,
    });

    const runnerSprintPlanPath = resolveRunnerSprintPlanPathToken({ env });
    const runnerLedgerPath = resolveRunnerLedgerPathToken({
      env,
      ownerLogin: targetIdentity?.owner_login,
      repoName: targetIdentity?.repo_name,
    });

    const generation = await generateRunnerStateFromProjectSprint({
      repoRoot,
      sprint: normalizedSprint,
      githubClient,
      orchestratorStatePath,
      nowIso,
      runnerSprintPlanPath,
      runnerLedgerPath,
    });

    if (!generation.ok) {
      reply.code(generation.statusCode);
      return generation.payload;
    }

    return {
      status: "SEALED",
      plan_version: generation.plan_version,
    };
  };
}

export async function registerInternalSprintSealRoute(fastify, options = {}) {
  fastify.post("/internal/sprint/seal", buildInternalSprintSealHandler(options));
}
