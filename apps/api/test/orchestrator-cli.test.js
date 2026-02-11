import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { mergeRunnerManagedStateFields } from "../../orchestrator/src/cli.js";

const REPO_ROOT = resolve(process.cwd());

function runNodeProcess({ args, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function withPreflightServer(payload, callback) {
  const server = http.createServer((request, response) => {
    if (request.url === "/internal/preflight?role=ORCHESTRATOR") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise((resolvePromise) => server.listen(0, resolvePromise));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  }
}

test("orchestrator CLI exits 2 when ORCHESTRATOR_SPRINT is missing", async () => {
  const result = await runNodeProcess({
    args: ["apps/orchestrator/src/cli.js", "--once"],
    env: {
      ...process.env,
      ORCHESTRATOR_SPRINT: "",
    },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /ORCHESTRATOR_SPRINT is required/);
});

test("orchestrator CLI exits 3 for malformed sprint-scoped item data", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-cli-malformed-"));
  const statePath = join(tempDir, "state.json");
  const itemsPath = join(tempDir, "items.json");

  await writeFile(
    itemsPath,
    JSON.stringify([
      { issue_number: 7, project_item_id: "PVTI_7", fields: { Sprint: "M1", Status: "Unknown" } },
    ]),
    "utf8",
  );

  const result = await withPreflightServer({ status: "PASS" }, async (baseUrl) =>
    runNodeProcess({
      args: ["apps/orchestrator/src/cli.js", "--once"],
      env: {
        ...process.env,
        ORCHESTRATOR_SPRINT: "M1",
        ORCHESTRATOR_ITEMS_FILE: itemsPath,
        ORCHESTRATOR_STATE_PATH: statePath,
        ORCHESTRATOR_BACKEND_BASE_URL: baseUrl,
        TARGET_OWNER_LOGIN: "o",
        TARGET_OWNER_TYPE: "user",
        TARGET_REPO_NAME: "r",
        TARGET_PROJECT_NAME: "Codex Task Board",
      },
    }),
  );

  assert.equal(result.code, 3);
  assert.match(result.stderr, /unknown Status=Unknown/);
});

test("orchestrator CLI exits 2 with clear error when ORCHESTRATOR_ITEMS_FILE is invalid JSON", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-cli-invalid-items-json-"));
  const statePath = join(tempDir, "state.json");
  const itemsPath = join(tempDir, "items-invalid.json");

  await writeFile(itemsPath, "<!DOCTYPE html><html><body>not json</body></html>", "utf8");

  const result = await withPreflightServer({ status: "PASS" }, async (baseUrl) =>
    runNodeProcess({
      args: ["apps/orchestrator/src/cli.js", "--once"],
      env: {
        ...process.env,
        ORCHESTRATOR_SPRINT: "M1",
        ORCHESTRATOR_ITEMS_FILE: itemsPath,
        ORCHESTRATOR_STATE_PATH: statePath,
        ORCHESTRATOR_BACKEND_BASE_URL: baseUrl,
        TARGET_OWNER_LOGIN: "o",
        TARGET_OWNER_TYPE: "user",
        TARGET_REPO_NAME: "r",
        TARGET_PROJECT_NAME: "Codex Task Board",
      },
    }),
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /ORCHESTRATOR_ITEMS_FILE must contain valid JSON array/);
});

test("orchestrator CLI resets corrupted state file and proceeds", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-cli-corrupt-state-"));
  const statePath = join(tempDir, "state.json");
  const itemsPath = join(tempDir, "items.json");

  await writeFile(
    itemsPath,
    JSON.stringify([
      { issue_number: 7, project_item_id: "PVTI_7", fields: { Sprint: "M1", Status: "Backlog" } },
    ]),
    "utf8",
  );
  await writeFile(statePath, "<!DOCTYPE html><html><body>not json</body></html>", "utf8");

  const result = await withPreflightServer({ status: "PASS" }, async (baseUrl) =>
    runNodeProcess({
      args: ["apps/orchestrator/src/cli.js", "--once"],
      env: {
        ...process.env,
        ORCHESTRATOR_SPRINT: "M1",
        ORCHESTRATOR_ITEMS_FILE: itemsPath,
        ORCHESTRATOR_STATE_PATH: statePath,
        ORCHESTRATOR_BACKEND_BASE_URL: baseUrl,
        TARGET_OWNER_LOGIN: "o",
        TARGET_OWNER_TYPE: "user",
        TARGET_REPO_NAME: "r",
        TARGET_PROJECT_NAME: "Codex Task Board",
      },
    }),
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /ORCHESTRATOR_STATE_RESET_INVALID_JSON/);
  assert.match(result.stderr, /"type":"DISPATCH_SUMMARY"/);

  const tempFiles = await readdir(tempDir);
  assert.equal(tempFiles.some((name) => name.startsWith("state.json.corrupt-")), true);
});

test("orchestrator CLI exits 4 when preflight reports transient template retries exhausted", async () => {
  const result = await withPreflightServer(
    {
      status: "FAIL",
      errors: [{ source: "template", code: "template_fetch_transient_exhausted" }],
    },
    async (baseUrl) =>
      runNodeProcess({
        args: ["apps/orchestrator/src/cli.js", "--once"],
        env: {
          ...process.env,
          ORCHESTRATOR_SPRINT: "M1",
          ORCHESTRATOR_BACKEND_BASE_URL: baseUrl,
          TARGET_OWNER_LOGIN: "o",
          TARGET_OWNER_TYPE: "user",
          TARGET_REPO_NAME: "r",
          TARGET_PROJECT_NAME: "Codex Task Board",
        },
      }),
  );

  assert.equal(result.code, 4);
  assert.match(result.stderr, /preflight failed for ORCHESTRATOR/);
});

test("orchestrator CLI prints end-of-sprint summary and exits 0 when sprint is complete", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orchestrator-cli-complete-"));
  const statePath = join(tempDir, "state.json");
  const itemsPath = join(tempDir, "items.json");

  await writeFile(
    itemsPath,
    JSON.stringify([
      { issue_number: 1, project_item_id: "PVTI_1", fields: { Sprint: "M1", Status: "Done" } },
      { issue_number: 2, project_item_id: "PVTI_2", fields: { Sprint: "M1", Status: "Blocked" } },
    ]),
    "utf8",
  );

  const result = await withPreflightServer({ status: "PASS" }, async (baseUrl) =>
    runNodeProcess({
      args: ["apps/orchestrator/src/cli.js", "--once"],
      env: {
        ...process.env,
        ORCHESTRATOR_SPRINT: "M1",
        ORCHESTRATOR_ITEMS_FILE: itemsPath,
        ORCHESTRATOR_STATE_PATH: statePath,
        ORCHESTRATOR_BACKEND_BASE_URL: baseUrl,
        TARGET_OWNER_LOGIN: "o",
        TARGET_OWNER_TYPE: "user",
        TARGET_REPO_NAME: "r",
        TARGET_PROJECT_NAME: "Codex Task Board",
      },
    }),
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /"type":"DISPATCH_SUMMARY"/);
  assert.match(result.stderr, /"type":"END_OF_SPRINT_SUMMARY"/);
  assert.match(result.stderr, /Awaiting Humans|awaiting_humans/);
});

