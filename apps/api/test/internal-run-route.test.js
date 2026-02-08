import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalRunRoute } from "../src/routes/internal-run.js";

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

async function writeBundleFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });

  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/ORCHESTRATOR.md"), "orchestrator overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board","repository_name":"agent-dashboard"}\n',
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/project-schema.json"),
    JSON.stringify(
      {
        project_name: "Codex Task Board",
        required_fields: [
          {
            name: "Status",
            type: "single_select",
            allowed_options: ["Backlog", "Ready", "In Progress", "In Review", "Blocked", "Done"],
          },
          {
            name: "Size",
            type: "single_select",
            allowed_options: ["S", "M", "L"],
          },
          {
            name: "Area",
            type: "single_select",
            allowed_options: ["db", "api", "web", "providers", "infra", "docs"],
          },
          {
            name: "Priority",
            type: "single_select",
            allowed_options: ["P0", "P1", "P2"],
          },
          {
            name: "Sprint",
            type: "single_select",
            allowed_options: ["M1", "M2", "M3", "M4"],
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status","transitions":[]}\n', "utf8");
  await writeFile(
    join(repoRoot, "policy/role-permissions.json"),
    JSON.stringify(
      {
        Orchestrator: {
          can_create_issues: true,
          can_set_project_fields: true,
          can_write_code: false,
          can_open_pr: false,
          can_merge: false,
          can_close_issues: false,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

test("POST /internal/run returns 400 when role is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-run-400-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalRunRoute(app, { repoRoot });

  const reply = buildReply();
  const result = await app.handler({ body: { task: "Implement task runner" } }, reply);

  assert.equal(app.routePath, "/internal/run");
  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.role is required" });
});

test("POST /internal/run returns 409 with preflight payload when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-run-409-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalRunRoute(app, {
    repoRoot,
    preflightHandler: async () => ({
      role: "ORCHESTRATOR",
      bundle_hash: "bundle-hash",
      template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 0, sha256: "" },
      project_schema: { status: "PASS", mismatches: [] },
      status: "FAIL",
      errors: [{ source: "template", code: "template_missing", path: ".github/ISSUE_TEMPLATE/milestone-task.yml" }],
    }),
  });

  const reply = buildReply();
  const result = await app.handler({ body: { role: "orchestrator", task: "Implement task runner" } }, reply);

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(result.template.path, ".github/ISSUE_TEMPLATE/milestone-task.yml");
  assert.equal(result.project_schema.status, "PASS");
  assert.equal(result.errors.some((error) => error.path === ".github/ISSUE_TEMPLATE/milestone-task.yml"), true);
});

test("POST /internal/run returns READY when preflight passes", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-run-200-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalRunRoute(app, {
    repoRoot,
    preflightHandler: async () => ({
      role: "ORCHESTRATOR",
      bundle_hash: "bundle-hash",
      template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 12, sha256: "abc" },
      project_schema: { status: "PASS", mismatches: [] },
      status: "PASS",
      errors: [],
    }),
  });

  const reply = buildReply();
  const result = await app.handler({ body: { role: "orchestrator", task: "Implement task runner" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "READY");
  assert.equal(result.role, "ORCHESTRATOR");
  assert.equal(result.task, "Implement task runner");
  assert.equal(typeof result.bundle_hash, "string");
  assert.equal(result.bundle_hash.length, 64);
  assert.deepEqual(result.preflight.project_schema, { status: "PASS", mismatches: [] });
  assert.deepEqual(result.allowed_capabilities, {
    can_create_issues: true,
    can_set_project_fields: true,
    can_write_code: false,
    can_open_pr: false,
    can_merge: false,
    can_close_issues: false,
  });
  assert.deepEqual(result.allowed_capabilities_minimal, {
    can_create_issues: true,
    can_set_project_fields: true,
    can_write_code: false,
    can_open_pr: false,
    can_merge: false,
    can_close_issues: false,
  });
});
