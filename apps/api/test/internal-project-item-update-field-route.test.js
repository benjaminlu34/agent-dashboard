import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalProjectItemUpdateFieldRoute } from "../src/routes/internal-project-item-update-field.js";

function buildPreflightPass() {
  return async () => ({
    role: "ORCHESTRATOR",
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
  await writeFile(join(repoRoot, "agents/ORCHESTRATOR.md"), "orchestrator overlay\n", "utf8");
  await writeFile(join(repoRoot, "agents/HUMAN.md"), "human overlay\n", "utf8");
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
            allowed_options: ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"],
          },
          { name: "Size", type: "single_select", allowed_options: ["S", "M", "L"] },
          { name: "Area", type: "single_select", allowed_options: ["db", "api", "web", "providers", "infra", "docs"] },
          { name: "Priority", type: "single_select", allowed_options: ["P0", "P1", "P2"] },
          { name: "Sprint", type: "text" },
          { name: "DependsOn", type: "text" },
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
          { from: "Backlog", to: "Ready", allowed_roles: ["Orchestrator"] },
          { from: "Ready", to: "In Progress", allowed_roles: ["Executor"] },
          { from: "In Progress", to: "Blocked", allowed_roles: ["Orchestrator"] },
          { from: "In Review", to: "Blocked", allowed_roles: ["Orchestrator", "Executor"] },
          { from: "Blocked", to: "Ready", allowed_roles: ["Orchestrator"] },
          { from: "In Review", to: "Needs Human Approval", allowed_roles: ["Orchestrator"] },
          {
            from: "Needs Human Approval",
            to: "In Review",
            allowed_roles: ["Human"],
            automation_allowed: false,
          },
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
        Orchestrator: { can_set_project_fields: true, can_update_status_only: false },
        Executor: { can_set_project_fields: false, can_update_status_only: true },
        Reviewer: { can_set_project_fields: false, can_update_status_only: true },
        Human: { can_set_project_fields: false, can_update_status_only: true },
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
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_123",
      field: "Status",
      value: "Ready",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(response.json(), {
    role: "ORCHESTRATOR",
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
      role: "ORCHESTRATOR",
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
      role: "ORCHESTRATOR",
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
      role: "ORCHESTRATOR",
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
      role: "ORCHESTRATOR",
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

test("POST /internal/project-item/update-field requires handoff metadata and writes issue comment for orchestrator human-approval handoff", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-reviewer-handoff-"));
  await writeBundleFiles(repoRoot);
  await writeFile(join(repoRoot, "agents/REVIEWER.md"), "reviewer overlay\n", "utf8");

  const commentCalls = [];
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "In Review";
      },
      async updateProjectItemField() {},
      async createIssueComment(payload) {
        commentCalls.push(payload);
        return {
          id: 999,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/123#issuecomment-999",
        };
      },
    }),
  });

  const missingMetadata = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_123",
      field: "Status",
      value: "Needs Human Approval",
    },
  });
  assert.equal(missingMetadata.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_123",
      field: "Status",
      value: "Needs Human Approval",
      issue_number: 123,
      pr_url: "https://github.com/benjaminlu34/agent-dashboard/pull/456",
      checks_performed: ["Acceptance Criteria checklist", "Changed files review"],
      checks_passed: ["All acceptance criteria PASS", "Required tests pass"],
      human_steps: ["Approve and merge PR #456", "Verify deployment in staging"],
      run_id: "11111111-1111-4111-8111-111111111111",
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.updated.Status, "Needs Human Approval");
  assert.equal(payload.handoff_comment.id, 999);
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issueNumber, 123);
  assert.match(commentCalls[0].body, /Reviewer handoff: Needs Human Approval/);
  assert.match(commentCalls[0].body, /Linked PR: https:\/\/github.com\/benjaminlu34\/agent-dashboard\/pull\/456/);
  assert.match(commentCalls[0].body, /Human steps:/);
  await app.close();
});

test("POST /internal/project-item/update-field requires metadata and writes issue comment for human rework handoff", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-human-rework-"));
  await writeBundleFiles(repoRoot);

  const commentCalls = [];
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "Needs Human Approval";
      },
      async updateProjectItemField() {},
      async createIssueComment(payload) {
        commentCalls.push(payload);
        return {
          id: 1000,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/777#issuecomment-1000",
        };
      },
    }),
  });

  const missingMetadata = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "HUMAN",
      project_item_id: "PVTI_test_777",
      field: "Status",
      value: "In Review",
      issue_number: 777,
    },
  });
  assert.equal(missingMetadata.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "HUMAN",
      project_item_id: "PVTI_test_777",
      field: "Status",
      value: "In Review",
      issue_number: 777,
      human_rework_reason: "Please address reviewer findings before merge.",
      requested_actions: ["Fix failing acceptance criteria item R2", "Push updates to existing PR branch"],
      run_id: "abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd",
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.updated.Status, "In Review");
  assert.equal(payload.rework_comment.id, 1000);
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issueNumber, 777);
  assert.match(commentCalls[0].body, /Human rework request: Needs Human Approval -> In Review/);
  assert.match(commentCalls[0].body, /HUMAN_REWORK_REQUEST_V1/);
  assert.match(commentCalls[0].body, /requested_by_role: HUMAN/);
  await app.close();
});

