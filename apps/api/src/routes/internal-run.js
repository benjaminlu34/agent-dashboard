import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { getAllowedCapabilities, getRolePermissions } from "../internal/policy/enforcement.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const UPPERCASE_ROLE_RE = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_SCHEMA_PATH = "policy/project-schema.json";

function mapRequiredSchemaToLiveSchema(policySchema, fallbackProjectName) {
  const requiredFields = Array.isArray(policySchema?.required_fields) ? policySchema.required_fields : [];

  return {
    project_name: policySchema?.project_name ?? fallbackProjectName,
    fields: requiredFields
      .filter((field) => typeof field?.name === "string" && field.name.length > 0)
      .map((field) => ({
        name: field.name,
        type: field.type,
        options: Array.isArray(field.allowed_options) ? field.allowed_options : [],
      })),
  };
}

async function readProjectSchemaSnapshot({ repoRoot, projectName }) {
  const content = await readFile(resolve(repoRoot, PROJECT_SCHEMA_PATH), "utf8");
  const policySchema = JSON.parse(content);
  return mapRequiredSchemaToLiveSchema(policySchema, projectName);
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

export function buildInternalRunHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightHandler } = {}) {
  const resolvedPreflightHandler =
    preflightHandler ??
    buildPreflightHandler({
      repoRoot,
      // Runner v0 uses local policy snapshot only. Runner v1+ should switch back to live GitHub read-only preflight.
      projectSchemaReader: ({ projectName }) => readProjectSchemaSnapshot({ repoRoot, projectName }),
    });

  return async function internalRunHandler(request, reply) {
    const role = request?.body?.role;
    const task = request?.body?.task;

    if (typeof role !== "string" || role.trim().length === 0) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    if (typeof task !== "string" || task.trim().length === 0) {
      reply.code(400);
      return { error: "body.task is required" };
    }

    const normalizedRole = role.toUpperCase();
    if (!UPPERCASE_ROLE_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
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

    const rolePermissions = await getRolePermissions(normalizedRole, { repoRoot });
    const allowedCapabilitiesMinimal = await getAllowedCapabilities(normalizedRole, { repoRoot });

    return {
      role: normalizedRole,
      task,
      bundle_hash: bundle.bundle_hash,
      preflight: preflightResult,
      allowed_capabilities: rolePermissions,
      allowed_capabilities_minimal: allowedCapabilitiesMinimal,
      status: "READY",
    };
  };
}

export async function registerInternalRunRoute(fastify, options = {}) {
  fastify.post("/internal/run", buildInternalRunHandler(options));
}
