import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalProjectItemUpdateFieldRoute } from "../src/routes/internal-project-item-update-field.js";

function buildPreflightPass() {
  return async () => ({
    role: "PLANNER",
    bundle_hash: "bundle-hash",
    template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 10, sha256: "abc" },
    project_schema: { status: "PASS", mismatches: [] },
    status: "PASS",
    errors: [],
  });
}

async function writeBundleFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });
  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/PLANNER.md"), "planner overlay\n", "utf8");
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
          { name: "Size", type: "single_select", allowed_options: ["S", "M", "L"] },
          { name: "Area", type: "single_select", allowed_options: ["db", "api", "web", "providers", "infra", "docs"] },
          { name: "Priority", type: "single_select", allowed_options: ["P0", "P1", "P2"] },
          { name: "Sprint", type: "single_select", allowed_options: ["M1", "M2", "M3", "M4"] },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/transitions.json"),
    JSON.stringify(
      {
        status_field: "Status",
        transitions: [
          { from: "Backlog", to: "Ready", allowed_roles: ["Planner"] },
          { from: "Ready", to: "In Progress", allowed_roles: ["Executor"] },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/role-permissions.json"),
    JSON.stringify(
      {
        Planner: { can_set_project_fields: true, can_update_status_only: false },
        Executor: { can_set_project_fields: false, can_update_status_only: true },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function buildTestApp(options) {
  const app = Fastify({ logger: false });
  await registerInternalProjectItemUpdateFieldRoute(app, options);
  return app;
}

test("POST /internal/project-item/update-field registers and updates Status from Backlog to Ready", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-ok-"));
  await writeBundleFiles(repoRoot);

  const captured = {
    getCalls: [],
    updateCalls: [],
  };
  const githubClientFactory = async () => ({
    async getProjectItemFieldValue({ projectItemId, field }) {
      captured.getCalls.push({ projectItemId, field });
      return "Backlog";
    },
    async updateProjectItemField({ projectItemId, field, value }) {
      captured.updateCalls.push({ projectItemId, field, value });
    },
  });

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "PLANNER",
      project_item_id: "PVTI_test_123",
      field: "Status",
      value: "Ready",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(response.json(), {
    role: "PLANNER",
    project_item_id: "PVTI_test_123",
    updated: {
      Status: "Ready",
    },
  });
  assert.deepEqual(captured.getCalls, [{ projectItemId: "PVTI_test_123", field: "Status" }]);
  assert.deepEqual(captured.updateCalls, [{ projectItemId: "PVTI_test_123", field: "Status", value: "Ready" }]);
  await app.close();
});

test("POST /internal/project-item/update-field returns 400 for field/value outside schema policy", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-schema-fail-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "Backlog";
      },
      async updateProjectItemField() {},
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "PLANNER",
      project_item_id: "PVTI_test_456",
      field: "Status",
      value: "UnknownStatus",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "value is not allowed for field by project schema policy" });
  await app.close();
});

test("POST /internal/project-item/update-field returns 403 for disallowed transition", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-transition-fail-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "Ready";
      },
      async updateProjectItemField() {
        throw new Error("should not be called");
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "PLANNER",
      project_item_id: "PVTI_test_789",
      field: "Status",
      value: "In Progress",
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: "status transition is not allowed by policy",
    from: "Ready",
    to: "In Progress",
  });
  await app.close();
});

test("POST /internal/project-item/update-field returns 409 when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-preflight-fail-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: async () => ({
      role: "PLANNER",
      status: "FAIL",
      errors: [{ source: "project_schema", message: "drift detected" }],
    }),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "Backlog";
      },
      async updateProjectItemField() {},
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "PLANNER",
      project_item_id: "PVTI_test_999",
      field: "Status",
      value: "Ready",
    },
  });

  assert.equal(response.statusCode, 409);
  const payload = response.json();
  assert.equal(payload.status, "FAIL");
  assert.equal(payload.errors[0].source, "project_schema");
  await app.close();
});
