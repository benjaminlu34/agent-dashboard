import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentContextBundle } from "../../api/src/internal/agent-context-loader.js";
import { createGitHubPlanApplyClient } from "../../api/src/internal/github-plan-apply-client.js";
import { resolveTargetIdentity, TargetIdentityError } from "../../api/src/internal/target-identity.js";
import { buildRunPlan } from "./intents.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../");
const DEFAULT_BACKEND_BASE_URL = "http://localhost:4000";
const DEFAULT_MAX_EXECUTORS = 1;
const DEFAULT_MAX_REVIEWERS = 1;
const DEFAULT_POLL_INTERVAL_MS = 15000;
const DEFAULT_STALL_MINUTES = 120;
const DEFAULT_REVIEW_CHURN_POLLS = 3;
const DEFAULT_STATE_PATH = ".orchestrator-state.json";

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function withErrorCode(error, code) {
  error.code = code;
  return error;
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

async function runPreflight({ backendBaseUrl }) {
  const response = await fetch(`${backendBaseUrl}/internal/preflight?role=ORCHESTRATOR`);
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
    const fixture = JSON.parse(fixtureContent);
    if (!Array.isArray(fixture)) {
      throw withErrorCode(new Error("ORCHESTRATOR_ITEMS_FILE must contain a JSON array"), "validation_failed");
    }
    return fixture;
  }

  if (!githubClient || typeof githubClient.listProjectItems !== "function") {
    throw withErrorCode(new Error("github client is required when ORCHESTRATOR_ITEMS_FILE is not set"), "validation_failed");
  }

  return await githubClient.listProjectItems();
}

async function readStateFile(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("state file must be a JSON object");
    }

    return {
      poll_count: Number.isInteger(parsed.poll_count) && parsed.poll_count >= 0 ? parsed.poll_count : 0,
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        poll_count: 0,
        items: {},
      };
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
        "No Ready/In Progress/In Review items remain in Sprint; humans may merge approved PRs and move items to Done.",
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
  });
}

function resolveExitCode(error) {
  if (error?.code === "transient_retries_exhausted") {
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
  const statePath = resolve(process.cwd(), env.ORCHESTRATOR_STATE_PATH || DEFAULT_STATE_PATH);

  let currentState = await readStateFile(statePath);

  do {
    const cycleResult = await runCycle({
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

    currentState = cycleResult.nextState;
    await writeStateFile(statePath, currentState);

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
