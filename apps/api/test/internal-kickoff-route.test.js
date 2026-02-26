import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalKickoffRoute } from "../src/routes/internal-kickoff.js";

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

test("POST /internal/kickoff returns 400 when goal is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-400-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  assert.equal(app.routes.has("/internal/kickoff"), true);
  assert.equal(app.routes.has("/internal/kickoff/start-loop"), true);

  const kickoffHandler = getPostHandler(app, "/internal/kickoff");
  const reply = buildReply();
  const result = await kickoffHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.goal must be a non-empty string" });
});

test("POST /internal/kickoff returns 409 when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-409-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
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

test("POST /internal/kickoff writes goal.txt and returns success", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-200-"));
  const app = buildApp();
  let requestedRole = "";
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async ({ role }) => {
      requestedRole = String(role ?? "");
      return {
        statusCode: 200,
        payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] },
      };
    },
  });

  const goal = "Deliver a stable kickoff flow across API and dashboard.";
  const kickoffHandler = getPostHandler(app, "/internal/kickoff");
  const reply = buildReply();
  const result = await kickoffHandler({ body: { goal } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(requestedRole, "ORCHESTRATOR");
  assert.deepEqual(result, {
    status: "success",
    message: "Goal Received.",
  });

  const goalFile = await readFile(join(repoRoot, "goal.txt"), "utf8");
  assert.equal(goalFile, goal);
});

test("POST /internal/kickoff/start-loop returns 400 when sprint is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-400-sprint-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: {} }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.sprint must be one of M1, M2, M3, or M4" });
});

test("POST /internal/kickoff/start-loop returns 400 when goal.txt is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-400-goal-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async () => ({ statusCode: 200, payload: { status: "PASS" } }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "M1" } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "goal.txt is missing or empty; save a kickoff goal first" });
});

test("POST /internal/kickoff/start-loop returns 409 when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-409-preflight-"));
  await writeFile(join(repoRoot, "goal.txt"), "Kick off sprint goals\n", "utf8");
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async () => ({
      statusCode: 200,
      payload: {
        role: "ORCHESTRATOR",
        status: "FAIL",
        errors: [{ source: "template", message: "template missing" }],
      },
    }),
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "M1" } }, reply);

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(Array.isArray(result.errors), true);
});

test("POST /internal/kickoff/start-loop returns 409 when kickoff loop is already running", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-409-running-"));
  await writeFile(join(repoRoot, "goal.txt"), "Kick off sprint goals\n", "utf8");
  const app = buildApp();
  let startCalled = false;
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async () => ({ statusCode: 200, payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] } }),
    kickoffLoopManager: {
      getActive: () => ({
        pid: 1234,
        sprint: "M2",
        startedAt: "2026-02-26T09:30:00.000Z",
      }),
      start: async () => {
        startCalled = true;
        return null;
      },
    },
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "M2" } }, reply);

  assert.equal(reply.statusCode, 409);
  assert.equal(startCalled, false);
  assert.deepEqual(result, {
    status: "ALREADY_RUNNING",
    error: "Kickoff loop is already running for this repo",
    pid: 1234,
    sprint: "M2",
    started_at: "2026-02-26T09:30:00.000Z",
  });
});

test("POST /internal/kickoff/start-loop starts kickoff loop and returns 202", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-start-loop-202-"));
  await writeFile(join(repoRoot, "goal.txt"), "Kick off sprint goals\n", "utf8");
  const app = buildApp();
  let requestedRole = "";
  let sprintSeenByManager = "";
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightCheck: async ({ role }) => {
      requestedRole = String(role ?? "");
      return { statusCode: 200, payload: { role: "ORCHESTRATOR", status: "PASS", errors: [] } };
    },
    kickoffLoopManager: {
      getActive: () => null,
      start: async ({ sprint }) => {
        sprintSeenByManager = sprint;
        return {
          pid: 9123,
          sprint,
          startedAt: "2026-02-26T09:35:00.000Z",
        };
      },
    },
  });

  const startLoopHandler = getPostHandler(app, "/internal/kickoff/start-loop");
  const reply = buildReply();
  const result = await startLoopHandler({ body: { sprint: "m3" } }, reply);

  assert.equal(reply.statusCode, 202);
  assert.equal(requestedRole, "ORCHESTRATOR");
  assert.equal(sprintSeenByManager, "M3");
  assert.deepEqual(result, {
    status: "STARTED",
    message: "Kickoff loop started.",
    pid: 9123,
    sprint: "M3",
    started_at: "2026-02-26T09:35:00.000Z",
  });
});
