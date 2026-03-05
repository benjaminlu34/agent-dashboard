import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerInternalLogsRoute } from "../src/routes/internal-logs.js";
import { FakeRedisSub } from "./helpers/fake-redis.js";

test("GET /internal/logs/:runId returns empty transcript when no events exist", async () => {
  const app = Fastify({ logger: false });
  await registerInternalLogsRoute(app, {
    preflightHandler: async () => ({
      status: "PASS",
      errors: [],
    }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/internal/logs/test-run-1",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    logs: "",
    seq: 0,
    role: "",
  });

  await app.close();
});

test("POST /internal/logs/events appends transcript event and GET snapshot returns formatted logs", async () => {
  const app = Fastify({ logger: false });
  await registerInternalLogsRoute(app, {
    preflightHandler: async () => ({
      status: "PASS",
      errors: [],
    }),
  });

  const ingest = await app.inject({
    method: "POST",
    url: "/internal/logs/events",
    payload: {
      run_id: "run-abc-123",
      role: "EXECUTOR",
      section: "SYSTEM OBSERVATION",
      content: "Command: npm test",
    },
  });

  assert.equal(ingest.statusCode, 200);
  assert.equal(ingest.json().status, "ok");
  assert.equal(ingest.json().seq, 1);

  const snapshot = await app.inject({
    method: "GET",
    url: "/internal/logs/run-abc-123",
  });
  assert.equal(snapshot.statusCode, 200);
  const payload = snapshot.json();
  assert.equal(payload.seq, 1);
  assert.equal(payload.role, "EXECUTOR");
  assert.match(payload.logs, /========== SYSTEM OBSERVATION ==========/);
  assert.match(payload.logs, /Command: npm test/);

  await app.close();
});

test("POST /internal/logs/events returns 409 when preflight gate fails", async () => {
  const app = Fastify({ logger: false });
  await registerInternalLogsRoute(app, {
    preflightHandler: async () => ({
      status: "FAIL",
      role: "EXECUTOR",
      errors: [{ code: "template_missing", message: "missing template" }],
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/logs/events",
    payload: {
      run_id: "run-def-456",
      role: "EXECUTOR",
      section: "SYSTEM OBSERVATION",
      content: "Worker started",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().status, "FAIL");
  assert.equal(Array.isArray(response.json().errors), true);

  await app.close();
});

test("Redis Pub/Sub telemetry ingestion appends transcript events", async () => {
  const app = Fastify({ logger: false });
  const redisSub = new FakeRedisSub();
  await registerInternalLogsRoute(app, {
    redisSub,
    preflightHandler: async () => ({
      status: "PASS",
      errors: [],
    }),
  });

  redisSub.emitPMessage({
    channel: "telemetry:events:run-sub-1",
    message: JSON.stringify({
      run_id: "run-sub-1",
      role: "EXECUTOR",
      section: "SYSTEM OBSERVATION",
      content: "Hello from pubsub",
      created_at: "2026-02-28T12:00:00.000Z",
    }),
  });

  const snapshot = await app.inject({
    method: "GET",
    url: "/internal/logs/run-sub-1",
  });
  assert.equal(snapshot.statusCode, 200);
  const payload = snapshot.json();
  assert.equal(payload.role, "EXECUTOR");
  assert.match(payload.logs, /Hello from pubsub/);

  await app.close();
});
