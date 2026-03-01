import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitHubTemplateReadError } from "../src/internal/github-template-reader.js";
import { registerInternalPreflightRoute } from "../src/routes/internal-preflight.js";

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
            allowed_options: ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"],
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
            type: "text",
          },
          {
            name: "DependsOn",
            type: "text",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Orchestrator":{"can_create_issues":true}}\n', "utf8");
}

function buildMatchingProjectSchema() {
  return {
    project_name: "Codex Task Board",
    fields: [
      {
        name: "Status",
        type: "single_select",
        options: ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"],
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
        type: "text",
        options: [],
      },
      {
        name: "DependsOn",
        type: "text",
        options: [],
      },
    ],
  };
}

test("GET /internal/preflight returns PASS when GitHub template metadata and project schema checks pass", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-pass-"));
  await writeBundleFiles(repoRoot);

  let templateReadArgs = null;
  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => buildMatchingProjectSchema(),
    templateMetadataReader: async (args) => {
      templateReadArgs = args;
      return {
        path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
        size_bytes: 123,
        sha256: "abc123",
      };
    },
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "ORCHESTRATOR");
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.project_schema, { status: "PASS", mismatches: [] });
  assert.deepEqual(result.template, {
    path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
    size_bytes: 123,
    sha256: "abc123",
  });
  assert.equal(templateReadArgs.owner_login, "benjaminlu34");
  assert.equal(templateReadArgs.repo_name, "agent-dashboard");
});

test("GET /internal/preflight returns FAIL when template is missing in target repo", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-template-missing-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => buildMatchingProjectSchema(),
    templateMetadataReader: async () => {
      throw new GitHubTemplateReadError("required issue template is missing in target repo", {
        code: "template_missing",
      });
    },
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "ORCHESTRATOR" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "FAIL");
  assert.equal(result.template.path, ".github/ISSUE_TEMPLATE/milestone-task.yml");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, "template");
  assert.equal(result.errors[0].code, "template_missing");
  assert.equal(result.errors[0].message, "required issue template is missing in target repo");
});

test("GET /internal/preflight returns FAIL when template transient retries are exhausted", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-template-transient-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => buildMatchingProjectSchema(),
    templateMetadataReader: async () => {
      throw new GitHubTemplateReadError("template fetch transient failures exhausted retries", {
        code: "template_fetch_transient_exhausted",
      });
    },
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "ORCHESTRATOR" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "FAIL");
  assert.equal(result.errors[0].code, "template_fetch_transient_exhausted");
});

test("GET /internal/preflight returns FAIL when project schema verification fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-schema-fail-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => ({
      project_name: "Codex Task Board",
      fields: [
        {
          name: "Status",
          type: "single_select",
          options: ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"],
        },
        {
          name: "Size",
          type: "single_select",
          options: ["S", "L"],
        },
      ],
    }),
    templateMetadataReader: async () => ({
      path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
      size_bytes: 1,
      sha256: "x",
    }),
  });

  const routeReply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator" } }, routeReply);

  assert.equal(routeReply.statusCode, 200);
  assert.equal(result.project_schema.status, "FAIL");
  assert.equal(result.status, "FAIL");
  assert.equal(result.errors.some((error) => error.source === "project_schema"), true);
});

test("GET /internal/preflight returns PASS when Status options match as a set with different order", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-status-order-pass-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => ({
      project_name: "Codex Task Board",
      fields: [
        {
          name: "Status",
          type: "single_select",
          options: ["Done", "Blocked", "Needs Human Approval", "In Review", "In Progress", "Ready", "Backlog"],
        },
        {
          name: "Size",
          type: "single_select",
          options: ["M", "L", "S"],
        },
        {
          name: "Area",
          type: "single_select",
          options: ["docs", "infra", "providers", "web", "api", "db"],
        },
        {
          name: "Priority",
          type: "single_select",
          options: ["P2", "P1", "P0"],
        },
        {
          name: "Sprint",
          type: "text",
          options: [],
        },
        {
          name: "DependsOn",
          type: "text",
          options: [],
        },
      ],
    }),
    templateMetadataReader: async () => ({
      path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
      size_bytes: 1,
      sha256: "x",
    }),
  });

  const routeReply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator" } }, routeReply);
  assert.equal(routeReply.statusCode, 200);
  assert.equal(result.project_schema.status, "PASS");
  assert.equal(result.status, "PASS");
});

test("GET /internal/preflight uses TARGET_* env override instead of policy/github-project.json identity", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-target-override-"));
  await writeBundleFiles(repoRoot);

  let templateReadArgs = null;
  let schemaReadArgs = null;

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    env: {
      TARGET_OWNER_LOGIN: "target-owner",
      TARGET_OWNER_TYPE: "org",
      TARGET_REPO_NAME: "target-repo",
      TARGET_PROJECT_NAME: "Target Board",
      TARGET_TEMPLATE_PATH: ".github/ISSUE_TEMPLATE/custom.yml",
      TARGET_REF: "main",
    },
    projectSchemaReader: async ({ projectIdentity }) => {
      schemaReadArgs = projectIdentity;
      return { project_name: "Codex Task Board", fields: [] };
    },
    templateMetadataReader: async (args) => {
      templateReadArgs = args;
      return {
        path: args.path,
        size_bytes: 32,
        sha256: "override",
      };
    },
  });

  const reply = buildReply();
  await app.handler({ query: { role: "ORCHESTRATOR" } }, reply);

  assert.deepEqual(schemaReadArgs, {
    owner_login: "target-owner",
    owner_type: "org",
    project_name: "Target Board",
  });
  assert.equal(templateReadArgs.repo_name, "target-repo");
  assert.equal(templateReadArgs.path, ".github/ISSUE_TEMPLATE/custom.yml");
  assert.equal(templateReadArgs.ref, "main");
});

test("GET /internal/preflight fails closed with missing TARGET_* vars list when override is partial", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-target-partial-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    env: {
      TARGET_OWNER_LOGIN: "only-owner",
    },
    projectSchemaReader: async () => buildMatchingProjectSchema(),
    templateMetadataReader: async () => ({
      path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
      size_bytes: 1,
      sha256: "x",
    }),
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "ORCHESTRATOR" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "FAIL");
  assert.equal(result.errors[0].code, "target_identity_missing_env");
  assert.deepEqual(result.errors[0].missing, ["TARGET_OWNER_TYPE", "TARGET_REPO_NAME", "TARGET_PROJECT_NAME"]);
});

test("GET /internal/preflight returns FAIL with project_identity source when github-project policy is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-project-identity-missing-"));
  await writeBundleFiles(repoRoot);
  await unlink(join(repoRoot, "policy/github-project.json"));

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => ({ project_name: "", fields: [] }),
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "FAIL");
  assert.equal(result.project_schema.status, "FAIL");
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.errors[0], {
    source: "project_identity",
    path: "policy/github-project.json",
    code: "target_identity_error",
    message: "required project identity policy is missing",
  });
});

test("GET /internal/preflight returns 500 when role bundle is missing (PLANNER removed)", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "agent-preflight-planner-removed-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPreflightRoute(app, {
    repoRoot,
    projectSchemaReader: async () => ({ project_name: "Codex Task Board", fields: [] }),
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "PLANNER" } }, reply);

  assert.equal(reply.statusCode, 500);
  assert.deepEqual(result, {
    error: "required file is missing",
    path: "agents/PLANNER.md",
  });
});
