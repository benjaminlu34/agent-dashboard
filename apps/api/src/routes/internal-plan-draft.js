import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { generatePlanDraft, PlanDraftGenerationError } from "../internal/plan-draft-generator.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const VALID_SPRINTS = new Set(["M1", "M2", "M3", "M4"]);

function createReplyRecorder() {
  return {
    statusCode: 200,
    code(nextStatusCode) {
      this.statusCode = nextStatusCode;
      return this;
    },
  };
}

export function buildInternalPlanDraftHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightHandler,
  planDraftGenerator = generatePlanDraft,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalPlanDraftHandler(request, reply) {
    const role = request?.body?.role;
    const sprint = request?.body?.sprint;
    const goal = request?.body?.goal;

    if (typeof role !== "string" || role.trim().length === 0) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    const normalizedRole = role.trim().toUpperCase();
    if (normalizedRole !== "PLANNER") {
      reply.code(400);
      return { error: "body.role must be PLANNER" };
    }

    if (typeof sprint !== "string" || !VALID_SPRINTS.has(sprint)) {
      reply.code(400);
      return { error: "body.sprint must be one of M1, M2, M3, M4" };
    }

    if (typeof goal !== "string" || goal.trim().length === 0) {
      reply.code(400);
      return { error: "body.goal is required" };
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

    let draft;
    try {
      draft = await planDraftGenerator({
        role: normalizedRole,
        sprint,
        goal: goal.trim(),
        bundle,
      });
    } catch (error) {
      if (error instanceof PlanDraftGenerationError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    return {
      role: normalizedRole,
      sprint,
      goal: goal.trim(),
      bundle_hash: bundle.bundle_hash,
      preflight: preflightResult,
      draft,
      status: "DRAFT_READY",
    };
  };
}

export async function registerInternalPlanDraftRoute(fastify, options = {}) {
  fastify.post("/internal/plan-draft", buildInternalPlanDraftHandler(options));
}
