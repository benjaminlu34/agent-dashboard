import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../../api/src/index.js";
import { FakeRedis, FakeRedisSub } from "../../../api/test/helpers/fake-redis.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "../../../../");
const PORT = Number(process.env.DASHBOARD_E2E_PORT || 4100);
const HOST = "127.0.0.1";
const TARGET_OWNER = "e2e-owner";
const TARGET_REPO = "e2e-repo";
const REPO_KEY = `${TARGET_OWNER}.${TARGET_REPO}`;

const redis = new FakeRedis();
const redisSub = new FakeRedisSub();
let scenarioCounter = 0;
let currentScenario = {
  name: "empty",
  runs: {},
};

function rootStateKey() {
  return `orchestrator:state:${REPO_KEY}:root`;
}

function itemsStateKey() {
  return `orchestrator:state:${REPO_KEY}:items`;
}

function ledgerKey() {
  return `orchestrator:ledger:${REPO_KEY}`;
}

function resetFakeRedis() {
  redis._hashes.clear();
  redis._lists.clear();
}

function emitTranscript({ runId, role, section = "SYSTEM OBSERVATION", content, createdAt }) {
  redisSub.emitPMessage({
    channel: `telemetry:events:${runId}`,
    message: JSON.stringify({
      run_id: runId,
      role,
      section,
      content,
      created_at: createdAt ?? new Date().toISOString(),
    }),
  });
}

function runEntry({
  runId,
  role,
  status,
  receivedAt,
  runningAt,
  summary = "",
  errors = [],
  urls = {},
  blockedReason = "",
  outcome = "",
}) {
  return JSON.stringify({
    run_id: runId,
    role,
    status,
    received_at: receivedAt,
    running_at: runningAt,
    result: {
      summary,
      errors,
      urls,
      blocked_reason: blockedReason,
      outcome,
    },
  });
}

async function seedEmptyScenario() {
  resetFakeRedis();
  currentScenario = {
    name: "empty",
    runs: {},
  };
}

async function seedMultiRunScenario() {
  resetFakeRedis();
  scenarioCounter += 1;
  const now = Date.now();
  const primaryExecutorRunId = `qa11-executor-${scenarioCounter}`;
  const secondaryExecutorRunId = `qb22-executor-${scenarioCounter}`;
  const reviewerRunId = `rv33-reviewer-${scenarioCounter}`;
  const orchestratorRunId = `or44-orchestrator-${scenarioCounter}`;

  await redis.hset(rootStateKey(), {
    sprint_phase: "ACTIVE",
    sprint_plan: JSON.stringify({
      sprint: "M1",
      target: `${TARGET_OWNER}/${TARGET_REPO}`,
    }),
  });
  await redis.hset(itemsStateKey(), {
    PVTI_1: JSON.stringify({
      last_seen_issue_number: 101,
      last_seen_issue_title: "Executor work item",
      last_seen_status: "In Progress",
      last_dispatched_role: "EXECUTOR",
      last_run_id: primaryExecutorRunId,
    }),
  });
  await redis.hset(ledgerKey(), {
    "__meta__:plan_version": new Date(now).toISOString(),
    [primaryExecutorRunId]: runEntry({
      runId: primaryExecutorRunId,
      role: "EXECUTOR",
      status: "running",
      receivedAt: new Date(now - 20_000).toISOString(),
      runningAt: new Date(now - 20_000).toISOString(),
      urls: { pr_url: `https://github.com/${TARGET_OWNER}/${TARGET_REPO}/pull/77` },
    }),
    [secondaryExecutorRunId]: runEntry({
      runId: secondaryExecutorRunId,
      role: "EXECUTOR",
      status: "running",
      receivedAt: new Date(now - 10_000).toISOString(),
      runningAt: new Date(now - 10_000).toISOString(),
    }),
    [reviewerRunId]: runEntry({
      runId: reviewerRunId,
      role: "REVIEWER",
      status: "succeeded",
      receivedAt: new Date(now - 45_000).toISOString(),
      summary: "review complete",
      outcome: "PASS",
    }),
    [orchestratorRunId]: runEntry({
      runId: orchestratorRunId,
      role: "ORCHESTRATOR",
      status: "failed",
      receivedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      summary: "orchestrator failed",
      errors: [{ message: "network request failed" }],
    }),
  });

  emitTranscript({
    runId: primaryExecutorRunId,
    role: "EXECUTOR",
    content: "Executor primary initial log",
  });
  emitTranscript({
    runId: secondaryExecutorRunId,
    role: "EXECUTOR",
    content: "Executor secondary initial log",
  });
  emitTranscript({
    runId: reviewerRunId,
    role: "REVIEWER",
    content: "Reviewer initial log",
  });

  currentScenario = {
    name: "multi-run",
    runs: {
      primaryExecutor: {
        runId: primaryExecutorRunId,
        role: "EXECUTOR",
      },
      secondaryExecutor: {
        runId: secondaryExecutorRunId,
        role: "EXECUTOR",
      },
      reviewer: {
        runId: reviewerRunId,
        role: "REVIEWER",
      },
      orchestrator: {
        runId: orchestratorRunId,
        role: "ORCHESTRATOR",
      },
    },
  };
}

async function seedScenario(name) {
  if (name === "multi-run") {
    await seedMultiRunScenario();
    return;
  }
  await seedEmptyScenario();
}

async function createFixtureRepoRoot() {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-dashboard-e2e-"));
  await mkdir(join(repoRoot, "apps", "web"), { recursive: true });
  await symlink(resolve(REPO_ROOT, "apps/web/public"), join(repoRoot, "apps", "web", "public"), "dir");
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    [
      'version: "1.0"',
      "target:",
      `  owner: ${TARGET_OWNER}`,
      `  repo: ${TARGET_REPO}`,
      "  project_v2_number: 7",
      "auth:",
      '  github_token_env: "GITHUB_TOKEN"',
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".env"),
    ["RUNNER_MAX_EXECUTORS=3", "RUNNER_MAX_REVIEWERS=2", 'GITHUB_TOKEN=""', ""].join("\n"),
    "utf8",
  );
  return repoRoot;
}

const fixtureRepoRoot = await createFixtureRepoRoot();
const app = await buildApp({
  repoRoot: fixtureRepoRoot,
  logger: false,
  redis,
  redisSub,
});

await seedScenario(process.env.DASHBOARD_E2E_SCENARIO || "empty");

app.get("/__test/state", async () => currentScenario);
app.post("/__test/scenario", async (request) => {
  const name = typeof request?.body?.name === "string" ? request.body.name.trim() : "empty";
  await seedScenario(name);
  return currentScenario;
});
app.post("/__test/emit-transcript", async (request) => {
  const runId = String(request?.body?.runId ?? "").trim();
  const role = String(request?.body?.role ?? "").trim().toUpperCase();
  const content = String(request?.body?.content ?? "").trim();
  if (!runId || !role || !content) {
    return {
      status: "error",
      error: "runId, role, and content are required",
    };
  }
  emitTranscript({
    runId,
    role,
    section: String(request?.body?.section ?? "SYSTEM OBSERVATION").trim() || "SYSTEM OBSERVATION",
    content,
  });
  return { status: "ok" };
});

await app.listen({ port: PORT, host: HOST });

async function shutdown() {
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
