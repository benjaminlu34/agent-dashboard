import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalStatusRoute } from "../src/routes/internal-status.js";
import { FakeRedis } from "./helpers/fake-redis.js";

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

test("GET /internal/status reads orchestrator state + ledger from Redis scoped by .agent-swarm.yml", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-scoped-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: Acme Org", "  repo: agent/dashboard"].join("\n"),
    "utf8",
  );

  const redis = new FakeRedis();
  const repoKey = "Acme_Org.agent_dashboard";
  await redis.hset(`orchestrator:state:${repoKey}:root`, {
    poll_count: "3",
    sprint_phase: "ACTIVE",
  });
  await redis.hset(`orchestrator:state:${repoKey}:items`, {
    PVTI_1: JSON.stringify({ last_seen_status: "In Progress" }),
  });
  await redis.hset(`orchestrator:ledger:${repoKey}`, {
    "run-1": JSON.stringify({ run_id: "run-1", status: "running" }),
  });

  const app = buildApp();
  await registerInternalStatusRoute(app, { repoRoot, redis });

  assert.equal(app.routePath, "/internal/status");

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers["x-target-owner"], "Acme Org");
  assert.equal(reply.headers["x-target-repo"], "agent/dashboard");
  assert.equal(result.orchestrator.poll_count, 3);
  assert.equal(result.orchestrator.sprint_phase, "ACTIVE");
  assert.deepEqual(result.orchestrator.items, { PVTI_1: { last_seen_status: "In Progress" } });
  assert.equal(result.runner.plan_version, "");
  assert.deepEqual(result.runner.runs["run-1"], { run_id: "run-1", status: "running" });
});

test("GET /internal/status extracts plan_version from ledger meta and filters __task__ entries", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-meta-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: sample-owner", "  repo: sample-repo"].join("\n"),
    "utf8",
  );

  const redis = new FakeRedis();
  const repoKey = "sample-owner.sample-repo";
  await redis.hset(`orchestrator:ledger:${repoKey}`, {
    "__meta__:plan_version": "2026-02-28T12:00:00.000Z",
    "__task__:PVTI_1": JSON.stringify({ last_activity_at: "2026-02-28T12:00:00.000Z" }),
    "run-9": JSON.stringify({ run_id: "run-9", status: "succeeded" }),
  });

  const app = buildApp();
  await registerInternalStatusRoute(app, { repoRoot, redis });

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.equal(result.runner.plan_version, "2026-02-28T12:00:00.000Z");
  assert.equal(typeof result.runner.runs["run-9"], "object");
  assert.equal(result.runner.runs["__task__:PVTI_1"], undefined);
});

test("GET /internal/status returns empty objects when state files are missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-status-missing-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    ["target:", "  owner: owner", "  repo: repo"].join("\n"),
    "utf8",
  );

  const app = buildApp();
  const redis = new FakeRedis();
  await registerInternalStatusRoute(app, { repoRoot, redis });

  const reply = buildReply();
  const result = await app.handler({}, reply);

  assert.deepEqual(result, {
    orchestrator: {},
    runner: {},
  });
});
