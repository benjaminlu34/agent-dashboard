import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { GitHubTemplateReadError, readTemplateMetadataFromGitHub } from "../internal/github-template-reader.js";
import { ProjectSchemaReadError, readProjectSchemaFromGitHub } from "../internal/policy/github-project-schema-reader.js";
import { compareProjectSchema } from "../internal/project-schema-compare.js";
import { resolveTargetIdentity, TargetIdentityError, toProjectSchemaIdentity } from "../internal/target-identity.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const UPPERCASE_ROLE_RE = /^[A-Z][A-Z0-9_]*$/;
const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/milestone-task.yml";
const PROJECT_IDENTITY_PATH = "policy/github-project.json";

function emptyTemplateMetadata(path = TEMPLATE_PATH) {
  return {
    path,
    size_bytes: 0,
    sha256: "",
  };
}

function parseProjectIdentityPolicy(bundle) {
  const projectIdentityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!projectIdentityFile) {
    return { error: "required project identity policy is missing" };
  }

  try {
    return { repoPolicy: JSON.parse(projectIdentityFile.content) };
  } catch {
    return { error: "project identity policy is not valid JSON" };
  }
}

function buildProjectIdentityFailure({ normalizedRole, bundleHash = "", message, templatePath = TEMPLATE_PATH, details = {} }) {
  return {
    role: normalizedRole,
    bundle_hash: bundleHash,
    template: emptyTemplateMetadata(templatePath),
    project_schema: {
      status: "FAIL",
      mismatches: [],
    },
    status: "FAIL",
    errors: [
      {
        source: "project_identity",
        path: PROJECT_IDENTITY_PATH,
        code: "target_identity_error",
        message,
        ...details,
      },
    ],
  };
}

export function buildPreflightHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  projectSchemaReader = readProjectSchemaFromGitHub,
  templateMetadataReader = readTemplateMetadataFromGitHub,
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
        return buildProjectIdentityFailure({
          normalizedRole,
          templatePath: typeof env?.TARGET_TEMPLATE_PATH === "string" ? env.TARGET_TEMPLATE_PATH : TEMPLATE_PATH,
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
      return buildProjectIdentityFailure({
        normalizedRole,
        bundleHash: bundle.bundle_hash,
        templatePath: typeof env?.TARGET_TEMPLATE_PATH === "string" ? env.TARGET_TEMPLATE_PATH : TEMPLATE_PATH,
        message: projectIdentityPolicy.error,
      });
    }

    let targetIdentity;
    try {
      targetIdentity = resolveTargetIdentity({
        env,
        repoPolicy: projectIdentityPolicy.repoPolicy,
      });
    } catch (error) {
      if (error instanceof TargetIdentityError) {
        return buildProjectIdentityFailure({
          normalizedRole,
          bundleHash: bundle.bundle_hash,
          templatePath: typeof env?.TARGET_TEMPLATE_PATH === "string" ? env.TARGET_TEMPLATE_PATH : TEMPLATE_PATH,
          message: error.message,
          details: error.details,
        });
      }
      throw error;
    }

    const policyProjectSchemaFile = bundle.files.find((file) => file.path === "policy/project-schema.json");
    const policyProjectSchema = JSON.parse(policyProjectSchemaFile.content);

    let projectSchemaComparison;
    let projectSchemaReadErrorMessage = null;
    try {
      const liveProjectSchema = await projectSchemaReader({
        projectIdentity: toProjectSchemaIdentity(targetIdentity),
      });
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

    let template = null;
    let templateError = null;
    try {
      template = await templateMetadataReader({
        owner_login: targetIdentity.owner_login,
        owner_type: targetIdentity.owner_type,
        repo_name: targetIdentity.repo_name,
        project_name: targetIdentity.project_name,
        path: targetIdentity.template_path,
        ref: targetIdentity.ref,
      });
    } catch (error) {
      if (error instanceof GitHubTemplateReadError) {
        templateError = error;
      } else {
        throw error;
      }
    }

    const errors = [];

    if (templateError) {
      errors.push({
        source: "template",
        path: targetIdentity.template_path,
        code: templateError.code,
        message: templateError.message,
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
      template: template ?? emptyTemplateMetadata(targetIdentity.template_path),
      project_schema: projectSchemaComparison,
      status: overallStatus,
      errors,
    };
  };
}

export async function registerInternalPreflightRoute(fastify, options = {}) {
  fastify.get("/internal/preflight", buildPreflightHandler(options));
}
