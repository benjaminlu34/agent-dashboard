import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalStatusRoute } from "../src/routes/internal-status.js";

function buildReply() {
  return {
    statusCode: 200,
    headers: {},
    code(nextStatus) {
      this.statusCode = nextStatus;
      return this;
    },
    header(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
  };
}

function buildApp() {
  return {
    routePath: null,
    handler: null,
    get(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };
}

test("GET /internal/status reads scoped orchestrator and runner files from .agent-swarm.yml", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-scoped-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: Acme Org", "  repo: agent/dashboard"].join("\n"),
    "utf8",
  );

  await writeFile(
    join(repoRoot, ".orchestrator-state.Acme_Org.agent_dashboard.json"),
    JSON.stringify({ poll_count: 3, items: { PVTI_1: { last_seen_status: "In Progress" } } }, null, 2),
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".runner-ledger.Acme_Org.agent_dashboard.json"),
    JSON.stringify({ "run-1": { run_id: "run-1", status: "running" } }, null, 2),
    "utf8",
  );

  const app = buildApp();
  await registerInternalStatusRoute(app, { repoRoot, env: {} });

  assert.equal(app.routePath, "/internal/status");

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["x-target-owner"], "Acme Org");
  assert.equal(reply.headers["x-target-repo"], "agent/dashboard");
  assert.deepEqual(result, {
    orchestrator: { poll_count: 3, items: { PVTI_1: { last_seen_status: "In Progress" } } },
    runner: { "run-1": { run_id: "run-1", status: "running" } },
  });
});

test("GET /internal/status respects ORCHESTRATOR_STATE_PATH and RUNNER_LEDGER_PATH when set", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-env-"));
  await mkdir(join(repoRoot, "tmp"), { recursive: true });
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: sample-owner", "  repo: sample-repo"].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "tmp/custom-orchestrator.json"),
    JSON.stringify({ poll_count: 9 }, null, 2),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "tmp/custom-ledger.json"),
    JSON.stringify({ "run-9": { run_id: "run-9", status: "succeeded" } }, null, 2),
    "utf8",
  );

  const app = buildApp();
  await registerInternalStatusRoute(app, {
    repoRoot,
    env: {
      ORCHESTRATOR_STATE_PATH: "./tmp/custom-orchestrator.json",
      RUNNER_LEDGER_PATH: "./tmp/custom-ledger.json",
    },
  });

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.deepEqual(result, {
    orchestrator: { poll_count: 9 },
    runner: { "run-9": { run_id: "run-9", status: "succeeded" } },
  });
});

test("GET /internal/status returns empty objects when state files are missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-missing-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: owner", "  repo: repo"].join("\n"),
    "utf8",
  );

  const app = buildApp();
  await registerInternalStatusRoute(app, { repoRoot, env: {} });

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.deepEqual(result, {
    orchestrator: {},
    runner: {},
  });
});
