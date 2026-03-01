import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { readAgentSwarmTarget } from "../internal/agent-swarm-config.js";
import { createGitHubPlanApplyClient, GitHubPlanApplyError } from "../internal/github-plan-apply-client.js";
import { generateRunnerStateFromProjectSprint } from "../internal/sprint-state-generator.js";
import { buildPreflightHandler } from "./internal-preflight.js";
import { resolveTargetIdentity, TargetIdentityError } from "../internal/target-identity.js";
import {
  buildRepoArchitectureMap,
  computeSprintPlanMetadata,
  formatScopeSection,
} from "../internal/sprint-ownership.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const PROJECT_SCHEMA_PATH = "policy/project-schema.json";
const DEFAULT_ORCHESTRATOR_STATE_PATH = "./.orchestrator-state.json";
const RUNNER_SPRINT_PLAN_PATH = "./.runner-sprint-plan.json";
const RUNNER_LEDGER_PATH = "./.runner-ledger.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStatePathToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveOrchestratorStatePath({ repoRoot, env, ownerLogin, repoName }) {
  const hasScopedIdentity = isNonEmptyString(ownerLogin) && isNonEmptyString(repoName);
  const defaultPath = hasScopedIdentity
    ? `./.orchestrator-state.${sanitizeStatePathToken(ownerLogin)}.${sanitizeStatePathToken(repoName)}.json`
    : DEFAULT_ORCHESTRATOR_STATE_PATH;
  const configuredPath = isNonEmptyString(env?.ORCHESTRATOR_STATE_PATH)
    ? env.ORCHESTRATOR_STATE_PATH.trim()
    : defaultPath;
  return resolve(repoRoot, configuredPath);
}

function resolveRunnerLedgerPathToken({ env, ownerLogin, repoName }) {
  const hasScopedIdentity = isNonEmptyString(ownerLogin) && isNonEmptyString(repoName);
  const defaultPath = hasScopedIdentity
    ? `./.runner-ledger.${sanitizeStatePathToken(ownerLogin)}.${sanitizeStatePathToken(repoName)}.json`
    : RUNNER_LEDGER_PATH;
  return isNonEmptyString(env?.RUNNER_LEDGER_PATH) ? env.RUNNER_LEDGER_PATH.trim() : defaultPath;
}

function resolveRunnerSprintPlanPathToken({ env }) {
  return isNonEmptyString(env?.RUNNER_SPRINT_PLAN_PATH)
    ? env.RUNNER_SPRINT_PLAN_PATH.trim()
    : RUNNER_SPRINT_PLAN_PATH;
}

function ensureStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry));
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

function parseProjectIdentityPolicyFromBundle(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    throw new GitHubPlanApplyError("missing project identity policy");
  }

  try {
    return JSON.parse(identityFile.content);
  } catch {
    throw new GitHubPlanApplyError("invalid project identity policy JSON");
  }
}

function normalizePolicyFieldType(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function normalizeAllowedOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .filter((option) => isNonEmptyString(option))
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

function parseProjectSchemaPolicyFromBundle(bundle) {
  const schemaFile = bundle.files.find((file) => file.path === PROJECT_SCHEMA_PATH);
  if (!schemaFile) {
    throw new GitHubPlanApplyError("missing project schema policy");
  }

  try {
    return JSON.parse(schemaFile.content);
  } catch {
    throw new GitHubPlanApplyError("invalid project schema policy JSON");
  }
}

function buildPlanApplySchemaPolicy(schemaPolicy) {
  const requiredFields = Array.isArray(schemaPolicy?.required_fields) ? schemaPolicy.required_fields : [];
  const getField = (name) => requiredFields.find((field) => field?.name === name);

  const requireSingleSelectOptions = (name) => {
    const field = getField(name);
    if (!field) {
      throw new GitHubPlanApplyError(`project schema policy missing ${name} field`);
    }
    const type = normalizePolicyFieldType(field.type);
    if (type !== "single_select") {
      throw new GitHubPlanApplyError(`project schema policy field must be single_select: ${name}`);
    }
    const options = normalizeAllowedOptions(field.allowed_options);
    if (options.length === 0) {
      throw new GitHubPlanApplyError(`project schema policy missing ${name}.allowed_options`);
    }
    return new Set(options);
  };

  const sprintField = getField("Sprint");
  if (!sprintField) {
    throw new GitHubPlanApplyError("project schema policy missing Sprint field");
  }
  const sprintType = normalizePolicyFieldType(sprintField.type);
  if (sprintType !== "single_select" && sprintType !== "text") {
    throw new GitHubPlanApplyError("project schema policy Sprint.type must be single_select or text");
  }
  const sprintOptions = sprintType === "single_select" ? normalizeAllowedOptions(sprintField.allowed_options) : [];
  if (sprintType === "single_select" && sprintOptions.length === 0) {
    throw new GitHubPlanApplyError("project schema policy missing Sprint.allowed_options");
  }

  return {
    statusOptions: requireSingleSelectOptions("Status"),
    sizeOptions: requireSingleSelectOptions("Size"),
    areaOptions: requireSingleSelectOptions("Area"),
    priorityOptions: requireSingleSelectOptions("Priority"),
    sprintType,
    sprintOptions: new Set(sprintOptions),
  };
}

function formatDependsOnFieldValue(dependsOn) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) {
    return "";
  }
  const tokens = [];
  for (const entry of dependsOn) {
    if (typeof entry === "number") {
      if (Number.isInteger(entry) && entry > 0) {
        tokens.push(String(entry));
      }
      continue;
    }

    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        tokens.push(trimmed);
      }
    }
  }
  return tokens.join(", ");
}

