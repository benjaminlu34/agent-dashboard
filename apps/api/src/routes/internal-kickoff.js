import { spawn } from "node:child_process";
import { readdir, readFile, readlink, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { runPreflightCheck } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const GOAL_FILE_PATH = "goal.txt";
const KICKOFF_ROLE = "ORCHESTRATOR";
const SPRINT_RE = /^M[1-4]$/;
const RUNNER_STARTUP_GRACE_MS = 350;
const LOOP_STATE_FILE = ".runner-loop-state.json";
const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";
const DEFAULT_RUNNER_LEDGER_PATH = "./.runner-ledger.json";
const LOOP_TERMINATION_GRACE_MS = 2500;
const LOOP_TERMINATION_POLL_MS = 80;
const LOOP_STATE_BY_REPO = new Map();

function resolveRepoKey(repoRoot) {
  return resolve(repoRoot);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function resolveLoopStatePath(repoRoot) {
  return resolve(repoRoot, LOOP_STATE_FILE);
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function safeUnlink(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function parseLoopMode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const mode = value.trim().toUpperCase();
  return mode === "KICKOFF" || mode === "RUNNER" ? mode : null;
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStatePathToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

async function readTargetIdentityFromAgentSwarm({ repoRoot }) {
  const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
  let rawConfig = "";
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed = {};
  try {
    parsed = YAML.parse(rawConfig) ?? {};
  } catch {
    return null;
  }

  const owner = parsed?.target?.owner;
  const repo = parsed?.target?.repo;
  if (!hasNonEmptyString(owner) || !hasNonEmptyString(repo)) {
    return null;
  }

  return {
    owner: owner.trim(),
    repo: repo.trim(),
  };
}

function resolveRunnerLedgerPath({ repoRoot, env, targetIdentity }) {
  const defaultPath = hasNonEmptyString(targetIdentity?.owner) && hasNonEmptyString(targetIdentity?.repo)
    ? `./.runner-ledger.${sanitizeStatePathToken(targetIdentity.owner)}.${sanitizeStatePathToken(targetIdentity.repo)}.json`
    : DEFAULT_RUNNER_LEDGER_PATH;
  const configured = hasNonEmptyString(env?.RUNNER_LEDGER_PATH) ? env.RUNNER_LEDGER_PATH.trim() : defaultPath;
  return resolve(repoRoot, configured);
}

function toStoppedLedgerResult({ previousResult, reason, nowIso }) {
  const base = previousResult && typeof previousResult === "object" ? previousResult : {};
  const previousErrors = Array.isArray(base.errors) ? base.errors.filter((entry) => entry && typeof entry === "object") : [];
  const hasStopMarker = previousErrors.some((entry) => entry.code === "runner_loop_stopped");
  const errors = hasStopMarker ? previousErrors : [...previousErrors, { code: "runner_loop_stopped", message: reason }];
  return {
    ...base,
    status: "failed",
    summary: reason,
    errors,
    failure_classification: "HARD_STOP",
    error_code: "runner_loop_stopped",
    completed_at: nowIso,
  };
}

async function markRunningLedgerEntriesStopped({ repoRoot, env = process.env, reason }) {
  const targetIdentity = await readTargetIdentityFromAgentSwarm({ repoRoot });
  const ledgerPath = resolveRunnerLedgerPath({
    repoRoot,
    env,
    targetIdentity,
  });

  let raw = "";
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 0;
  }

  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const entry of Object.values(parsed)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const status = typeof entry.status === "string" ? entry.status.trim().toLowerCase() : "";
    if (status !== "running") {
      continue;
    }
    entry.status = "failed";
    entry.result = toStoppedLedgerResult({
      previousResult: entry.result,
      reason,
      nowIso,
    });
    updated += 1;
  }

  if (updated > 0) {
    await writeFile(ledgerPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  return updated;
}

function isValidLoopState(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.sprint === "string" &&
    normalizeSprint(value.sprint) !== null &&
    typeof value.startedAt === "string" &&
    typeof value.loopMode === "string" &&
    parseLoopMode(value.loopMode) !== null
  );
}

async function rotateCorruptLoopStateFile(path) {
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await rename(path, `${path}.corrupt-${suffix}`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function readLoopStateFromDisk(repoRoot) {
  const path = resolveLoopStatePath(repoRoot);
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await rotateCorruptLoopStateFile(path);
    return null;
  }

  if (!isValidLoopState(parsed)) {
    await rotateCorruptLoopStateFile(path);
    return null;
  }

  return {
    pid: parsed.pid,
    sprint: normalizeSprint(parsed.sprint),
    startedAt: parsed.startedAt,
    loopMode: parseLoopMode(parsed.loopMode),
  };
}

async function writeLoopStateToDisk(repoRoot, state) {
  const path = resolveLoopStatePath(repoRoot);
  const payload = JSON.stringify(state, null, 2) + "\n";
  await writeFile(path, payload, "utf8");
}

async function waitForProcessDeath(pid, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(LOOP_TERMINATION_POLL_MS);
  }
  return !isProcessAlive(pid);
}

async function readProcCmdline(pid) {
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    return buf
      .toString("utf8")
      .split("\u0000")
      .map((token) => token.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function readProcCwd(pid) {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function looksLikeRunnerLoopProcess({ pid, repoRoot, loopMode, sprint }) {
  const cmdline = await readProcCmdline(pid);
  if (!cmdline) {
    return { status: "UNKNOWN" };
  }

  const joined = cmdline.join("\n");
  const hasModule = cmdline.includes("-m") && cmdline.includes("apps.runner");
  const hasLoop = cmdline.includes("--loop");
  const hasKickoffFlag = cmdline.includes("--kickoff");

  if (!hasModule || !hasLoop) {
    return { status: "MISMATCH", detail: `unexpected cmdline: ${joined}` };
  }

  if (loopMode === "KICKOFF" && !hasKickoffFlag) {
    return { status: "MISMATCH", detail: `missing --kickoff in cmdline: ${joined}` };
  }

  if (loopMode === "RUNNER" && hasKickoffFlag) {
    return { status: "MISMATCH", detail: `unexpected --kickoff in cmdline: ${joined}` };
  }

  const sprintIndex = cmdline.indexOf("--sprint");
  if (sprintIndex !== -1) {
    const seen = normalizeSprint(cmdline[sprintIndex + 1]);
    if (seen && seen !== sprint) {
      return { status: "MISMATCH", detail: `unexpected sprint ${seen} in cmdline: ${joined}` };
    }
  }

  const cwd = await readProcCwd(pid);
  if (cwd && resolve(cwd) !== resolve(repoRoot)) {
    return { status: "MISMATCH", detail: `unexpected cwd ${cwd}` };
  }

  return { status: "MATCH" };
}

async function findLiveRunnerLoopCandidates(repoRoot, { maxCandidates = 2 } = {}) {
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry?.isDirectory?.()) {
      continue;
    }
    if (!/^[0-9]+$/.test(entry.name)) {
      continue;
    }

    const pid = Number(entry.name);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    if (!isProcessAlive(pid)) {
      continue;
    }

    const cmdline = await readProcCmdline(pid);
    if (!cmdline) {
      continue;
    }

    if (!(cmdline.includes("-m") && cmdline.includes("apps.runner") && cmdline.includes("--loop"))) {
      continue;
    }

    const cwd = await readProcCwd(pid);
    if (cwd && resolve(cwd) !== resolve(repoRoot)) {
      continue;
    }

    const loopMode = cmdline.includes("--kickoff") ? "KICKOFF" : "RUNNER";
    const sprintIndex = cmdline.indexOf("--sprint");
    const sprint = sprintIndex !== -1 ? normalizeSprint(cmdline[sprintIndex + 1]) : null;

    if (!sprint) {
      continue;
    }

    candidates.push({
      pid,
      sprint,
      startedAt: new Date().toISOString(),
      loopMode,
    });

    if (candidates.length >= maxCandidates) {
      break;
    }
  }

  return candidates;
}

function normalizeSprint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return SPRINT_RE.test(normalized) ? normalized : null;
}

async function getActiveLoopState(repoRoot) {
  const repoKey = resolveRepoKey(repoRoot);
  const cached = LOOP_STATE_BY_REPO.get(repoKey);
  if (cached && isProcessAlive(cached.pid)) {
    return cached;
  }

  const diskState = await readLoopStateFromDisk(repoRoot);
  if (!diskState) {
    const candidates = await findLiveRunnerLoopCandidates(repoRoot);
    if (candidates.length === 1) {
      const state = candidates[0];
      LOOP_STATE_BY_REPO.set(repoKey, state);
      await writeLoopStateToDisk(repoRoot, state);
      return state;
    }

    if (candidates.length > 1) {
      // Multiple detached loops in the same repo root should never happen; fail closed by
      // treating the loop as active so we don't spawn more.
      const state = candidates[0];
      LOOP_STATE_BY_REPO.set(repoKey, state);
      return state;
    }

    LOOP_STATE_BY_REPO.delete(repoKey);
    return null;
  }

  if (!isProcessAlive(diskState.pid)) {
    await safeUnlink(resolveLoopStatePath(repoRoot));
    LOOP_STATE_BY_REPO.delete(repoKey);
    return null;
  }

  const looksLike = await looksLikeRunnerLoopProcess({
    pid: diskState.pid,
    repoRoot,
    loopMode: diskState.loopMode,
    sprint: diskState.sprint,
  });
  if (looksLike.status === "MISMATCH") {
    // Refuse to kill an unrelated process, but also refuse to start a new loop
    // while a live PID is claimed. The operator must intervene by clearing the
    // state file once the situation is understood.
    LOOP_STATE_BY_REPO.set(repoKey, diskState);
    return diskState;
  }

  LOOP_STATE_BY_REPO.set(repoKey, diskState);
  return diskState;
}

async function defaultStartKickoffLoopProcess({ repoRoot, sprint }) {
  const args = ["-m", "apps.runner", "--kickoff", "--sprint", sprint, "--goal-file", `./${GOAL_FILE_PATH}`, "--loop"];
  return new Promise((resolveStarted, rejectStart) => {
    const child = spawn("python3", args, {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });

    const failStartup = (message) => {
      cleanupStartup();
      rejectStart(new Error(message));
    };

    const handleStartupError = (error) => {
      const detail = typeof error?.message === "string" && error.message.trim().length > 0 ? error.message.trim() : "unknown error";
      failStartup(`unable to start kickoff loop process: ${detail}`);
    };

    const handleStartupExit = (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${String(code ?? "unknown")}`;
      failStartup(`kickoff loop process exited before startup check (${reason})`);
    };

    const startupTimer = setTimeout(() => {
      cleanupStartup();
      child.unref();
      resolveStarted(child);
    }, RUNNER_STARTUP_GRACE_MS);

    function cleanupStartup() {
      clearTimeout(startupTimer);
      child.off("error", handleStartupError);
      child.off("exit", handleStartupExit);
    }

    child.once("error", handleStartupError);
    child.once("exit", handleStartupExit);
  });
}

async function defaultStartRunnerLoopProcess({ repoRoot, sprint }) {
  const args = ["-m", "apps.runner", "--sprint", sprint, "--loop"];
  return new Promise((resolveStarted, rejectStart) => {
    const child = spawn("python3", args, {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });

    const failStartup = (message) => {
      cleanupStartup();
      rejectStart(new Error(message));
    };

    const handleStartupError = (error) => {
      const detail = typeof error?.message === "string" && error.message.trim().length > 0 ? error.message.trim() : "unknown error";
      failStartup(`unable to start runner loop process: ${detail}`);
    };

    const handleStartupExit = (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${String(code ?? "unknown")}`;
      failStartup(`runner loop process exited before startup check (${reason})`);
    };

    const startupTimer = setTimeout(() => {
      cleanupStartup();
      child.unref();
      resolveStarted(child);
    }, RUNNER_STARTUP_GRACE_MS);

    function cleanupStartup() {
      clearTimeout(startupTimer);
      child.off("error", handleStartupError);
      child.off("exit", handleStartupExit);
    }

    child.once("error", handleStartupError);
    child.once("exit", handleStartupExit);
  });
}

function buildLoopManager({
  repoRoot = DEFAULT_REPO_ROOT,
  loopMode = "KICKOFF",
  startLoopProcess = defaultStartKickoffLoopProcess,
  isProcessAliveFn = isProcessAlive,
} = {}) {
  const normalizedLoopMode = parseLoopMode(loopMode) ?? "KICKOFF";
  let opQueue = Promise.resolve();

  const enqueue = (operation) => {
    const next = opQueue.then(operation, operation);
    opQueue = next.catch(() => {});
    return next;
  };

  return {
    async getActive() {
      return await getActiveLoopState(repoRoot);
    },
    async start({ sprint }) {
      return await enqueue(async () => {
        const normalizedSprint = normalizeSprint(sprint);
        if (!normalizedSprint) {
          throw new Error("invalid sprint");
        }

        const existing = await getActiveLoopState(repoRoot);
        if (existing) {
          return existing;
        }

        const child = await startLoopProcess({ repoRoot, sprint: normalizedSprint });
        if (!Number.isInteger(child?.pid) || child.pid <= 0) {
          throw new Error("unable to determine kickoff loop process id");
        }

        // Reduce false STARTED responses when the detached process dies immediately after spawn.
        if (!isProcessAliveFn(child.pid)) {
          throw new Error("loop process exited during startup");
        }

        const repoKey = resolveRepoKey(repoRoot);
        const state = {
          pid: child.pid,
          sprint: normalizedSprint,
          startedAt: new Date().toISOString(),
          loopMode: normalizedLoopMode,
        };
        LOOP_STATE_BY_REPO.set(repoKey, state);
        try {
          await writeLoopStateToDisk(repoRoot, state);
        } catch (error) {
          LOOP_STATE_BY_REPO.delete(repoKey);
          // Best-effort cleanup: if we can't persist loop state we should not leave an orphan loop running.
          try {
            process.kill(-state.pid, "SIGTERM");
          } catch {}
          try {
            process.kill(state.pid, "SIGTERM");
          } catch {}
          await waitForProcessDeath(state.pid, { timeoutMs: LOOP_TERMINATION_GRACE_MS });
          throw error;
        }

        child.once("exit", () => {
          const active = LOOP_STATE_BY_REPO.get(repoKey);
          if (active?.pid === state.pid) {
            LOOP_STATE_BY_REPO.delete(repoKey);
          }
        });

        return state;
      });
    },
    async stop({ force = false } = {}) {
      return await enqueue(async () => {
        const targetsByPid = new Map();

        const state = await readLoopStateFromDisk(repoRoot);
        if (state && isProcessAliveFn(state.pid)) {
          targetsByPid.set(state.pid, state);
        } else {
          // Remove stale state file so we can fall back to process discovery.
          await safeUnlink(resolveLoopStatePath(repoRoot));
          LOOP_STATE_BY_REPO.delete(resolveRepoKey(repoRoot));
        }

        // Always scan for detached loop candidates so a single stop request can
        // clean up all live loop processes for this repo (including orphaned ones
        // that are not represented by the current loop-state file).
        const discoveredTargets = await findLiveRunnerLoopCandidates(repoRoot, { maxCandidates: 16 });
        for (const candidate of discoveredTargets) {
          if (Number.isInteger(candidate?.pid) && candidate.pid > 0) {
            targetsByPid.set(candidate.pid, candidate);
          }
        }

        const targets = Array.from(targetsByPid.values());
        if (targets.length === 0) {
          return { status: "NOT_RUNNING" };
        }

        for (const target of targets) {
          const looksLike = await looksLikeRunnerLoopProcess({
            pid: target.pid,
            repoRoot,
            loopMode: target.loopMode,
            sprint: target.sprint,
          });
          if (!force && looksLike.status === "MISMATCH") {
            return { status: "REFUSED", detail: looksLike.detail };
          }

          // Try terminating the whole process group first (detached runner should be the leader).
          try {
            process.kill(-target.pid, "SIGTERM");
          } catch (error) {
            if (error?.code !== "ESRCH" && error?.code !== "EINVAL") {
              // Fall through to direct PID kill below.
            }
          }
          try {
            process.kill(target.pid, "SIGTERM");
          } catch (error) {
            if (error?.code !== "ESRCH") {
              throw error;
            }
          }

          const exited = await waitForProcessDeath(target.pid, { timeoutMs: LOOP_TERMINATION_GRACE_MS });
          if (!exited && isProcessAliveFn(target.pid)) {
            try {
              process.kill(-target.pid, "SIGKILL");
            } catch (error) {
              if (error?.code !== "ESRCH" && error?.code !== "EINVAL") {
                // Fall through to direct PID kill below.
              }
            }
            try {
              process.kill(target.pid, "SIGKILL");
            } catch (error) {
              if (error?.code !== "ESRCH") {
                throw error;
              }
            }

            await waitForProcessDeath(target.pid, { timeoutMs: LOOP_TERMINATION_GRACE_MS });
          }
        }

        await safeUnlink(resolveLoopStatePath(repoRoot));
        LOOP_STATE_BY_REPO.delete(resolveRepoKey(repoRoot));
        return { status: "STOPPED" };
      });
    },
  };
}

export function buildInternalKickoffHandler({ repoRoot = DEFAULT_REPO_ROOT, preflightCheck } = {}) {
  const resolvedPreflightCheck =
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }));

  return async function internalKickoffHandler(request, reply) {
    const goal = request?.body?.goal;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      reply.code(400);
      return { error: "body.goal must be a non-empty string" };
    }

    const preflightFailure = await validateKickoffPreflight({ preflightCheck: resolvedPreflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    await writeFile(resolve(repoRoot, GOAL_FILE_PATH), goal, "utf8");

    return {
      status: "success",
      message: "Goal Received.",
    };
  };
}

async function validateKickoffPreflight({ preflightCheck }) {
  const { statusCode: preflightStatusCode, payload: preflightResult } = await preflightCheck({
    role: KICKOFF_ROLE,
  });

  if (preflightStatusCode !== 200) {
    return { statusCode: preflightStatusCode, payload: preflightResult };
  }

  if (preflightResult?.status === "FAIL") {
    return { statusCode: 409, payload: preflightResult };
  }

  return null;
}

function resolvePreflightCheck({ preflightCheck, repoRoot }) {
  return (
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }))
  );
}

