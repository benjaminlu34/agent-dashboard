import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import {
  isRoleAllowedForRepo,
  isStatusTransitionAllowedForRepo,
} from "../internal/policy/enforcement.js";
import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const ROLE_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_SCHEMA_PATH = "policy/project-schema.json";
const PROJECT_IDENTITY_PATH = "policy/github-project.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

function parseProjectIdentity(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    return { error: "missing project identity policy" };
  }

  try {
    const parsed = JSON.parse(identityFile.content);
    return { projectIdentity: parsed };
  } catch {
    return { error: "invalid project identity policy JSON" };
  }
}

function parseProjectSchema(bundle) {
  const schemaFile = bundle.files.find((file) => file.path === PROJECT_SCHEMA_PATH);
  if (!schemaFile) {
    return { error: "missing project schema policy" };
  }

  try {
    const schema = JSON.parse(schemaFile.content);
    const requiredFields = Array.isArray(schema?.required_fields) ? schema.required_fields : [];
    const byName = new Map(requiredFields.map((field) => [field.name, field]));
    return { fieldsByName: byName };
  } catch {
    return { error: "invalid project schema policy JSON" };
  }
}

function validateFieldValueAgainstSchema({ fieldsByName, field, value }) {
  const schemaField = fieldsByName.get(field);
  if (!schemaField) {
    return { error: "field is not allowed by project schema policy" };
  }

  const fieldType = typeof schemaField.type === "string" ? schemaField.type.trim().toLowerCase() : "";
  if (fieldType !== "single_select") {
    return { error: "only single_select fields are supported" };
  }

  const options = Array.isArray(schemaField.allowed_options) ? schemaField.allowed_options : [];
  if (!options.includes(value)) {
    return { error: "value is not allowed for field by project schema policy" };
  }

  return { ok: true };
}

function hasStatusPermission({ canSetProjectFields, canUpdateStatusOnly, field }) {
  if (field === "Status") {
    return canSetProjectFields || canUpdateStatusOnly;
  }
  return canSetProjectFields;
}

export function buildInternalProjectItemUpdateFieldHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalProjectItemUpdateFieldHandler(request, reply) {
    const roleInput = request?.body?.role;
    const projectItemId = request?.body?.project_item_id;
    const field = request?.body?.field;
    const value = request?.body?.value;

    if (!isNonEmptyString(roleInput)) {
      reply.code(400);
      return { error: "body.role is required" };
    }

    const normalizedRole = roleInput.trim().toUpperCase();
    if (!ROLE_TOKEN_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }

    if (!isNonEmptyString(projectItemId)) {
      reply.code(400);
      return { error: "body.project_item_id is required" };
    }
    if (!isNonEmptyString(field)) {
      reply.code(400);
      return { error: "body.field is required" };
    }
    if (!isNonEmptyString(value)) {
      reply.code(400);
      return { error: "body.value is required" };
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

    const schemaResult = parseProjectSchema(bundle);
    if (schemaResult.error) {
      reply.code(500);
      return { error: schemaResult.error };
    }

    const schemaValidation = validateFieldValueAgainstSchema({
      fieldsByName: schemaResult.fieldsByName,
      field,
      value,
    });
    if (schemaValidation.error) {
      reply.code(400);
      return { error: schemaValidation.error };
    }

    const canSetProjectFields = await isRoleAllowedForRepo(normalizedRole, "can_set_project_fields", { repoRoot });
    const canUpdateStatusOnly = await isRoleAllowedForRepo(normalizedRole, "can_update_status_only", { repoRoot });
    if (!hasStatusPermission({ canSetProjectFields, canUpdateStatusOnly, field })) {
      reply.code(403);
      return { error: "role is not allowed to update this project field" };
    }

    const projectIdentityResult = parseProjectIdentity(bundle);
    if (projectIdentityResult.error) {
      reply.code(500);
      return { error: projectIdentityResult.error };
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({
        repoRoot,
        projectIdentity: projectIdentityResult.projectIdentity,
      });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    if (field === "Status") {
      let currentStatus = "";
      try {
        currentStatus = await githubClient.getProjectItemFieldValue({
          projectItemId,
          field: "Status",
        });
      } catch (error) {
        reply.code(502);
        return { error: error instanceof Error ? error.message : String(error) };
      }

      if (!isNonEmptyString(currentStatus)) {
        reply.code(400);
        return { error: "unable to resolve current status for transition validation" };
      }

      const transitionResult = await isStatusTransitionAllowedForRepo(normalizedRole, currentStatus, value, { repoRoot });
      if (!transitionResult.allowed) {
        reply.code(403);
        return {
          error: "status transition is not allowed by policy",
          from: currentStatus,
          to: value,
        };
      }
    }

    try {
      await githubClient.updateProjectItemField({
        projectItemId,
        field,
        value,
      });
    } catch (error) {
      reply.code(502);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const payload = {
      role: normalizedRole,
      project_item_id: projectItemId,
      updated: {
        [field]: value,
      },
    };

    reply.code(200).type("application/json").send(payload);
    return;
  };
}

export async function registerInternalProjectItemUpdateFieldRoute(fastify, options = {}) {
  fastify.post("/internal/project-item/update-field", buildInternalProjectItemUpdateFieldHandler(options));
}
