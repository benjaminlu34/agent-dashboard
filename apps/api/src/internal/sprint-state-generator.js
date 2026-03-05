import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { sanitizeDependencyGraph } from "../../../orchestrator/src/sanitize-dependency-graph.js";
import { orchestratorLedgerKey, orchestratorRootKey } from "./redis-keys.js";

const RUNNER_SPRINT_PLAN_PATH = "./.runner-sprint-plan.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeJsonParseOrNull(raw) {
  if (!isNonEmptyString(raw)) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function parseDependsOnIssueNumbers(rawValue) {
  if (!isNonEmptyString(rawValue)) {
    return { issueNumbers: [], invalidTokens: [] };
  }

  const cleaned = rawValue.replace(/[#\s]+/gu, "");
  const tokens = cleaned
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const issueNumbers = [];
  const invalidTokens = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      invalidTokens.push(token);
      continue;
    }
    if (!issueNumbers.includes(parsed)) {
      issueNumbers.push(parsed);
    }
  }

  return { issueNumbers, invalidTokens };
}

function buildCycleDetectionInput({ tasks, dependenciesByTaskId }) {
  const ordered = tasks
    .slice()
    .sort(
      (left, right) =>
        left.issue_number - right.issue_number ||
        left.project_item_id.localeCompare(right.project_item_id),
    );

  const indexByTaskId = new Map();
  for (let i = 0; i < ordered.length; i += 1) {
    indexByTaskId.set(ordered[i].project_item_id, i + 1);
  }

  const taskByIndex = new Map();
  for (const task of ordered) {
    taskByIndex.set(indexByTaskId.get(task.project_item_id), task);
  }

  const items = ordered.map((task) => {
    const deps = dependenciesByTaskId.get(task.project_item_id) ?? [];
    const mappedDeps = [];
    for (const dep of deps) {
      const mapped = indexByTaskId.get(dep);
      if (Number.isInteger(mapped) && mapped > 0 && !mappedDeps.includes(mapped)) {
        mappedDeps.push(mapped);
      }
    }

    return {
      number: indexByTaskId.get(task.project_item_id),
      depends_on: mappedDeps,
      owns_paths: [],
      touch_paths: [],
    };
  });

  return { items, taskByIndex };
}

function detectCycles({ tasks, dependenciesByTaskId }) {
  const { items, taskByIndex } = buildCycleDetectionInput({ tasks, dependenciesByTaskId });
  const result = sanitizeDependencyGraph(items);
  const cycles = Array.isArray(result?.error?.cycles) ? result.error.cycles : null;
  if (!cycles || cycles.length === 0) {
    return null;
  }

  const resolved = [];
  for (const cycle of cycles) {
    if (!Array.isArray(cycle) || cycle.length === 0) {
      continue;
    }

    const entries = [];
    for (const index of cycle) {
      const task = taskByIndex.get(index);
      if (!task) {
        continue;
      }
      entries.push({
        project_item_id: task.project_item_id,
        issue_number: task.issue_number,
      });
    }

    if (entries.length > 0) {
      resolved.push(entries);
    }
  }

  return resolved.length > 0 ? resolved : null;
}