function buildInternalStartLoopHandler({
  repoRoot,
  preflightCheck,
  loopManager,
  requireGoalFile,
  alreadyRunningError,
  startedMessage,
  startFailurePrefix,
}) {
  return async function internalStartLoopHandler(request, reply) {
    const sprint = normalizeSprint(request?.body?.sprint);
    if (!sprint) {
      reply.code(400);
      return { error: "body.sprint must be one of M1, M2, M3, or M4" };
    }

    if (requireGoalFile) {
      const goalPath = resolve(repoRoot, GOAL_FILE_PATH);
      let goalContent = "";
      try {
        goalContent = await readFile(goalPath, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
      if (goalContent.trim().length === 0) {
        reply.code(400);
        return { error: "goal.txt is missing or empty; save a kickoff goal first" };
      }
    }

    const preflightFailure = await validateKickoffPreflight({ preflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    const active = await loopManager.getActive();
    if (active) {
      reply.code(409);
      return {
        status: "ALREADY_RUNNING",
        error: alreadyRunningError,
        pid: active.pid,
        sprint: active.sprint,
        started_at: active.startedAt,
      };
    }

    try {
      const started = await loopManager.start({ sprint });
      reply.code(202);
      return {
        status: "STARTED",
        message: startedMessage,
        pid: started.pid,
        sprint: started.sprint,
        started_at: started.startedAt,
      };
    } catch (error) {
      reply.code(500);
      return {
        error: `Failed to start ${startFailurePrefix}: ${error?.message ?? "Unknown error"}`,
      };
    }
  };
}

function buildInternalStopLoopHandler({ repoRoot, preflightCheck, loopManager, stopFailurePrefix }) {
  return async function internalStopLoopHandler(request, reply) {
    // Stop should remain available even if project preflight is failing; in practice
    // operators use stop-loop to recover from bad identity/schema drift or credential issues.
    const { statusCode: preflightStatusCode, payload: preflightResult } = await preflightCheck({
      role: KICKOFF_ROLE,
    });

    if (preflightStatusCode !== 200) {
      reply.code(preflightStatusCode);
      return preflightResult;
    }

    const force = Boolean(request?.body?.force);
    try {
      const result = await loopManager.stop({ force });
      if (result.status === "REFUSED") {
        reply.code(409);
        return {
          status: "REFUSED",
          error: `Refusing to stop ${stopFailurePrefix}; PID did not look like a runner loop process`,
          detail: result.detail ?? "",
        };
      }
      if (result.status === "STOPPED" || result.status === "NOT_RUNNING") {
        await markRunningLedgerEntriesStopped({
          repoRoot,
          reason: `Runner loop stop requested by operator (${stopFailurePrefix}).`,
        });
      }
      reply.code(200);
      return { status: result.status };
    } catch (error) {
      reply.code(500);
      return { error: `Failed to stop ${stopFailurePrefix}: ${error?.message ?? "Unknown error"}` };
    }
  };
}

export function buildInternalKickoffStartLoopHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightCheck,
  kickoffLoopManager,
} = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });
  const resolvedKickoffLoopManager = kickoffLoopManager ?? buildLoopManager({ repoRoot, loopMode: "KICKOFF" });

  return buildInternalStartLoopHandler({
    repoRoot,
    preflightCheck: resolvedPreflightCheck,
    loopManager: resolvedKickoffLoopManager,
    requireGoalFile: true,
    alreadyRunningError: "Kickoff loop is already running for this repo",
    startedMessage: "Kickoff loop started.",
    startFailurePrefix: "kickoff loop",
  });
}

export function buildInternalRunnerStartLoopHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightCheck,
  runnerLoopManager,
} = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });
  const resolvedRunnerLoopManager =
    runnerLoopManager ??
    buildLoopManager({
      repoRoot,
      loopMode: "RUNNER",
      startLoopProcess: defaultStartRunnerLoopProcess,
    });

  return buildInternalStartLoopHandler({
    repoRoot,
    preflightCheck: resolvedPreflightCheck,
    loopManager: resolvedRunnerLoopManager,
    requireGoalFile: false,
    alreadyRunningError: "Runner loop is already running for this repo",
    startedMessage: "Runner loop started.",
    startFailurePrefix: "runner loop",
  });
}

export function buildInternalKickoffStopLoopHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightCheck,
  kickoffLoopManager,
} = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });
  const resolvedKickoffLoopManager = kickoffLoopManager ?? buildLoopManager({ repoRoot, loopMode: "KICKOFF" });

  return buildInternalStopLoopHandler({
    repoRoot,
    preflightCheck: resolvedPreflightCheck,
    loopManager: resolvedKickoffLoopManager,
    stopFailurePrefix: "kickoff loop",
  });
}

export function buildInternalRunnerStopLoopHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightCheck,
  runnerLoopManager,
} = {}) {
  const resolvedPreflightCheck = resolvePreflightCheck({ preflightCheck, repoRoot });
  const resolvedRunnerLoopManager =
    runnerLoopManager ??
    buildLoopManager({
      repoRoot,
      loopMode: "RUNNER",
      startLoopProcess: defaultStartRunnerLoopProcess,
    });

  return buildInternalStopLoopHandler({
    repoRoot,
    preflightCheck: resolvedPreflightCheck,
    loopManager: resolvedRunnerLoopManager,
    stopFailurePrefix: "runner loop",
  });
}

export async function registerInternalKickoffRoute(fastify, options = {}) {
  fastify.post("/internal/kickoff", buildInternalKickoffHandler(options));
  fastify.post("/internal/kickoff/start-loop", buildInternalKickoffStartLoopHandler(options));
  fastify.post("/internal/runner/start-loop", buildInternalRunnerStartLoopHandler(options));
  fastify.post("/internal/kickoff/stop-loop", buildInternalKickoffStopLoopHandler(options));
  fastify.post("/internal/runner/stop-loop", buildInternalRunnerStopLoopHandler(options));
}
