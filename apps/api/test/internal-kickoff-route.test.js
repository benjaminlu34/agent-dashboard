import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalKickoffRoute } from "../src/routes/internal-kickoff.js";
import { FakeRedis } from "./helpers/fake-redis.js";

function buildReply() {
  return {
    statusCode: 200,
    code(nextStatus) {
      this.statusCode = nextStatus;
      return this;
    },
  };
}

function buildApp() {
  return {
    routes: new Map(),
    post(path, handler) {
      this.routes.set(path, handler);
    },
  };
}

function getPostHandler(app, path) {
  const handler = app.routes.get(path);
  assert.equal(typeof handler, "function");
  return handler;
}

async function writeAgentSwarm(repoRoot, { owner = "acme", repo = "project-x" } = {}) {
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", `  owner: ${owner}`, `  repo: ${repo}`].join("\n"),
    "utf8",
  );
  return `${owner}.${repo}`;
}

test("POST /internal/kickoff returns 400 when goal is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-400-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  assert.equal(app.routes.has("/internal/kickoff"), true);
  assert.equal(app.routes.has("/internal/kickoff/start-loop"), true);
  assert.equal(app.routes.has("/internal/runner/start-loop"), true);
  assert.equal(app.routes.has("/internal/kickoff/stop-loop"), true);
  assert.equal(app.routes.has("/internal/runner/stop-loop"), true);

  const kickoffHandler = getPostHandler(app, "/internal/kickoff");
  const reply = buildReply();
  const result = await kickoffHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.goal must be a non-empty string" });

  const root = await redis.hgetall(`orchestrator:state:${repoKey}:root`);
  assert.equal(Object.keys(root).length, 0);
});

test("POST /internal/kickoff returns 409 when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-409-"));
  await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({
      statusCode: 200,
      payload: {
        role: "ORCHESTRATOR",
        status: "FAIL",
        errors: [{ source: "template", message: "template missing" }],
      },
    }),
  });

  const kickoffHandler = getPostHandler(app, "/internal/kickoff");
  const reply = buildReply();
  const result = await kickoffHandler({ body: { goal: "Kick off sprint goals" } }, reply);

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(Array.isArray(result.errors), true);
});

test("POST /internal/kickoff stores kickoff_goal in Redis root hash", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-200-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  let requestedRole = "";
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async ({ role }) => {
      requestedRole = String(role ?? "");
      return { statusCode: 200, payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] } };
    },
  });

  const goal = "Deliver a stable kickoff flow across API and dashboard.";
  const kickoffHandler = getPostHandler(app, "/internal/kickoff");
  const reply = buildReply();
  const result = await kickoffHandler({ body: { goal } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(requestedRole, "ORCHESTRATOR");
  assert.deepEqual(result, { status: "success", message: "Goal Received." });

  const stored = await redis.hget(`orchestrator:state:${repoKey}:root`, "kickoff_goal");
  assert.equal(stored, goal);
});

test("POST /internal/kickoff/start-loop returns 400 when sprint is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-400-sprint-"));
  await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.sprint must be one of M1, M2, M3, or M4" });
});

test("POST /internal/kickoff/start-loop returns 400 when kickoff goal is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-400-goal-"));
  await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "M1" } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "kickoff goal is missing; save a kickoff goal first" });
});

test("POST /internal/kickoff/start-loop enqueues START control message and returns 202", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-202-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  await redis.hset(`orchestrator:state:${repoKey}:root`, { kickoff_goal: "Kick off sprint goals" });

  const app = buildApp();
  let requestedRole = "";
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async ({ role }) => {
      requestedRole = String(role ?? "");
      return { statusCode: 200, payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] } };
    },
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "m3", require_verification: true } }, reply);

  assert.equal(reply.statusCode, 202);
  assert.equal(requestedRole, "ORCHESTRATOR");
  assert.equal(result.status, "ENQUEUED");
  assert.equal(result.sprint, "M3");

  const controlKey = `orchestrator:control:${repoKey}`;
  const queued = redis._snapshotList(controlKey);
  assert.equal(queued.length, 1);
  const payload = JSON.parse(queued[0]);
  assert.deepEqual(payload, {
    command: "START",
    mode: "KICKOFF",
    sprint: "M3",
    require_verification: true,
    ready_limit: 3,
    goal: "Kick off sprint goals",
  });
});

test("POST /internal/runner/start-loop enqueues START RUNNER control message and returns 202", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-runner-start-loop-202-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] } }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/runner/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "M2" } }, reply);

  assert.equal(reply.statusCode, 202);
  assert.equal(result.status, "ENQUEUED");
  assert.equal(result.sprint, "M2");

  const queued = redis._snapshotList(`orchestrator:control:${repoKey}`);
  assert.equal(queued.length, 1);
  assert.deepEqual(JSON.parse(queued[0]), { command: "START", mode: "RUNNER", sprint: "M2" });
});

test("POST /internal/kickoff/stop-loop enqueues STOP and returns 202", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-stop-loop-202-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "FAIL" } }),
  });

  const stopLoopHandler = getPostHandler(app, "/internal/kickoff/stop-loop");
  const reply = buildReply();
  const result = await stopLoopHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 202);
  assert.deepEqual(result, { status: "ENQUEUED" });
  assert.deepEqual(JSON.parse(redis._snapshotList(`orchestrator:control:${repoKey}`)[0]), { command: "STOP" });
});

test("POST /internal/runner/stop-loop enqueues STOP and returns 202", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-runner-stop-loop-202-"));
  const repoKey = await writeAgentSwarm(repoRoot);

  const redis = new FakeRedis();
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    redis,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  const stopLoopHandler = getPostHandler(app, "/internal/runner/stop-loop");
  const reply = buildReply();
  const result = await stopLoopHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 202);
  assert.deepEqual(result, { status: "ENQUEUED" });
  assert.deepEqual(JSON.parse(redis._snapshotList(`orchestrator:control:${repoKey}`)[0]), { command: "STOP" });
});