function normalizeIssue(issue) {
  const normalizedStatus = isNonEmptyString(issue?.initial_status) ? issue.initial_status : "Backlog";

  return {
    title: issue?.title,
    goal: issue?.goal,
    non_goals: issue?.non_goals,
    acceptance_criteria: issue?.acceptance_criteria,
    files_likely_touched: issue?.files_likely_touched,
    definition_of_done: issue?.definition_of_done,
    size: issue?.size,
    area: issue?.area,
    priority: issue?.priority,
    initial_status: normalizedStatus === "Ready" ? "Ready" : "Backlog",
    depends_on: issue?.depends_on,
    labels: issue?.labels,
  };
}

function validateDraftIssue(issue, index, schemaPolicy) {
  if (!isNonEmptyString(issue.title)) {
    return `draft.issues[${index}].title is required`;
  }
  if (!isNonEmptyString(issue.goal)) {
    return `draft.issues[${index}].goal is required`;
  }
  if (!ensureStringArray(issue.non_goals)) {
    return `draft.issues[${index}].non_goals must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.acceptance_criteria)) {
    return `draft.issues[${index}].acceptance_criteria must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.files_likely_touched)) {
    return `draft.issues[${index}].files_likely_touched must be a non-empty string array`;
  }
  if (!ensureStringArray(issue.definition_of_done)) {
    return `draft.issues[${index}].definition_of_done must be a non-empty string array`;
  }
  if (!schemaPolicy.sizeOptions.has(issue.size)) {
    return `draft.issues[${index}].size must be one of ${[...schemaPolicy.sizeOptions].join(", ")}`;
  }
  if (!schemaPolicy.areaOptions.has(issue.area)) {
    return `draft.issues[${index}].area must be one of ${[...schemaPolicy.areaOptions].join(", ")}`;
  }
  if (!schemaPolicy.priorityOptions.has(issue.priority)) {
    return `draft.issues[${index}].priority must be one of ${[...schemaPolicy.priorityOptions].join(", ")}`;
  }
  if (issue.initial_status !== "Backlog" && issue.initial_status !== "Ready") {
    return `draft.issues[${index}].initial_status must be Backlog or Ready`;
  }
  if (!schemaPolicy.statusOptions.has(issue.initial_status)) {
    return `draft.issues[${index}].initial_status must be one of ${[...schemaPolicy.statusOptions].join(", ")}`;
  }
  if (issue.depends_on !== undefined) {
    if (!Array.isArray(issue.depends_on)) {
      return `draft.issues[${index}].depends_on must be an array`;
    }
    for (let depIndex = 0; depIndex < issue.depends_on.length; depIndex += 1) {
      const dependency = issue.depends_on[depIndex];
      if (typeof dependency === "number") {
        if (!Number.isInteger(dependency) || dependency <= 0) {
          return `draft.issues[${index}].depends_on[${depIndex}] must be a positive integer`;
        }
        continue;
      }
      if (typeof dependency === "string") {
        if (dependency.trim().length === 0) {
          return `draft.issues[${index}].depends_on[${depIndex}] must be a non-empty string`;
        }
        continue;
      }
      return `draft.issues[${index}].depends_on[${depIndex}] must be a positive integer or non-empty string`;
    }
  }
  if (issue.labels !== undefined && !ensureStringArray(issue.labels)) {
    return `draft.issues[${index}].labels must be a non-empty string array`;
  }
  return "";
}

function toBulletList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function toCheckboxList(items) {
  return items.map((item) => `- [ ] ${item}`).join("\n");
}

