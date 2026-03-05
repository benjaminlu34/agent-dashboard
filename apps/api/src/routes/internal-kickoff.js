import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflightCheck } from "./internal-preflight.js";
import { requireRepoKeyFromAgentSwarm } from "../internal/repo-key.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const KICKOFF_ROLE = "ORCHESTRATOR";
const SPRINT_RE = /^M[1-4]$/;
const DEFAULT_READY_LIMIT = 3;

function normalizeSprint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return SPRINT_RE.test(normalized) ? normalized : null;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveRootStateKey(repoKey) {
  return `orchestrator:state:${repoKey}:root`;
}

function resolveControlKey(repoKey) {
  return `orchestrator:control:${repoKey}`;
}

async function enqueueControl(redis, repoKey, payload) {
  await redis.lpush(resolveControlKey(repoKey), JSON.stringify(payload));
}

export function buildInternalKickoffHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck, redis } = {}) {
  const resolvedPreflightCheck =
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }));

  return async function internalKickoffHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    const goal = request?.body?.goal;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      reply.code(400);
      return { error: "body.goal must be a non-empty string" };
    }

    const preflightFailure = await validateKickoffPreflight({ preflightCheck: resolvedPreflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }

    const { repoKey } = repoKeyResult;
    await redisClient.hset(resolveRootStateKey(repoKey), { kickoff_goal: goal.trim() });

    return {
      status: "success",
      message: "Goal Received.",
    };
  };
}

async function validateKickoffPreflight({ preflightCheck }) {
  const { statusCode: preflightStatusCode, payload: preflightResult } = await preflightCheck({
    role: KICKOFF_ROLE,
  });

  if (preflightStatusCode !== 200) {
    return { statusCode: preflightStatusCode, payload: preflightResult };
  }

  if (preflightResult?.status === "FAIL") {
    return { statusCode: 409, payload: preflightResult };
  }

  return null;
}

function resolvePreflightCheck({ preflightCheck, repoRoot }) {
  return (
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }))
  );
}

export function buildInternalKickoffStartLoopHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck, redis } = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });

  return async function internalKickoffStartLoopHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    const sprint = normalizeSprint(request?.body?.sprint);
    if (!sprint) {
      reply.code(400);
      return { error: "body.sprint must be one of M1, M2, M3, or M4" };
    }

    const requireVerificationRaw = request?.body?.require_verification;
    if (requireVerificationRaw !== undefined && typeof requireVerificationRaw !== "boolean") {
      reply.code(400);
      return { error: "body.require_verification must be a boolean" };
    }

    const preflightFailure = await validateKickoffPreflight({ preflightCheck: resolvedPreflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }

    const { repoKey } = repoKeyResult;
    const goal = await redisClient.hget(resolveRootStateKey(repoKey), "kickoff_goal");
    if (!hasNonEmptyString(goal)) {
      reply.code(400);
      return { error: "kickoff goal is missing; save a kickoff goal first" };
    }

    await enqueueControl(redisClient, repoKey, {
      command: "START",
      mode: "KICKOFF",
      sprint,
      require_verification: requireVerificationRaw === true,
      ready_limit: DEFAULT_READY_LIMIT,
      goal: goal.trim(),
    });

    reply.code(202);
    return {
      status: "ENQUEUED",
      message: "Kickoff loop start request enqueued.",
      sprint,
    };
  };
}

export function buildInternalRunnerStartLoopHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck, redis } = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });

  return async function internalRunnerStartLoopHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    const sprint = normalizeSprint(request?.body?.sprint);
    if (!sprint) {
      reply.code(400);
      return { error: "body.sprint must be one of M1, M2, M3, or M4" };
    }

    const preflightFailure = await validateKickoffPreflight({ preflightCheck: resolvedPreflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }

    const { repoKey } = repoKeyResult;
    await enqueueControl(redisClient, repoKey, {
      command: "START",
      mode: "RUNNER",
      sprint,
    });

    reply.code(202);
    return {
      status: "ENQUEUED",
      message: "Runner loop start request enqueued.",
      sprint,
    };
  };
}

export function buildInternalKickoffStopLoopHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck, redis } = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });

  return async function internalKickoffStopLoopHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    // Stop remains available even if project preflight is failing; operators use stop-loop to recover.
    const { statusCode: preflightStatusCode, payload: preflightResult } = await resolvedPreflightCheck({
      role: KICKOFF_ROLE,
    });
    if (preflightStatusCode !== 200) {
      reply.code(preflightStatusCode);
      return preflightResult;
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }

    await enqueueControl(redisClient, repoKeyResult.repoKey, { command: "STOP" });
    reply.code(202);
    return { status: "ENQUEUED" };
  };
}

export function buildInternalRunnerStopLoopHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck, redis } = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });

  return async function internalRunnerStopLoopHandler(request, reply) {
    const redisClient = redis ?? request?.redis;
    if (!redisClient) {
      reply.code(500);
      return { error: "redis client is not configured" };
    }

    const { statusCode: preflightStatusCode, payload: preflightResult } = await resolvedPreflightCheck({
      role: KICKOFF_ROLE,
    });
    if (preflightStatusCode !== 200) {
      reply.code(preflightStatusCode);
      return preflightResult;
    }

    let repoKeyResult;
    try {
      repoKeyResult = await requireRepoKeyFromAgentSwarm({ repoRoot });
    } catch (error) {
      reply.code(500);
      return { error: error instanceof Error ? error.message : "unable to resolve repo key" };
    }

    await enqueueControl(redisClient, repoKeyResult.repoKey, { command: "STOP" });
    reply.code(202);
    return { status: "ENQUEUED" };
  };
}

export async function registerInternalKickoffRoute(fastify, options = {}) {
  fastify.post("/internal/kickoff", buildInternalKickoffHandler(options));
  fastify.post("/internal/kickoff/start-loop", buildInternalKickoffStartLoopHandler(options));
  fastify.post("/internal/runner/start-loop", buildInternalRunnerStartLoopHandler(options));
  fastify.post("/internal/kickoff/stop-loop", buildInternalKickoffStopLoopHandler(options));
  fastify.post("/internal/runner/stop-loop", buildInternalRunnerStopLoopHandler(options));
}

