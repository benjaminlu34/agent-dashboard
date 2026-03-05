import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { readAgentSwarmTarget } from "../internal/agent-swarm-config.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { requireRepoKeyFromAgentSwarm } from "../internal/repo-key.js";
import { orchestratorLedgerKey, orchestratorRootKey } from "../internal/redis-keys.js";
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

function normalizeSprintPhase(value) {
  if (!isNonEmptyString(value)) {
    return "";
  }
  return value.trim().toUpperCase();
}

export function buildInternalSprintSealHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  redis,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalSprintSealHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }
    const { repoKey } = repoKeyResult;

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

    const runnerSprintPlanPath = resolveRunnerSprintPlanPathToken({ env });

    const root = await redisClient.hgetall(orchestratorRootKey(repoKey));
    const phase = normalizeSprintPhase(root?.sprint_phase);
    if (phase === "ACTIVE") {
      const ledger = await redisClient.hgetall(orchestratorLedgerKey(repoKey));
      const planVersion = typeof ledger?.["__meta__:plan_version"] === "string" ? ledger["__meta__:plan_version"] : "";
      if (!planVersion) {
        reply.code(409);
        return {
          error: "sprint_already_active",
          detail: "Runner ledger is missing or invalid; refusing to reseal an active sprint.",
        };
      }

      const runEntries = Object.entries(ledger).filter(
        ([key]) => !key.startsWith("__meta__:") && !key.startsWith("__task__:"),
      );
      if (runEntries.length > 0) {
        reply.code(409);
        return {
          error: "sprint_already_active",
          detail: "Runner ledger contains execution runs; reseal is not allowed once execution starts.",
        };
      }
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

    const generation = await generateRunnerStateFromProjectSprint({
      repoRoot,
      sprint: normalizedSprint,
      githubClient,
      redis: redisClient,
      repoKey,
      nowIso,
      runnerSprintPlanPath,
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
