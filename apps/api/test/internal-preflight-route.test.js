import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalPreflightRoute } from "../src/routes/internal-preflight.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
    get(path, handler) {
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
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Planner":{"can_create_issues":true}}\n', "utf8");
}

test("GET /internal/preflight returns PASS with template and FAIL when template is missing", async () => {
  const templatePath = ".github/ISSUE_TEMPLATE/milestone-task.yml";

  const passRepoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-pass-"));
  await writeBundleFiles(passRepoRoot);
  await mkdir(join(passRepoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });
  const templateContent = "name: Milestone Task\n";
  await writeFile(join(passRepoRoot, templatePath), templateContent, "utf8");

  const liveProjectSchema = {
    project_name: "Codex Task Board",
    fields: [
      {
        name: "Status",
        type: "single_select",
        options: ["Backlog", "Ready", "In Progress", "In Review", "Blocked", "Done"],
      },
      {
        name: "Size",
        type: "single_select",
        options: ["S", "M", "L"],
      },
      {
        name: "Area",
        type: "single_select",
        options: ["db", "api", "web", "providers", "infra", "docs"],
      },
      {
        name: "Priority",
        type: "single_select",
        options: ["P0", "P1", "P2"],
      },
      {
        name: "Sprint",
        type: "single_select",
        options: ["M1", "M2", "M3", "M4"],
      },
    ],
  };

  const projectSchemaReader = async () => liveProjectSchema;

  const passApp = buildApp();
  await registerInternalPreflightRoute(passApp, { repoRoot: passRepoRoot, projectSchemaReader });
  assert.equal(passApp.routePath, "/internal/preflight");

  const passReply = buildReply();
  const passResult = await passApp.handler({ query: { role: "planner" } }, passReply);

  assert.equal(passReply.statusCode, 200);
  assert.equal(passResult.role, "PLANNER");
  assert.equal(passResult.status, "PASS");
  assert.deepEqual(passResult.errors, []);
  assert.deepEqual(passResult.project_schema, { status: "PASS", mismatches: [] });
  assert.equal(passResult.template.path, templatePath);
  assert.equal(passResult.template.size_bytes, Buffer.byteLength(templateContent, "utf8"));
  assert.equal(passResult.template.sha256, sha256(templateContent));
  assert.equal(typeof passResult.bundle_hash, "string");
  assert.equal(passResult.bundle_hash.length, 64);

  const failRepoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-fail-"));
  await writeBundleFiles(failRepoRoot);

  const failApp = buildApp();
  await registerInternalPreflightRoute(failApp, { repoRoot: failRepoRoot, projectSchemaReader });

  const failReply = buildReply();
  const failResult = await failApp.handler({ query: { role: "PLANNER" } }, failReply);

  assert.equal(failReply.statusCode, 200);
  assert.equal(failResult.role, "PLANNER");
  assert.equal(failResult.status, "FAIL");
  assert.equal(failResult.errors.length, 1);
  assert.equal(failResult.errors[0].path, templatePath);
  assert.deepEqual(failResult.project_schema, { status: "PASS", mismatches: [] });
  assert.equal(failResult.template.path, templatePath);
  assert.equal(failResult.template.size_bytes, 0);
  assert.equal(failResult.template.sha256, "");
  assert.equal(typeof failResult.bundle_hash, "string");
  assert.equal(failResult.bundle_hash.length, 64);
});

test("GET /internal/preflight returns FAIL when project schema verification fails", async () => {
  const templatePath = ".github/ISSUE_TEMPLATE/milestone-task.yml";
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-schema-fail-"));
  await writeBundleFiles(repoRoot);
  await mkdir(join(repoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(join(repoRoot, templatePath), "name: Milestone Task\n", "utf8");

  const failingSchemaReader = async () => ({
    project_name: "Codex Task Board",
    fields: [
      {
        name: "Status",
        type: "single_select",
        options: ["Backlog", "Ready", "In Progress", "In Review", "Blocked", "Done"],
      },
      {
        name: "Size",
        type: "single_select",
        options: ["S", "L", "M"],
      },
      {
        name: "Area",
        type: "single_select",
        options: ["db", "api", "web", "providers", "infra", "docs"],
      },
      {
        name: "Priority",
        type: "single_select",
        options: ["P0", "P1", "P2"],
      },
      {
        name: "Sprint",
        type: "single_select",
        options: ["M1", "M2", "M3", "M4"],
      },
    ],
  });

  const app = buildApp();
  await registerInternalPreflightRoute(app, { repoRoot, projectSchemaReader: failingSchemaReader });

  const routeReply = buildReply();
  const result = await app.handler({ query: { role: "planner" } }, routeReply);

  assert.equal(routeReply.statusCode, 200);
  assert.equal(result.project_schema.status, "FAIL");
  assert.equal(result.status, "FAIL");
  assert.equal(result.template.path, templatePath);
  assert.equal(result.errors.some((error) => error.source === "project_schema"), true);
});

test("GET /internal/preflight returns FAIL with project_identity source when github-project policy is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-project-identity-missing-"));
  await writeBundleFiles(repoRoot);
  await mkdir(join(repoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });
  await writeFile(join(repoRoot, ".github/ISSUE_TEMPLATE/milestone-task.yml"), "name: Milestone Task\n", "utf8");

  await unlink(join(repoRoot, "policy/github-project.json"));

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => ({ project_name: "", fields: [] }),
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "planner" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "FAIL");
  assert.equal(result.project_schema.status, "FAIL");
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], {
    source: "project_identity",
    path: "policy/github-project.json",
    message: "required project identity policy is missing",
  });
});
