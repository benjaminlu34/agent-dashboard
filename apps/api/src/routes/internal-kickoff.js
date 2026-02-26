import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflightCheck } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const GOAL_FILE_PATH = "goal.txt";
const KICKOFF_ROLE = "ORCHESTRATOR";

export function buildInternalKickoffHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck } = {}) {
  const resolvedPreflightCheck =
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }));

  return async function internalKickoffHandler(request, reply) {
    const goal = request?.body?.goal;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      reply.code(400);
      return { error: "body.goal must be a non-empty string" };
    }

    const { statusCode: preflightStatusCode, payload: preflightResult } = await resolvedPreflightCheck({
      role: KICKOFF_ROLE,
    });

    if (preflightStatusCode !== 200) {
      reply.code(preflightStatusCode);
      return preflightResult;
    }

    if (preflightResult?.status === "FAIL") {
      reply.code(409);
      return preflightResult;
    }

    await writeFile(resolve(repoRoot, GOAL_FILE_PATH), goal, "utf8");

    return {
      status: "success",
      message: "Goal Received.",
    };
  };
}

export async function registerInternalKickoffRoute(fastify, options = {}) {
  fastify.post("/internal/kickoff", buildInternalKickoffHandler(options));
}
