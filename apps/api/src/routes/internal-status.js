import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireRepoKeyFromAgentSwarm } from "../internal/repo-key.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");

function safeJsonParse(value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

function toNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export function buildInternalStatusHandler({ repoRoot = DEFAULT_REPO_ROOT, redis } = {}) {
  return async function internalStatusHandler(_request, reply) {
    const redisClient = redis ?? _request?.redis;
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

    const { repoKey, targetIdentity } = repoKeyResult;
    reply.header("x-target-owner", targetIdentity.owner);
    reply.header("x-target-repo", targetIdentity.repo);

    const rootKey = `orchestrator:state:${repoKey}:root`;
    const itemsKey = `orchestrator:state:${repoKey}:items`;
    const ledgerKey = `orchestrator:ledger:${repoKey}`;

    const [root, itemsRaw, ledgerRaw] = await Promise.all([
      redisClient.hgetall(rootKey),
      redisClient.hgetall(itemsKey),
      redisClient.hgetall(ledgerKey),
    ]);

    const rootEmpty = !root || typeof root !== "object" || Object.keys(root).length === 0;
    const items = {};
    if (itemsRaw && typeof itemsRaw === "object") {
      for (const [projectItemId, raw] of Object.entries(itemsRaw)) {
        const parsed = safeJsonParse(raw, null);
        if (parsed) {
          items[projectItemId] = parsed;
        }
      }
    }

    const rootPollCount = toNonNegativeInt(root?.poll_count, 0);
    const sprintPlan = safeJsonParse(root?.sprint_plan, {});
    const ownershipIndex = safeJsonParse(root?.ownership_index, {});

    const orchestrator =
      rootEmpty && Object.keys(items).length === 0
        ? {}
        : {
            poll_count: rootPollCount,
            sprint_phase: typeof root?.sprint_phase === "string" ? root.sprint_phase : "",
            sealed_at: typeof root?.sealed_at === "string" ? root.sealed_at : "",
            daemon_status: typeof root?.daemon_status === "string" ? root.daemon_status : "",
            daemon_mode: typeof root?.daemon_mode === "string" ? root.daemon_mode : "",
            daemon_pid: typeof root?.daemon_pid === "string" ? root.daemon_pid : "",
            daemon_started_at: typeof root?.daemon_started_at === "string" ? root.daemon_started_at : "",
            daemon_heartbeat_at: typeof root?.daemon_heartbeat_at === "string" ? root.daemon_heartbeat_at : "",
            sprint_plan: sprintPlan,
            ownership_index: ownershipIndex,
            items,
          };

    const runs = {};
    let planVersion = "";
    if (ledgerRaw && typeof ledgerRaw === "object") {
      for (const [key, raw] of Object.entries(ledgerRaw)) {
        if (key.startsWith("__meta__:")) {
          if (key === "__meta__:plan_version") {
            planVersion = typeof raw === "string" ? raw : "";
          }
          continue;
        }
        if (key.startsWith("__task__:")) {
          continue;
        }
        const parsed = safeJsonParse(raw, null);
        if (parsed) {
          runs[key] = parsed;
        }
      }
    }
    const runner =
      Object.keys(runs).length === 0 && !planVersion
        ? {}
        : {
            plan_version: planVersion,
            runs,
          };

    return {
      orchestrator,
      runner,
    };
  };
}

export async function registerInternalStatusRoute(fastify, options = {}) {
  fastify.get("/internal/status", buildInternalStatusHandler(options));
}