function formatIssueBody(issue) {
  return [
    "## Goal",
    issue.goal,
    "",
    "## Non-goals",
    toBulletList(issue.non_goals),
    "",
    "## Acceptance Criteria",
    toCheckboxList(issue.acceptance_criteria),
    "",
    "## Files Likely Touched",
    toBulletList(issue.files_likely_touched),
    "",
    "## Definition of Done",
    toCheckboxList(issue.definition_of_done),
    "",
    "## Size",
    issue.size,
  ].join("\n");
}

function buildFieldValues({ draftSprint, issue }) {
  return {
    Status: issue.initial_status === "Ready" ? "Ready" : "Backlog",
    Size: issue.size,
    Area: issue.area,
    Priority: issue.priority,
    Sprint: draftSprint,
    DependsOn: formatDependsOnFieldValue(issue.depends_on),
  };
}

function buildPartialFailResponse({ created, index, step, error }) {
  return {
    status: "PARTIAL_FAIL",
    created,
    failed: {
      index,
      step,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function buildIssueTitle(rawTitle) {
  const trimmed = rawTitle.trim();
  if (trimmed.startsWith("[")) {
    return trimmed;
  }
  return `[TASK] ${trimmed}`;
}

async function readOrchestratorStateFile(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { poll_count: 0, items: {} };
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { poll_count: 0, items: {} };
    }
    throw error;
  }
}

async function writeOrchestratorStateFile(statePath, state) {
  const directoryPath = dirname(statePath);
  await mkdir(directoryPath, { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

export function buildInternalPlanApplyHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  preflightHandler,
  githubClientFactory = createGitHubPlanApplyClient,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });

  return async function internalPlanApplyHandler(request, reply) {
    const role = request?.body?.role;
    const draft = request?.body?.draft;

    if (typeof role !== "string" || role.trim().toUpperCase() !== "ORCHESTRATOR") {
      reply.code(400);
      return { error: "body.role must be ORCHESTRATOR" };
    }

    if (!draft || typeof draft !== "object") {
      reply.code(400);
      return { error: "body.draft is required" };
    }

    const sprint = draft.sprint;
    if (!isNonEmptyString(sprint)) {
      reply.code(400);
      return { error: "body.draft.sprint is required" };
    }

    let requireVerification = false;
    if (draft.require_verification !== undefined) {
      if (typeof draft.require_verification !== "boolean") {
        reply.code(400);
        return { error: "body.draft.require_verification must be a boolean" };
      }
      requireVerification = draft.require_verification;
    }

    if (!Array.isArray(draft.issues) || draft.issues.length === 0) {
      reply.code(400);
      return { error: "body.draft.issues must be a non-empty array" };
    }

    const preflightReply = createReplyRecorder();
    const preflight = await resolvedPreflightHandler({ query: { role: "ORCHESTRATOR" } }, preflightReply);

    if (preflightReply.statusCode !== 200) {
      reply.code(preflightReply.statusCode);
      return preflight;
    }

    if (preflight?.status === "FAIL") {
      reply.code(409);
      return preflight;
    }

    let bundle;
    try {
      bundle = await loadAgentContextBundle({ repoRoot, role: "ORCHESTRATOR" });
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

    let schemaPolicy;
    try {
      const schema = parseProjectSchemaPolicyFromBundle(bundle);
      schemaPolicy = buildPlanApplySchemaPolicy(schema);
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(500);
        return { error: error.message };
      }
      throw error;
    }

    const normalizedSprint = sprint.trim();
    if (schemaPolicy.sprintType === "single_select" && !schemaPolicy.sprintOptions.has(normalizedSprint)) {
      reply.code(400);
      return { error: `body.draft.sprint must be one of ${[...schemaPolicy.sprintOptions].join(", ")}` };
    }

    const normalizedIssues = draft.issues.map(normalizeIssue);
    for (let index = 0; index < normalizedIssues.length; index += 1) {
      const validationError = validateDraftIssue(normalizedIssues[index], index, schemaPolicy);
      if (validationError) {
        reply.code(400);
        return { error: validationError };
      }
    }

    let targetIdentity;
    let projectIdentity;
    try {
      const repoPolicy = parseProjectIdentityPolicyFromBundle(bundle);
      const agentSwarmTarget = await readAgentSwarmTarget({ repoRoot });
      const target = resolveTargetIdentity({ env, repoPolicy, agentSwarmTarget });
      targetIdentity = target;
      projectIdentity = {
        owner_login: target.owner_login,
        owner_type: target.owner_type,
        project_name: target.project_name,
        project_v2_number: target.project_v2_number,
        repository_name: target.repo_name,
      };
    } catch (error) {
      if (error instanceof TargetIdentityError) {
        reply.code(500);
        return { error: error.message, ...(error.details ?? {}) };
      }
      if (error instanceof GitHubPlanApplyError) {
        reply.code(500);
        return { error: error.message };
      }
      throw error;
    }

    let githubClient;
    try {
      githubClient = await githubClientFactory({ repoRoot, projectIdentity });
    } catch (error) {
      if (error instanceof GitHubPlanApplyError) {
        reply.code(502);
        return { error: error.message };
      }
      throw error;
    }

    let repoArchitecture;
    try {
      repoArchitecture = await buildRepoArchitectureMap({ githubClient });
    } catch {
      repoArchitecture = { buckets: [], shared_core_paths: new Set() };
    }

    const created = [];

    for (let index = 0; index < normalizedIssues.length; index += 1) {
      const issue = normalizedIssues[index];
      const fieldsSet = buildFieldValues({ draftSprint: normalizedSprint, issue });

      let createdIssue;
      try {
        createdIssue = await githubClient.createIssue({
          title: buildIssueTitle(issue.title),
          body: formatIssueBody(issue),
          ...(Array.isArray(issue.labels) ? { labels: issue.labels } : {}),
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "create_issue", error });
      }

      let projectItem;
      try {
        projectItem = await githubClient.addIssueToProject({
          issueNodeId: createdIssue.issue_node_id,
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "add_to_project", error });
      }

      try {
        await githubClient.setProjectFields({
          projectItemId: projectItem.project_item_id,
          values: fieldsSet,
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index, step: "set_project_fields", error });
      }

      created.push({
        index,
        issue_number: createdIssue.issue_number,
        issue_url: createdIssue.issue_url,
        project_item_id: projectItem.project_item_id,
        fields_set: fieldsSet,
      });
    }

    const issuesForScope = created.map((entry) => {
      const issue = normalizedIssues[entry.index];
      return {
        issue_number: entry.issue_number,
        plan_order: entry.index,
        title: buildIssueTitle(issue.title),
        priority: issue.priority,
        labels: issue.labels,
        files_likely_touched: issue.files_likely_touched,
      };
    });

    const { sprintPlan, ownershipIndex } = computeSprintPlanMetadata({
      issues: issuesForScope,
      buckets: repoArchitecture.buckets,
      sharedCorePaths: repoArchitecture.shared_core_paths,
    });

    for (const entry of created) {
      const issue = normalizedIssues[entry.index];
      const issueNumber = entry.issue_number;
      const meta = sprintPlan[String(issueNumber)];
      if (!meta) {
        continue;
      }

      try {
        await githubClient.updateIssue({
          issueNumber,
          body: `${formatIssueBody(issue)}\n\n${formatScopeSection({ meta, issueNumber })}\n`,
        });
      } catch (error) {
        reply.code(502);
        return buildPartialFailResponse({ created, index: entry.index, step: "update_issue_scope", error });
      }
    }

    const orchestratorStatePath = resolveOrchestratorStatePath({
      repoRoot,
      env,
      ownerLogin: targetIdentity?.owner_login,
      repoName: targetIdentity?.repo_name,
    });
    try {
      const state = await readOrchestratorStateFile(orchestratorStatePath);
      const next = {
        ...(state && typeof state === "object" ? state : {}),
        poll_count: Number.isInteger(state?.poll_count) && state.poll_count >= 0 ? state.poll_count : 0,
        items: state?.items && typeof state.items === "object" ? state.items : {},
        sprint_phase: "PENDING_VERIFICATION",
        sprint_plan: sprintPlan,
        ownership_index: ownershipIndex,
      };
      await writeOrchestratorStateFile(orchestratorStatePath, next);
    } catch (error) {
      reply.code(502);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    if (!requireVerification) {
      const runnerSprintPlanPath = resolveRunnerSprintPlanPathToken({ env });
      const runnerLedgerPath = resolveRunnerLedgerPathToken({
        env,
        ownerLogin: targetIdentity?.owner_login,
        repoName: targetIdentity?.repo_name,
      });

      const generation = await generateRunnerStateFromProjectSprint({
        repoRoot,
        sprint: normalizedSprint,
        githubClient,
        orchestratorStatePath,
        nowIso,
        fs: {
          mkdir,
          readFile,
          rename,
          writeFile,
        },
        runnerSprintPlanPath,
        runnerLedgerPath,
      });

      if (!generation.ok) {
        reply.code(generation.statusCode);
        return generation.payload;
      }
    }

    return {
      role: "ORCHESTRATOR",
      sprint: normalizedSprint,
      created,
      sprint_plan: sprintPlan,
      ownership_index: ownershipIndex,
      status: "APPLIED",
    };
  };
}

export async function registerInternalPlanApplyRoute(fastify, options = {}) {
  fastify.post("/internal/plan-apply", buildInternalPlanApplyHandler(options));
}
