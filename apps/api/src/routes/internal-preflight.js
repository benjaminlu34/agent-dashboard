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
const PROJECT_IDENTITY_PATH = "policy/github-project.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function emptyTemplateMetadata() {
  return {
    path: TEMPLATE_PATH,
    size_bytes: 0,
    sha256: "",
  };
}

function normalizeOwnerType(ownerType) {
  if (typeof ownerType !== "string") {
    return "";
  }

  const normalized = ownerType.trim().toLowerCase();
  if (normalized === "organization") {
    return "org";
  }
  return normalized;
}

function parseProjectIdentityPolicy(bundle) {
  const projectIdentityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!projectIdentityFile) {
    return { error: "required project identity policy is missing" };
  }

  let parsed;
  try {
    parsed = JSON.parse(projectIdentityFile.content);
  } catch {
    return { error: "project identity policy is not valid JSON" };
  }

  const ownerLogin = typeof parsed?.owner_login === "string" ? parsed.owner_login.trim() : "";
  const ownerType = normalizeOwnerType(parsed?.owner_type);
  const projectName = typeof parsed?.project_name === "string" ? parsed.project_name.trim() : "";

  if (!ownerLogin || !projectName || (ownerType !== "user" && ownerType !== "org")) {
    return {
      error: "project identity policy must define owner_login, owner_type (user|org), and project_name",
    };
  }

  return {
    projectIdentity: {
      owner_login: ownerLogin,
      owner_type: ownerType,
      project_name: projectName,
    },
  };
}

async function buildProjectIdentityFailure({ repoRoot, normalizedRole, bundleHash = "", message }) {
  const template = await readTemplateMetadata(repoRoot);

  return {
    role: normalizedRole,
    bundle_hash: bundleHash,
    template: template ?? emptyTemplateMetadata(),
    project_schema: {
      status: "FAIL",
      mismatches: [],
    },
    status: "FAIL",
    errors: [
      {
        source: "project_identity",
        path: PROJECT_IDENTITY_PATH,
        message,
      },
    ],
  };
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
      if (error instanceof AgentContextBundleError && error?.details?.path === PROJECT_IDENTITY_PATH) {
        return await buildProjectIdentityFailure({
          repoRoot,
          normalizedRole,
          message:
            error.message === "policy file is not valid JSON"
              ? "project identity policy is not valid JSON"
              : "required project identity policy is missing",
        });
      }

      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }
      throw error;
    }

    const projectIdentityPolicy = parseProjectIdentityPolicy(bundle);
    if (projectIdentityPolicy.error) {
      return await buildProjectIdentityFailure({
        repoRoot,
        normalizedRole,
        bundleHash: bundle.bundle_hash,
        message: projectIdentityPolicy.error,
      });
    }

    const policyProjectSchemaFile = bundle.files.find((file) => file.path === "policy/project-schema.json");
    const policyProjectSchema = JSON.parse(policyProjectSchemaFile.content);

    let projectSchemaComparison;
    let projectSchemaReadErrorMessage = null;
    try {
      const liveProjectSchema = await projectSchemaReader({ projectIdentity: projectIdentityPolicy.projectIdentity });
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
      template: template ?? emptyTemplateMetadata(),
      project_schema: projectSchemaComparison,
      status: overallStatus,
      errors,
    };
  };
}

export async function registerInternalPreflightRoute(fastify, options = {}) {
  fastify.get("/internal/preflight", buildPreflightHandler(options));
}
