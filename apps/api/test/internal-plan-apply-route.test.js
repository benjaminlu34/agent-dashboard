import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalPlanApplyRoute } from "../src/routes/internal-plan-apply.js";

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
  await writeFile(join(repoRoot, "policy/project-schema.json"), '{"project_name":"Codex Task Board","required_fields":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"transitions":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Planner":{"can_create_issues":true}}\n', "utf8");
}

test("POST /internal/plan-apply creates markdown body with headings and checkboxes, and defaults status to Backlog", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-pass-"));
  await writeBundleFiles(repoRoot);

  const captured = {
    title: "",
    body: "",
    fieldsValues: null,
  };

  const githubClientFactory = async () => ({
    async createIssue({ title, body }) {
      captured.title = title;
      captured.body = body;
      return {
        issue_number: 101,
        issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/101",
        issue_node_id: "I_kw_test_101",
      };
    },
    async addIssueToProject() {
      return { project_item_id: "PVTI_test_101" };
    },
    async setProjectFields({ values }) {
      captured.fieldsValues = values;
    },
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "PLANNER",
        draft: {
          sprint: "M1",
          issues: [
            {
              title: "Build runner lifecycle persistence",
              goal: "Persist run metadata for observability.",
              non_goals: ["No UI pages"],
              acceptance_criteria: ["When run succeeds, metadata row exists in storage."],
              files_likely_touched: ["apps/api/src/routes/", "packages/db/migrations/"],
              definition_of_done: ["Tests cover success and error flows."],
              size: "M",
              area: "api",
              priority: "P1",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(app.routePath, "/internal/plan-apply");
  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");
  assert.equal(captured.title, "[TASK] Build runner lifecycle persistence");

  assert.match(captured.body, /^## Goal$/m);
  assert.match(captured.body, /^## Non-goals$/m);
  assert.match(captured.body, /^## Acceptance Criteria$/m);
  assert.match(captured.body, /^## Files Likely Touched$/m);
  assert.match(captured.body, /^## Definition of Done$/m);
  assert.match(captured.body, /^## Size$/m);

  assert.match(captured.body, /^- \[ \] When run succeeds, metadata row exists in storage\.$/m);
  assert.match(captured.body, /^- \[ \] Tests cover success and error flows\.$/m);

  assert.deepEqual(captured.fieldsValues, {
    Status: "Backlog",
    Size: "M",
    Area: "api",
    Priority: "P1",
    Sprint: "M1",
  });
});

test("POST /internal/plan-apply returns PARTIAL_FAIL shape when a later issue fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-partial-fail-"));
  await writeBundleFiles(repoRoot);

  let issueCounter = 0;
  const githubClientFactory = async () => ({
    async createIssue() {
      issueCounter += 1;
      return {
        issue_number: 200 + issueCounter,
        issue_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${200 + issueCounter}`,
        issue_node_id: `I_kw_test_${200 + issueCounter}`,
      };
    },
    async addIssueToProject({ issueNodeId }) {
      if (issueNodeId === "I_kw_test_202") {
        throw new Error("project add failed");
      }
      return { project_item_id: `PVTI_${issueNodeId}` };
    },
    async setProjectFields() {},
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "PLANNER",
        draft: {
          sprint: "M2",
          issues: [
            {
              title: "Issue one",
              goal: "Goal one",
              non_goals: ["Non-goal one"],
              acceptance_criteria: ["AC one"],
              files_likely_touched: ["apps/api/src/routes/"],
              definition_of_done: ["DoD one"],
              size: "S",
              area: "api",
              priority: "P2",
              initial_status: "Ready",
            },
            {
              title: "Issue two",
              goal: "Goal two",
              non_goals: ["Non-goal two"],
              acceptance_criteria: ["AC two"],
              files_likely_touched: ["packages/domain/src/"],
              definition_of_done: ["DoD two"],
              size: "M",
              area: "web",
              priority: "P1",
              initial_status: "Backlog",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 502);
  assert.equal(result.status, "PARTIAL_FAIL");
  assert.equal(Array.isArray(result.created), true);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.created[0], {
    index: 0,
    issue_number: 201,
    issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/201",
    project_item_id: "PVTI_I_kw_test_201",
    fields_set: {
      Status: "Ready",
      Size: "S",
      Area: "api",
      Priority: "P2",
      Sprint: "M2",
    },
  });
  assert.deepEqual(result.failed, {
    index: 1,
    step: "add_to_project",
    error: "project add failed",
  });
});

test("POST /internal/plan-apply returns 409 with preflight payload when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-preflight-fail-"));
  await writeBundleFiles(repoRoot);

  let githubClientFactoryCalled = false;
  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    preflightHandler: async () => ({
      role: "PLANNER",
      bundle_hash: "bundle-hash",
      template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 0, sha256: "" },
      project_schema: { status: "FAIL", mismatches: [] },
      status: "FAIL",
      errors: [{ source: "project_schema", message: "drift detected" }],
    }),
    githubClientFactory: async () => {
      githubClientFactoryCalled = true;
      return {};
    },
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "PLANNER",
        draft: {
          sprint: "M1",
          issues: [
            {
              title: "Issue one",
              goal: "Goal one",
              non_goals: ["Non-goal one"],
              acceptance_criteria: ["AC one"],
              files_likely_touched: ["apps/api/src/routes/"],
              definition_of_done: ["DoD one"],
              size: "S",
              area: "api",
              priority: "P2",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(result.errors[0].source, "project_schema");
  assert.equal(githubClientFactoryCalled, false);
});
