import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { sanitizeDependencyGraph } from "../../../orchestrator/src/sanitize-dependency-graph.js";

const RUNNER_SPRINT_PLAN_PATH = "./.runner-sprint-plan.json";
const RUNNER_LEDGER_PATH = "./.runner-ledger.json";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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

async function readJsonObjectOrEmpty(path, { readFileImpl = readFile } = {}) {
  try {
    const raw = await readFileImpl(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
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

export async function generateRunnerStateFromProjectSprint({
  repoRoot,
  sprint,
  githubClient,
  orchestratorStatePath,
  nowIso = () => new Date().toISOString(),
  fs = {
    mkdir,
    readFile,
    rename,
    writeFile,
  },
  runnerSprintPlanPath = RUNNER_SPRINT_PLAN_PATH,
  runnerLedgerPath = RUNNER_LEDGER_PATH,
} = {}) {
  if (!isNonEmptyString(sprint)) {
    return { ok: false, statusCode: 400, payload: { error: "body.sprint is required" } };
  }
  if (!githubClient || typeof githubClient.listProjectItems !== "function") {
    return { ok: false, statusCode: 500, payload: { error: "githubClient.listProjectItems is required" } };
  }
  if (!isNonEmptyString(orchestratorStatePath)) {
    return { ok: false, statusCode: 500, payload: { error: "orchestratorStatePath is required" } };
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

  const taskByIssueNumber = new Map();
  const duplicateIssueNumbers = new Set();
  const tasks = [];

  for (const item of sprintItems) {
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

  for (const item of sprintItems) {
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

  const orchestratorState = await readJsonObjectOrEmpty(orchestratorStatePath, { readFileImpl: fs.readFile });
  const sprintPlanMeta =
    orchestratorState?.sprint_plan && typeof orchestratorState.sprint_plan === "object"
      ? orchestratorState.sprint_plan
      : undefined;
  const ownershipIndex =
    orchestratorState?.ownership_index && typeof orchestratorState.ownership_index === "object"
      ? orchestratorState.ownership_index
      : undefined;

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

  const ledgerTasks = {};
  for (const task of orderedTasks) {
    ledgerTasks[task.project_item_id] = {
      last_activity_at: planVersion,
    };
  }

  const ledgerPayload = {
    plan_version: planVersion,
    runs: {},
    tasks: ledgerTasks,
  };

  const sprintPlanPath = resolve(repoRoot, runnerSprintPlanPath);
  const sprintPlanTmpPath = `${sprintPlanPath}.tmp-${process.pid}`;
  const ledgerPath = resolve(repoRoot, runnerLedgerPath);
  const ledgerTmpPath = `${ledgerPath}.tmp-${process.pid}`;

  try {
    await atomicWriteJson({
      path: sprintPlanPath,
      tmpPath: sprintPlanTmpPath,
      payload: planPayload,
      writeFileImpl: fs.writeFile,
      renameImpl: fs.rename,
      mkdirImpl: fs.mkdir,
    });
    await atomicWriteJson({
      path: ledgerPath,
      tmpPath: ledgerTmpPath,
      payload: ledgerPayload,
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
    const nextState = {
      ...(orchestratorState && typeof orchestratorState === "object" ? orchestratorState : {}),
      sprint_phase: "ACTIVE",
      sealed_at: planVersion,
    };
    await atomicWriteJson({
      path: orchestratorStatePath,
      tmpPath: `${orchestratorStatePath}.tmp-${process.pid}`,
      payload: nextState,
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

  return {
    ok: true,
    plan_version: planVersion,
  };
}
