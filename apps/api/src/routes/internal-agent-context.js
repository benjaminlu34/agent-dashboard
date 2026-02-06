import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const UPPERCASE_ROLE_RE = /^[A-Z][A-Z0-9_]*$/;

export function buildAgentContextHandler({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return async function agentContextHandler(request, reply) {
    const role = request?.query?.role;

    if (typeof role !== "string" || role.trim().length === 0) {
      reply.code(400);
      return { error: "query parameter 'role' is required" };
    }

    const normalizedRole = role.toUpperCase();

    if (!UPPERCASE_ROLE_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }

    try {
      return await loadAgentContextBundle({ repoRoot, role: normalizedRole });
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
  };
}

export async function registerInternalAgentContextRoute(fastify, options = {}) {
  fastify.get("/internal/agent-context", buildAgentContextHandler(options));
}
