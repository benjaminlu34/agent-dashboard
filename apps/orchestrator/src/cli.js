import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadAgentContextBundle } from "../../api/src/internal/agent-context-loader.js";
import { createGitHubPlanApplyClient } from "../../api/src/internal/github-plan-apply-client.js";
import { resolveTargetIdentity, TargetIdentityError } from "../../api/src/internal/target-identity.js";
import { buildRunPlan } from "./intents.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../");
const DEFAULT_BACKEND_BASE_URL = "http://localhost:4000";
const DEFAULT_MAX_EXECUTORS = 2;
const DEFAULT_MAX_REVIEWERS = 2;
const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_STALL_MINUTES = 120;
const DEFAULT_REVIEW_CHURN_POLLS = 3;
const DEFAULT_REVIEWER_RETRY_POLLS = 20;
const DEFAULT_MAX_REVIEWER_DISPATCHES_PER_STATUS = 2;
const DEFAULT_STATE_PATH = "./.orchestrator-state.json";
const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";

function emptyOrchestratorState() {
  return {
    poll_count: 0,
    items: {},
    sprint_plan: {},
    ownership_index: {},
  };
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStatePathToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function buildScopedStatePath(owner, repo) {
  if (!hasNonEmptyString(owner) || !hasNonEmptyString(repo)) {
    return DEFAULT_STATE_PATH;
  }
  const ownerToken = sanitizeStatePathToken(owner);
  const repoToken = sanitizeStatePathToken(repo);
  if (!ownerToken || !repoToken) {
    return DEFAULT_STATE_PATH;
  }
  return `./.orchestrator-state.${ownerToken}.${repoToken}.json`;
}

async function resolveDefaultStatePath({ cwd = process.cwd() } = {}) {
  const configPath = resolve(cwd, AGENT_SWARM_CONFIG_PATH);
  let rawConfig;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return DEFAULT_STATE_PATH;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = YAML.parse(rawConfig) ?? {};
  } catch {
    return DEFAULT_STATE_PATH;
  }

  const target = parsed?.target;
  if (!target || typeof target !== "object") {
    return DEFAULT_STATE_PATH;
  }

  return buildScopedStatePath(target.owner, target.repo);
}

function withErrorCode(error, code) {
  error.code = code;
  return error;
}

function isLikelyNetworkFetchError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  if (message.includes("fetch failed") || message.includes("network")) {
    return true;
  }
  const causeCode = typeof error.cause?.code === "string" ? error.cause.code : "";
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
  ].includes(causeCode);
}

function toTransientNetworkError(error, prefix) {
  const detail = error instanceof Error ? error.message : String(error);
  return withErrorCode(new Error(`${prefix}: ${detail}`), "transient_network_error");
}

function parsePositiveIntEnv(name, fallback, env) {
  const rawValue = env[name];
  if (!hasNonEmptyString(rawValue)) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw withErrorCode(new Error(`${name} must be a positive integer`), "validation_failed");
  }

  return parsed;
}

function parseNonNegativeIntEnv(name, fallback, env) {
  const rawValue = env[name];
  if (!hasNonEmptyString(rawValue)) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw withErrorCode(new Error(`${name} must be a non-negative integer`), "validation_failed");
  }

  return parsed;
}

function parseProjectIdentityPolicy(bundle) {
  const projectIdentityFile = bundle.files.find((file) => file.path === "policy/github-project.json");
  if (!projectIdentityFile) {
    throw withErrorCode(new Error("missing project identity policy"), "target_identity_error");
  }

  try {
    return JSON.parse(projectIdentityFile.content);
  } catch {
    throw withErrorCode(new Error("invalid project identity policy JSON"), "target_identity_error");
  }
}