test("POST /internal/project-item/update-field requires failure metadata and writes issue comment for executor failure handoff", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-executor-blocked-"));
  await writeBundleFiles(repoRoot);

  const commentCalls = [];
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "In Progress";
      },
      async updateProjectItemField() {},
      async createIssueComment(payload) {
        commentCalls.push(payload);
        return {
          id: 1001,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/321#issuecomment-1001",
        };
      },
    }),
  });

  const missingMetadata = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_321",
      field: "Status",
      value: "Blocked",
    },
  });
  assert.equal(missingMetadata.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_321",
      field: "Status",
      value: "Blocked",
      issue_number: 321,
      failure_classification: "ITEM_STOP",
      failure_message: "mcp call timed out",
      suggested_next_steps: ["Inspect logs for run_id", "Move back to Ready after fix"],
      run_id: "22222222-2222-4222-8222-222222222222",
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.updated.Status, "Blocked");
  assert.equal(payload.failure_comment.id, 1001);
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issueNumber, 321);
  assert.match(commentCalls[0].body, /Executor failure handoff: Blocked/);
  assert.match(commentCalls[0].body, /Failure classification: ITEM_STOP/);
  await app.close();
});

test("POST /internal/project-item/update-field requires failure metadata for In Review to Blocked and writes issue comment", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-review-failure-blocked-"));
  await writeBundleFiles(repoRoot);

  const commentCalls = [];
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "In Review";
      },
      async updateProjectItemField() {},
      async createIssueComment(payload) {
        commentCalls.push(payload);
        return {
          id: 1003,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/654#issuecomment-1003",
        };
      },
    }),
  });

  const missingMetadata = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_654",
      field: "Status",
      value: "Blocked",
    },
  });
  assert.equal(missingMetadata.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_654",
      field: "Status",
      value: "Blocked",
      issue_number: 654,
      failure_classification: "ITEM_STOP",
      failure_message: "executor fixup failed in review loop",
      suggested_next_steps: ["Address R1 on existing PR branch", "Move status back to In Review once resolved"],
      run_id: "44444444-4444-4444-8444-444444444444",
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.updated.Status, "Blocked");
  assert.equal(payload.failure_comment.id, 1003);
  assert.equal(commentCalls.length, 1);
  assert.match(commentCalls[0].body, /Failure stage: In Review -> Blocked/);
  await app.close();
});

test("POST /internal/project-item/update-field requires retry metadata and writes issue comment for Blocked to Ready retry", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "project-item-update-blocked-retry-"));
  await writeBundleFiles(repoRoot);

  const commentCalls = [];
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async getProjectItemFieldValue() {
        return "Blocked";
      },
      async updateProjectItemField() {},
      async createIssueComment(payload) {
        commentCalls.push(payload);
        return {
          id: 1002,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/222#issuecomment-1002",
        };
      },
    }),
  });

  const missingMetadata = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_222",
      field: "Status",
      value: "Ready",
    },
  });
  assert.equal(missingMetadata.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/internal/project-item/update-field",
    payload: {
      role: "ORCHESTRATOR",
      project_item_id: "PVTI_test_222",
      field: "Status",
      value: "Ready",
      issue_number: 222,
      retry_reason: "automatic_retry_after_cooldown",
      failure_classification: "TRANSIENT",
      failure_error_code: "backend_unreachable",
      blocked_minutes: 16,
      suggested_next_steps: ["Re-run executor", "Keep Blocked if repeated"],
      run_id: "33333333-3333-4333-8333-333333333333",
    },
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.updated.Status, "Ready");
  assert.equal(payload.retry_comment.id, 1002);
  assert.equal(commentCalls.length, 1);
  assert.equal(commentCalls[0].issueNumber, 222);
  assert.match(commentCalls[0].body, /Orchestrator retry handoff: Blocked -> Ready/);
  assert.match(commentCalls[0].body, /Retry reason: automatic_retry_after_cooldown/);
  await app.close();
});
