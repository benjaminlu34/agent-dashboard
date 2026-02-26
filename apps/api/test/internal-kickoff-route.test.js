import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
    routePath: null,
    handler: null,
    post(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };
}

test("POST /internal/kickoff returns 400 when goal is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-400-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightHandler: async () => ({ status: "PASS" }),
  });

  const reply = buildReply();
  const result = await app.handler({ body: {} }, reply);

  assert.equal(app.routePath, "/internal/kickoff");
  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.goal must be a non-empty string" });
});

test("POST /internal/kickoff returns 409 when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-kickoff-409-"));
  const app = buildApp();
  await registerInternalKickoffRoute(app, {
    repoRoot,
    preflightHandler: async () => ({
      role: "ORCHESTRATOR",
      status: "FAIL",
      errors: [{ source: "template", message: "template missing" }],
    }),
  });

  const reply = buildReply();
  const result = await app.handler({ body: { goal: "Kick off sprint goals" } }, reply);

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
    preflightHandler: async (request) => {
      requestedRole = String(request?.query?.role ?? "");
      return { role: "ORCHESTRATOR", status: "PASS", errors: [] };
    },
  });

  const goal = "Deliver a stable kickoff flow across API and dashboard.";
  const reply = buildReply();
  const result = await app.handler({ body: { goal } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(requestedRole, "ORCHESTRATOR");
  assert.deepEqual(result, {
    status: "success",
    message: "Goal Received.",
  });

  const goalFile = await readFile(join(repoRoot, "goal.txt"), "utf8");
  assert.equal(goalFile, goal);
});