function parseProjectSchema(bundle) {
  const schemaFile = bundle.files.find((file) => file.path === "policy/project-schema.json");
  if (!schemaFile) {
    throw withErrorCode(new Error("missing project schema policy"), "preflight_failed");
  }

  let schema;
  try {
    schema = JSON.parse(schemaFile.content);
  } catch {
    throw withErrorCode(new Error("invalid project schema policy JSON"), "preflight_failed");
  }

  const requiredFields = Array.isArray(schema?.required_fields) ? schema.required_fields : [];

  const statusField = requiredFields.find((field) => field?.name === "Status");
  const statusOptions = Array.isArray(statusField?.allowed_options) ? statusField.allowed_options : [];
  if (statusOptions.length === 0) {
    throw withErrorCode(new Error("project schema policy missing Status.allowed_options"), "preflight_failed");
  }

  const sprintField = requiredFields.find((field) => field?.name === "Sprint");
  const sprintOptions = Array.isArray(sprintField?.allowed_options) ? sprintField.allowed_options : [];
  if (sprintOptions.length === 0) {
    throw withErrorCode(new Error("project schema policy missing Sprint.allowed_options"), "preflight_failed");
  }

  return {
    statusOptions,
    sprintOptions,
  };
}

function parseArgs(argv) {
  let runMode = "once";
  for (const arg of argv) {
    if (arg === "--loop") {
      runMode = "loop";
    } else if (arg === "--once") {
      runMode = "once";
    }
  }
  return { runMode };
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toIsoTimestamp(value) {
  if (!hasNonEmptyString(value)) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

function isAfterIso(leftValue, rightValue) {
  const left = toIsoTimestamp(leftValue);
  const right = toIsoTimestamp(rightValue);
  if (!left || !right) {
    return false;
  }
  return new Date(left).getTime() > new Date(right).getTime();
}

export function mergeRunnerManagedStateFields({ nextState, diskState }) {
  if (!nextState || typeof nextState !== "object") {
    return nextState;
  }
  const nextItems = nextState.items && typeof nextState.items === "object" ? nextState.items : {};
  const diskItems = diskState?.items && typeof diskState.items === "object" ? diskState.items : {};
  const mergedItems = { ...nextItems };
  const sprintPlan = nextState?.sprint_plan && typeof nextState.sprint_plan === "object" ? nextState.sprint_plan : diskState?.sprint_plan;
  const ownershipIndex =
    nextState?.ownership_index && typeof nextState.ownership_index === "object" ? nextState.ownership_index : diskState?.ownership_index;

  for (const [projectItemId, nextItem] of Object.entries(nextItems)) {
    if (!nextItem || typeof nextItem !== "object") {
      continue;
    }
    const diskItem = diskItems[projectItemId];
    if (!diskItem || typeof diskItem !== "object") {
      continue;
    }

    const sameStatusEpoch =
      nextItem.last_seen_status === diskItem.last_seen_status &&
      Number.isInteger(nextItem.status_since_poll) &&
      Number.isInteger(diskItem.status_since_poll) &&
      nextItem.status_since_poll === diskItem.status_since_poll;
    if (!sameStatusEpoch) {
      continue;
    }

    const merged = { ...nextItem };

    const nextReviewCycleCount =
      Number.isInteger(nextItem.review_cycle_count) && nextItem.review_cycle_count >= 0 ? nextItem.review_cycle_count : 0;
    const diskReviewCycleCount =
      Number.isInteger(diskItem.review_cycle_count) && diskItem.review_cycle_count >= 0 ? diskItem.review_cycle_count : 0;
    merged.review_cycle_count = Math.max(nextReviewCycleCount, diskReviewCycleCount);

    const nextReviewerFeedbackAt = toIsoTimestamp(nextItem.last_reviewer_feedback_at);
    const diskReviewerFeedbackAt = toIsoTimestamp(diskItem.last_reviewer_feedback_at);
    if (diskReviewerFeedbackAt && (!nextReviewerFeedbackAt || isAfterIso(diskReviewerFeedbackAt, nextReviewerFeedbackAt))) {
      merged.last_reviewer_feedback_at = diskReviewerFeedbackAt;
      if (hasNonEmptyString(diskItem.last_reviewer_outcome)) {
        merged.last_reviewer_outcome = String(diskItem.last_reviewer_outcome).trim().toUpperCase();
      }
    } else if (nextReviewerFeedbackAt) {
      merged.last_reviewer_feedback_at = nextReviewerFeedbackAt;
      if (hasNonEmptyString(nextItem.last_reviewer_outcome)) {
        merged.last_reviewer_outcome = String(nextItem.last_reviewer_outcome).trim().toUpperCase();
      }
    }

    const nextExecutorResponseAt = toIsoTimestamp(nextItem.last_executor_response_at);
    const diskExecutorResponseAt = toIsoTimestamp(diskItem.last_executor_response_at);
    if (diskExecutorResponseAt && (!nextExecutorResponseAt || isAfterIso(diskExecutorResponseAt, nextExecutorResponseAt))) {
      merged.last_executor_response_at = diskExecutorResponseAt;
    } else if (nextExecutorResponseAt) {
      merged.last_executor_response_at = nextExecutorResponseAt;
    }

    const nextInReviewOrigin = hasNonEmptyString(nextItem.in_review_origin) ? String(nextItem.in_review_origin).trim() : "";
    const diskInReviewOrigin = hasNonEmptyString(diskItem.in_review_origin) ? String(diskItem.in_review_origin).trim() : "";
    if (nextItem.last_seen_status === "In Review") {
      merged.in_review_origin = nextInReviewOrigin || diskInReviewOrigin;
    } else {
      merged.in_review_origin = "";
    }

    mergedItems[projectItemId] = merged;
  }

  return {
    poll_count: Number.isInteger(nextState.poll_count) ? nextState.poll_count : 0,
    items: mergedItems,
    sprint_plan: sprintPlan && typeof sprintPlan === "object" ? sprintPlan : {},
    ownership_index: ownershipIndex && typeof ownershipIndex === "object" ? ownershipIndex : {},
  };
}

async function runPreflight({ backendBaseUrl }) {
  let response;
  try {
    response = await fetch(`${backendBaseUrl}/internal/preflight?role=ORCHESTRATOR`);
  } catch (error) {
    if (isLikelyNetworkFetchError(error)) {
      throw toTransientNetworkError(error, "preflight network request failed");
    }
    throw error;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw withErrorCode(new Error(`preflight request failed: HTTP ${response.status}`), "preflight_failed");
  }

  if (!payload || payload.status === "FAIL") {
    const isTransientExhausted = Array.isArray(payload?.errors)
      ? payload.errors.some((entry) => entry?.code === "template_fetch_transient_exhausted")
      : false;
    const details = payload ? JSON.stringify(payload) : "empty payload";
    throw withErrorCode(
      new Error(`preflight failed for ORCHESTRATOR: ${details}`),
      isTransientExhausted ? "transient_retries_exhausted" : "preflight_failed",
    );
  }
}

async function readProjectItems({ githubClient, env }) {
  const itemsFixturePath = env.ORCHESTRATOR_ITEMS_FILE;
  if (hasNonEmptyString(itemsFixturePath)) {
    const fixtureContent = await readFile(resolve(process.cwd(), itemsFixturePath), "utf8");
    let fixture = null;
    try {
      fixture = JSON.parse(fixtureContent);
    } catch (error) {
      throw withErrorCode(
        new Error(
          `ORCHESTRATOR_ITEMS_FILE must contain valid JSON array: ${error instanceof Error ? error.message : String(error)}`,
        ),
        "validation_failed",
      );
    }
    if (!Array.isArray(fixture)) {
      throw withErrorCode(new Error("ORCHESTRATOR_ITEMS_FILE must contain a JSON array"), "validation_failed");
    }
    return fixture;
  }

  if (!githubClient || typeof githubClient.listProjectItems !== "function") {
    throw withErrorCode(new Error("github client is required when ORCHESTRATOR_ITEMS_FILE is not set"), "validation_failed");
  }

  try {
    return await githubClient.listProjectItems();
  } catch (error) {
    if (isLikelyNetworkFetchError(error)) {
      throw toTransientNetworkError(error, "listProjectItems network request failed");
    }
    throw error;
  }
}

async function readStateFile(statePath) {
  function stateParseError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  try {
    const raw = await readFile(statePath, "utf8");
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw stateParseError("state_invalid_json", "state file contains invalid JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      throw stateParseError("state_invalid_object", "state file must be a JSON object");
    }

    return {
      poll_count: Number.isInteger(parsed.poll_count) && parsed.poll_count >= 0 ? parsed.poll_count : 0,
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
      sprint_plan: parsed.sprint_plan && typeof parsed.sprint_plan === "object" ? parsed.sprint_plan : {},
      ownership_index: parsed.ownership_index && typeof parsed.ownership_index === "object" ? parsed.ownership_index : {},
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyOrchestratorState();
    }

    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "state_invalid_json" || code === "state_invalid_object") {
      const backupPath = `${statePath}.corrupt-${Date.now()}`;
      let backupCreated = false;
      try {
        await rename(statePath, backupPath);
        backupCreated = true;
      } catch {
        backupCreated = false;
      }

      process.stderr.write(
        `${JSON.stringify({
          type: "ORCHESTRATOR_STATE_RESET_INVALID_JSON",
          path: statePath,
          backup_path: backupCreated ? backupPath : "",
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
      return emptyOrchestratorState();
    }

    throw withErrorCode(
      new Error(`failed to load state file ${statePath}: ${error instanceof Error ? error.message : String(error)}`),
      "validation_failed",
    );
  }
}

async function writeStateFile(statePath, state) {
  const directoryPath = dirname(statePath);
  await mkdir(directoryPath, { recursive: true });

  const tempPath = `${statePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

function writeDispatchSummary(summary) {
  process.stderr.write(`${JSON.stringify({ type: "DISPATCH_SUMMARY", ...summary })}\n`);
}

function writeEndOfSprintSummary(summary) {
  process.stderr.write(
    `${JSON.stringify({
      type: "END_OF_SPRINT_SUMMARY",
      sprint: summary.sprint,
      status_counts: summary.status_counts,
      processed_items: summary.processed_items,
      awaiting_humans:
        "No Ready/In Progress/In Review items remain in Sprint; humans should process Needs Human Approval items, merge approved PRs, verify deployment, and move items to Done.",
    })}\n`,
  );
}

function resolveSprint(env) {
  const sprint = env.ORCHESTRATOR_SPRINT;
  if (!hasNonEmptyString(sprint)) {
    throw withErrorCode(new Error("ORCHESTRATOR_SPRINT is required"), "validation_failed");
  }
  return sprint.trim();
}

function buildClientIdentity(targetIdentity) {
  return {
    owner_login: targetIdentity.owner_login,
    owner_type: targetIdentity.owner_type,
    project_name: targetIdentity.project_name,
    repository_name: targetIdentity.repo_name,
  };
}

async function runCycle({
  repoRoot,
  backendBaseUrl,
  maxExecutors,
  maxReviewers,
  sprint,
  stallMinutes,
  reviewChurnPolls,
  previousState,
  env,
}) {
  await runPreflight({ backendBaseUrl });

  const bundle = await loadAgentContextBundle({ repoRoot, role: "ORCHESTRATOR" });
  const repoPolicy = parseProjectIdentityPolicy(bundle);
  const projectSchema = parseProjectSchema(bundle);

  let targetIdentity;
  try {
    targetIdentity = resolveTargetIdentity({ env, repoPolicy });
  } catch (error) {
    if (error instanceof TargetIdentityError) {
      const missing = Array.isArray(error?.details?.missing) && error.details.missing.length > 0
        ? ` (missing: ${error.details.missing.join(", ")})`
        : "";
      throw withErrorCode(new Error(`${error.message}${missing}`), "target_identity_error");
    }
    throw error;
  }

  if (!projectSchema.sprintOptions.includes(sprint)) {
    throw withErrorCode(new Error(`ORCHESTRATOR_SPRINT=${sprint} is not allowed by policy/project-schema.json`), "malformed_item_data");
  }

  const useFixtureItems = hasNonEmptyString(env.ORCHESTRATOR_ITEMS_FILE);
  const githubClient = useFixtureItems
    ? null
    : await createGitHubPlanApplyClient({
        repoRoot,
        projectIdentity: buildClientIdentity(targetIdentity),
      });

  const projectItems = await readProjectItems({ githubClient, env });
  return buildRunPlan({
    projectItems,
    allowedStatusOptions: projectSchema.statusOptions,
    maxExecutors,
    maxReviewers,
    sprint,
    previousState,
    stallMinutes,
    reviewChurnPolls,
    maxReviewerDispatchesPerStatus: parsePositiveIntEnv(
      "ORCHESTRATOR_MAX_REVIEWER_DISPATCHES_PER_STATUS",
      DEFAULT_MAX_REVIEWER_DISPATCHES_PER_STATUS,
      env,
    ),
    reviewerRetryPolls: parseNonNegativeIntEnv(
      "ORCHESTRATOR_REVIEWER_RETRY_POLLS",
      DEFAULT_REVIEWER_RETRY_POLLS,
      env,
    ),
  });
}

function resolveExitCode(error) {
  if (error?.code === "transient_retries_exhausted" || error?.code === "transient_network_error") {
    return 4;
  }
  if (error?.code === "malformed_item_data") {
    return 3;
  }
  if (error?.code === "preflight_failed" || error?.code === "target_identity_error" || error?.code === "validation_failed") {
    return 2;
  }
  return 2;
}

export async function runOrchestratorCli({
  argv = process.argv.slice(2),
  repoRoot = process.env.ORCHESTRATOR_REPO_ROOT || DEFAULT_REPO_ROOT,
  backendBaseUrl = process.env.ORCHESTRATOR_BACKEND_BASE_URL || DEFAULT_BACKEND_BASE_URL,
  env = process.env,
} = {}) {
  const { runMode } = parseArgs(argv);
  const maxExecutors = parsePositiveIntEnv("ORCHESTRATOR_MAX_EXECUTORS", DEFAULT_MAX_EXECUTORS, env);
  const maxReviewers = parsePositiveIntEnv("ORCHESTRATOR_MAX_REVIEWERS", DEFAULT_MAX_REVIEWERS, env);
  const pollIntervalMs = parsePositiveIntEnv("ORCHESTRATOR_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS, env);
  const stallMinutes = parsePositiveIntEnv("ORCHESTRATOR_STALL_MINUTES", DEFAULT_STALL_MINUTES, env);
  const reviewChurnPolls = parsePositiveIntEnv("ORCHESTRATOR_REVIEW_CHURN_POLLS", DEFAULT_REVIEW_CHURN_POLLS, env);
  const sprint = resolveSprint(env);
  const defaultStatePath = await resolveDefaultStatePath({ cwd: process.cwd() });
  const rawStatePath = hasNonEmptyString(env.ORCHESTRATOR_STATE_PATH) ? env.ORCHESTRATOR_STATE_PATH.trim() : defaultStatePath;
  const statePath = resolve(process.cwd(), rawStatePath);

  do {
    const currentState = await readStateFile(statePath);
    let cycleResult;
    try {
      cycleResult = await runCycle({
        repoRoot,
        backendBaseUrl,
        maxExecutors,
        maxReviewers,
        sprint,
        stallMinutes,
        reviewChurnPolls,
        previousState: currentState,
        env,
      });
    } catch (error) {
      if (runMode === "loop" && (error?.code === "transient_network_error" || error?.code === "transient_retries_exhausted")) {
        process.stderr.write(
          `${JSON.stringify({
            type: "ORCHESTRATOR_CYCLE_TRANSIENT_ERROR",
            code: error?.code ?? "",
            error: error instanceof Error ? error.message : String(error),
            retry_in_ms: pollIntervalMs,
          })}\n`,
        );
        await sleep(pollIntervalMs);
        continue;
      }
      throw error;
    }

    const latestState = await readStateFile(statePath);
    const mergedState = mergeRunnerManagedStateFields({
      nextState: cycleResult.nextState,
      diskState: latestState,
    });
    await writeStateFile(statePath, mergedState);

    for (const intent of cycleResult.intents) {
      process.stdout.write(`${JSON.stringify(intent)}\n`);
    }

    writeDispatchSummary(cycleResult.summary);

    if (cycleResult.completed) {
      writeEndOfSprintSummary(cycleResult.summary);
      return 0;
    }

    if (runMode === "once") {
      return 0;
    }

    await sleep(pollIntervalMs);
  } while (true);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  runOrchestratorCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = resolveExitCode(error);
    });
}
