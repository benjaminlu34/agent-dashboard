import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflightCheck } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const GOAL_FILE_PATH = "goal.txt";
const KICKOFF_ROLE = "ORCHESTRATOR";
const SPRINT_RE = /^M[1-4]$/;
const RUNNER_STARTUP_GRACE_MS = 350;
const KICKOFF_LOOP_STATE_BY_REPO = new Map();

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

function normalizeSprint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  return SPRINT_RE.test(normalized) ? normalized : null;
}

function getActiveKickoffLoopState(repoRoot) {
  const repoKey = resolveRepoKey(repoRoot);
  const current = KICKOFF_LOOP_STATE_BY_REPO.get(repoKey);
  if (!current) {
    return null;
  }

  if (!isProcessAlive(current.pid)) {
    KICKOFF_LOOP_STATE_BY_REPO.delete(repoKey);
    return null;
  }

  return current;
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

function buildKickoffLoopManager({ repoRoot = DEFAULT_REPO_ROOT, startKickoffLoopProcess = defaultStartKickoffLoopProcess } = {}) {
  return {
    getActive() {
      return getActiveKickoffLoopState(repoRoot);
    },
    async start({ sprint }) {
      const normalizedSprint = normalizeSprint(sprint);
      if (!normalizedSprint) {
        throw new Error("invalid sprint");
      }

      const existing = getActiveKickoffLoopState(repoRoot);
      if (existing) {
        return existing;
      }

      const child = await startKickoffLoopProcess({ repoRoot, sprint: normalizedSprint });
      if (!Number.isInteger(child?.pid) || child.pid <= 0) {
        throw new Error("unable to determine kickoff loop process id");
      }

      const repoKey = resolveRepoKey(repoRoot);
      const state = {
        pid: child.pid,
        sprint: normalizedSprint,
        startedAt: new Date().toISOString(),
      };
      KICKOFF_LOOP_STATE_BY_REPO.set(repoKey, state);

      child.once("exit", () => {
        const active = KICKOFF_LOOP_STATE_BY_REPO.get(repoKey);
        if (active?.pid === state.pid) {
          KICKOFF_LOOP_STATE_BY_REPO.delete(repoKey);
        }
      });

      return state;
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

export function buildInternalKickoffStartLoopHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  preflightCheck,
  kickoffLoopManager,
} = {}) {
  const resolvedPreflightCheck =
    preflightCheck ??
    (async ({ role }) =>
      runPreflightCheck({
        role,
        repoRoot,
      }));
  const resolvedKickoffLoopManager = kickoffLoopManager ?? buildKickoffLoopManager({ repoRoot });

  return async function internalKickoffStartLoopHandler(request, reply) {
    const sprint = normalizeSprint(request?.body?.sprint);
    if (!sprint) {
      reply.code(400);
      return { error: "body.sprint must be one of M1, M2, M3, or M4" };
    }

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

    const preflightFailure = await validateKickoffPreflight({ preflightCheck: resolvedPreflightCheck });
    if (preflightFailure) {
      reply.code(preflightFailure.statusCode);
      return preflightFailure.payload;
    }

    const active = resolvedKickoffLoopManager.getActive();
    if (active) {
      reply.code(409);
      return {
        status: "ALREADY_RUNNING",
        error: "Kickoff loop is already running for this repo",
        pid: active.pid,
        sprint: active.sprint,
        started_at: active.startedAt,
      };
    }

    try {
      const started = await resolvedKickoffLoopManager.start({ sprint });
      reply.code(202);
      return {
        status: "STARTED",
        message: "Kickoff loop started.",
        pid: started.pid,
        sprint: started.sprint,
        started_at: started.startedAt,
      };
    } catch (error) {
      reply.code(500);
      return {
        error: `Failed to start kickoff loop: ${error?.message ?? "Unknown error"}`,
      };
    }
  };
}

export async function registerInternalKickoffRoute(fastify, options = {}) {
  fastify.post("/internal/kickoff", buildInternalKickoffHandler(options));
  fastify.post("/internal/kickoff/start-loop", buildInternalKickoffStartLoopHandler(options));
}
