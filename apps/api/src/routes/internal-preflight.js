import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { ProjectSchemaReadError, readProjectSchemaFromGitHub } from "../internal/policy/github-project-schema-reader.js";
import { compareProjectSchema } from "../internal/project-schema-compare.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const UPPERCASE_ROLE_RE = /^[A-Z][A-Z0-9_]*$/;
const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/milestone-task.yml";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveProjectOwner(policyProjectSchema) {
  const directOwnerCandidates = [
    policyProjectSchema?.project_owner,
    policyProjectSchema?.owner_login,
    policyProjectSchema?.github_owner,
    policyProjectSchema?.owner,
  ];

  for (const candidate of directOwnerCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (typeof policyProjectSchema?.owner === "object" && policyProjectSchema.owner !== null) {
    const login = policyProjectSchema.owner.login;
    if (typeof login === "string" && login.trim().length > 0) {
      return login.trim();
    }
  }

  return undefined;
}

async function readTemplateMetadata(repoRoot) {
  const absolutePath = resolve(repoRoot, TEMPLATE_PATH);

  try {
    const content = await readFile(absolutePath, "utf8");
    return {
      path: TEMPLATE_PATH,
      size_bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function buildPreflightHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  projectSchemaReader = readProjectSchemaFromGitHub,
} = {}) {
  return async function preflightHandler(request, reply) {
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

    const policyProjectSchemaFile = bundle.files.find((file) => file.path === "policy/project-schema.json");
    const policyProjectSchema = JSON.parse(policyProjectSchemaFile.content);
    const projectName = policyProjectSchema.project_name;
    const projectOwner = resolveProjectOwner(policyProjectSchema);

    let projectSchemaComparison;
    let projectSchemaReadErrorMessage = null;
    try {
      const liveProjectSchema = await projectSchemaReader({ projectName, projectOwner });
      projectSchemaComparison = compareProjectSchema(policyProjectSchema, liveProjectSchema);
    } catch (error) {
      if (error instanceof ProjectSchemaReadError) {
        projectSchemaComparison = {
          status: "FAIL",
          mismatches: [],
        };
        projectSchemaReadErrorMessage = error.message;
      } else {
        throw error;
      }
    }

    const template = await readTemplateMetadata(repoRoot);
    const errors = [];

    if (!template) {
      errors.push({
        path: TEMPLATE_PATH,
        message: "required issue template is missing",
      });
    }

    if (projectSchemaComparison.status === "FAIL") {
      for (const mismatch of projectSchemaComparison.mismatches) {
        errors.push({
          source: "project_schema",
          ...mismatch,
        });
      }
    }

    if (projectSchemaReadErrorMessage) {
      errors.push({
        source: "project_schema",
        message: projectSchemaReadErrorMessage,
      });
    }

    const overallStatus = !template || projectSchemaComparison.status === "FAIL" ? "FAIL" : "PASS";

    return {
      role: normalizedRole,
      bundle_hash: bundle.bundle_hash,
      template: template ?? {
        path: TEMPLATE_PATH,
        size_bytes: 0,
        sha256: "",
      },
      project_schema: projectSchemaComparison,
      status: overallStatus,
      errors,
    };
  };
}

export async function registerInternalPreflightRoute(fastify, options = {}) {
  fastify.get("/internal/preflight", buildPreflightHandler(options));
}