test("mergeRunnerManagedStateFields preserves newer runner feedback in same status epoch", () => {
  const nextState = {
    poll_count: 9,
    items: {
      PVTI_1: {
        last_seen_status: "In Review",
        status_since_poll: 4,
        review_cycle_count: 0,
        last_reviewer_outcome: "",
        last_reviewer_feedback_at: "",
        last_executor_response_at: "",
      },
    },
  };
  const diskState = {
    poll_count: 8,
    items: {
      PVTI_1: {
        last_seen_status: "In Review",
        status_since_poll: 4,
        review_cycle_count: 1,
        last_reviewer_outcome: "FAIL",
        last_reviewer_feedback_at: "2026-02-07T12:01:00.000Z",
        last_executor_response_at: "",
      },
    },
  };

  const merged = mergeRunnerManagedStateFields({ nextState, diskState });
  assert.equal(merged.items.PVTI_1.last_reviewer_outcome, "FAIL");
  assert.equal(merged.items.PVTI_1.last_reviewer_feedback_at, "2026-02-07T12:01:00.000Z");
  assert.equal(merged.items.PVTI_1.review_cycle_count, 1);
});

test("mergeRunnerManagedStateFields does not carry feedback across status epoch changes", () => {
  const nextState = {
    poll_count: 9,
    items: {
      PVTI_1: {
        last_seen_status: "Ready",
        status_since_poll: 9,
        review_cycle_count: 0,
        last_reviewer_outcome: "",
        last_reviewer_feedback_at: "",
        last_executor_response_at: "",
      },
    },
  };
  const diskState = {
    poll_count: 8,
    items: {
      PVTI_1: {
        last_seen_status: "In Review",
        status_since_poll: 4,
        review_cycle_count: 2,
        last_reviewer_outcome: "FAIL",
        last_reviewer_feedback_at: "2026-02-07T12:01:00.000Z",
        last_executor_response_at: "2026-02-07T12:02:00.000Z",
      },
    },
  };

  const merged = mergeRunnerManagedStateFields({ nextState, diskState });
  assert.equal(merged.items.PVTI_1.last_reviewer_outcome, "");
  assert.equal(merged.items.PVTI_1.last_reviewer_feedback_at, "");
  assert.equal(merged.items.PVTI_1.last_executor_response_at, "");
  assert.equal(merged.items.PVTI_1.review_cycle_count, 0);
});
