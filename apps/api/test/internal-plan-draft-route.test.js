import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPreflightHandler } from "../src/routes/internal-preflight.js";
import { registerInternalPlanDraftRoute } from "../src/routes/internal-plan-draft.js";

const TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/milestone-task.yml";

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
  await writeFile(join(repoRoot, "agents/PLANNER.md"), "planner overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board"}\n',
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
    '{"Planner":{"can_create_issues":true,"can_set_project_fields":true}}\n',
    "utf8",
  );
}

async function readProjectSchemaSnapshot({ repoRoot }) {
  const content = await readFile(join(repoRoot, "policy/project-schema.json"), "utf8");
  const schema = JSON.parse(content);
  return {
    project_name: schema.project_name,
    fields: schema.required_fields.map((field) => ({
      name: field.name,
      type: field.type,
      options: field.allowed_options,
    })),
  };
}

test("POST /internal/plan-draft returns 400 on wrong role", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-draft-400-"));
  await writeBundleFiles(repoRoot);
  await mkdir(join(repoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(join(repoRoot, TEMPLATE_PATH), "name: Milestone Task\n", "utf8");

  let modelCalls = 0;
  const app = buildApp();
  await registerInternalPlanDraftRoute(app, {
    repoRoot,
    preflightHandler: buildPreflightHandler({
      repoRoot,
      projectSchemaReader: () => readProjectSchemaSnapshot({ repoRoot }),
    }),
    planDraftGenerator: async () => {
      modelCalls += 1;
      return {};
    },
  });

  const reply = buildReply();
  const result = await app.handler({ body: { role: "EXECUTOR", sprint: "M1", goal: "Plan sprint work" } }, reply);

  assert.equal(app.routePath, "/internal/plan-draft");
  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.role must be PLANNER" });
  assert.equal(modelCalls, 0);
});

test("POST /internal/plan-draft returns 409 when preflight FAILs", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-draft-409-"));
  await writeBundleFiles(repoRoot);

  let modelCalls = 0;
  const app = buildApp();
  await registerInternalPlanDraftRoute(app, {
    repoRoot,
    preflightHandler: buildPreflightHandler({
      repoRoot,
      projectSchemaReader: () => readProjectSchemaSnapshot({ repoRoot }),
    }),
    planDraftGenerator: async () => {
      modelCalls += 1;
      return {};
    },
  });

  const reply = buildReply();
  const result = await app.handler({ body: { role: "PLANNER", sprint: "M1", goal: "Plan sprint work" } }, reply);

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(result.template.path, TEMPLATE_PATH);
  assert.equal(modelCalls, 0);
});

test("POST /internal/plan-draft returns 200 with expected draft shape", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-draft-200-"));
  await writeBundleFiles(repoRoot);
  await mkdir(join(repoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(join(repoRoot, TEMPLATE_PATH), "name: Milestone Task\n", "utf8");

  let modelCalls = 0;
  const app = buildApp();
  await registerInternalPlanDraftRoute(app, {
    repoRoot,
    preflightHandler: buildPreflightHandler({
      repoRoot,
      projectSchemaReader: () => readProjectSchemaSnapshot({ repoRoot }),
    }),
    planDraftGenerator: async ({ sprint }) => {
      modelCalls += 1;
      return {
        sprint,
        issues: [
          {
            title: "Implement run log envelope in API",
            goal: "Persist metadata for each runner invocation.",
            non_goals: ["No UI work"],
            acceptance_criteria: ["When POST /internal/run succeeds, metadata is persisted with role and bundle_hash."],
            files_likely_touched: ["apps/api/src/routes/internal-run.js", "packages/db/migrations/"],
            definition_of_done: ["Tests cover success and failure logging paths.", "Lint and typecheck pass."],
            size: "M",
            area: "api",
            priority: "P1",
            initial_status: "Ready",
          },
        ],
      };
    },
  });

  const reply = buildReply();
  const result = await app.handler(
    { body: { role: "PLANNER", sprint: "M1", goal: "Create a concrete sprint plan draft" } },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "DRAFT_READY");
  assert.equal(result.role, "PLANNER");
  assert.equal(result.sprint, "M1");
  assert.equal(result.goal, "Create a concrete sprint plan draft");
  assert.equal(typeof result.bundle_hash, "string");
  assert.equal(result.bundle_hash.length, 64);
  assert.equal(result.preflight.status, "PASS");
  assert.equal(result.draft.sprint, "M1");
  assert.equal(Array.isArray(result.draft.issues), true);
  assert.equal(result.draft.issues.length, 1);
  assert.equal(result.draft.issues[0].size, "M");
  assert.equal(result.draft.issues[0].area, "api");
  assert.equal(result.draft.issues[0].priority, "P1");
  assert.equal(result.draft.issues[0].initial_status, "Ready");
  assert.equal(modelCalls, 1);
});