async function atomicWriteJson({
  path,
  tmpPath,
  payload,
  writeFileImpl = writeFile,
  renameImpl = rename,
  mkdirImpl = mkdir,
}) {
  const directory = dirname(path);
  await mkdirImpl(directory, { recursive: true });
  await writeFileImpl(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameImpl(tmpPath, path);
}

function normalizeOptionalTextField(value) {
  return isNonEmptyString(value) ? value.trim() : "";
}

function normalizeOptionalSingleSelect(value) {
  return isNonEmptyString(value) ? value.trim() : "";
}

function normalizeSprintField(value) {
  return isNonEmptyString(value) ? value.trim() : "";
}

function isSprintGoalTitle(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  return value.trimStart().toUpperCase().startsWith("[SPRINT GOAL]");
}

export async function generateRunnerStateFromProjectSprint({
  repoRoot,
  sprint,
  githubClient,
  redis,
  repoKey,
  nowIso = () => new Date().toISOString(),
  fs = {
    mkdir,
    rename,
    writeFile,
  },
  runnerSprintPlanPath = RUNNER_SPRINT_PLAN_PATH,
} = {}) {
  if (!isNonEmptyString(sprint)) {
    return { ok: false, statusCode: 400, payload: { error: "body.sprint is required" } };
  }
  if (!githubClient || typeof githubClient.listProjectItems !== "function") {
    return { ok: false, statusCode: 500, payload: { error: "githubClient.listProjectItems is required" } };
  }
  if (!redis || typeof redis.hgetall !== "function" || typeof redis.pipeline !== "function") {
    return { ok: false, statusCode: 500, payload: { error: "redis client is required" } };
  }
  if (!isNonEmptyString(repoKey)) {
    return { ok: false, statusCode: 500, payload: { error: "repoKey is required" } };
  }

  const normalizedSprint = sprint.trim();

  let projectItems;
  try {
    projectItems = await githubClient.listProjectItems();
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      payload: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  const sprintItems = (Array.isArray(projectItems) ? projectItems : []).filter((item) => {
    const itemSprint = normalizeSprintField(item?.fields?.Sprint);
    return itemSprint === normalizedSprint;
  });
  const executableSprintItems = sprintItems.filter((item) => !isSprintGoalTitle(item?.issue_title));

  const taskByIssueNumber = new Map();
  const duplicateIssueNumbers = new Set();
  const tasks = [];

  for (const item of executableSprintItems) {
    const issueNumber = item?.issue_number;
    const projectItemId = item?.project_item_id;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !isNonEmptyString(projectItemId)) {
      continue;
    }

    if (taskByIssueNumber.has(issueNumber)) {
      duplicateIssueNumbers.add(issueNumber);
      continue;
    }

    const issueTitle = normalizeOptionalTextField(item?.issue_title);
    const priority = normalizeOptionalSingleSelect(item?.fields?.Priority);

    const task = {
      project_item_id: projectItemId.trim(),
      issue_number: issueNumber,
      title: issueTitle,
      issue_title: issueTitle,
      issue_url: normalizeOptionalTextField(item?.issue_url),
      priority,
      depends_on: [],
      depends_on_issue_numbers: [],
      depends_on_titles: [],
    };
    taskByIssueNumber.set(issueNumber, task);
    tasks.push(task);
  }

  if (duplicateIssueNumbers.size > 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "duplicate_issue_numbers_in_sprint",
        duplicates: [...duplicateIssueNumbers].sort((left, right) => left - right),
      },
    };
  }

  const dependenciesByTaskId = new Map();
  const danglingErrors = [];

  for (const item of executableSprintItems) {
    const issueNumber = item?.issue_number;
    const projectItemId = item?.project_item_id;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !isNonEmptyString(projectItemId)) {
      continue;
    }

    const task = taskByIssueNumber.get(issueNumber);
    if (!task) {
      continue;
    }

    const { issueNumbers, invalidTokens } = parseDependsOnIssueNumbers(item?.fields?.DependsOn);
    for (const token of invalidTokens) {
      danglingErrors.push(`DependsOn entry '${token}' on #${issueNumber} is not a valid issue number`);
    }

    const resolvedIssueNumbers = [];
    const resolvedTaskIds = [];
    const resolvedTitles = [];

    for (const depIssueNumber of issueNumbers) {
      const dependency = taskByIssueNumber.get(depIssueNumber);
      if (!dependency) {
        danglingErrors.push(
          `Issue #${depIssueNumber} is referenced by #${issueNumber} but does not exist in this sprint`,
        );
        continue;
      }
      resolvedIssueNumbers.push(depIssueNumber);
      resolvedTaskIds.push(dependency.project_item_id);
      if (isNonEmptyString(dependency.title)) {
        resolvedTitles.push(dependency.title);
      }
    }

    dependenciesByTaskId.set(task.project_item_id, resolvedTaskIds);
    task.depends_on = resolvedTaskIds;
    task.depends_on_issue_numbers = resolvedIssueNumbers;
    task.depends_on_titles = resolvedTitles;
  }

  if (danglingErrors.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "dangling_depends_on_references",
        errors: danglingErrors,
      },
    };
  }

  const cycles = detectCycles({ tasks, dependenciesByTaskId });
  if (cycles) {
    return { ok: false, statusCode: 400, payload: { error: "dependency_cycle_detected", cycles } };
  }

  const planVersion = nowIso();

  let sprintPlanMeta;
  let ownershipIndex;
  try {
    const root = await redis.hgetall(orchestratorRootKey(repoKey));
    sprintPlanMeta = safeJsonParseOrNull(root?.sprint_plan);
    ownershipIndex = safeJsonParseOrNull(root?.ownership_index);
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      payload: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  const orderedTasks = tasks.slice().sort((left, right) => left.issue_number - right.issue_number);
  for (const task of orderedTasks) {
    if (sprintPlanMeta && typeof sprintPlanMeta === "object") {
      const scope = sprintPlanMeta[String(task.issue_number)];
      if (scope && typeof scope === "object") {
        task.scope = scope;
      }
    }
  }

  const planPayload = {
    version: 1,
    sprint: normalizedSprint,
    plan_version: planVersion,
    tasks: orderedTasks,
    ...(sprintPlanMeta ? { sprint_plan: sprintPlanMeta } : {}),
    ...(ownershipIndex ? { ownership_index: ownershipIndex } : {}),
  };

  const sprintPlanPath = resolve(repoRoot, runnerSprintPlanPath);
  const sprintPlanTmpPath = `${sprintPlanPath}.tmp-${process.pid}`;

  try {
    await atomicWriteJson({
      path: sprintPlanPath,
      tmpPath: sprintPlanTmpPath,
      payload: planPayload,
      writeFileImpl: fs.writeFile,
      renameImpl: fs.rename,
      mkdirImpl: fs.mkdir,
    });
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      payload: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  try {
    const rootKey = orchestratorRootKey(repoKey);
    const ledgerKey = orchestratorLedgerKey(repoKey);
    const pipeline = redis.pipeline();
    pipeline.hset(rootKey, {
      sprint_phase: "ACTIVE",
      sealed_at: planVersion,
    });
    pipeline.del(ledgerKey);
    pipeline.hset(ledgerKey, "__meta__:plan_version", planVersion);
    for (const task of orderedTasks) {
      pipeline.hset(
        ledgerKey,
        `__task__:${task.project_item_id}`,
        JSON.stringify({ last_activity_at: planVersion }),
      );
    }
    await pipeline.exec();
  } catch (error) {
    return {
      ok: false,
      statusCode: 502,
      payload: { error: error instanceof Error ? error.message : String(error) },
    };
  }

  return {
    ok: true,
    plan_version: planVersion,
  };
}
