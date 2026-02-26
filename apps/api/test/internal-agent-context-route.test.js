import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalAgentContextRoute } from "../src/routes/internal-agent-context.js";

function hash(value) {
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

function buildJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function writeFixtureFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });

  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/ORCHESTRATOR.md"), "orchestrator overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board","repository_name":"agent-dashboard"}\n',
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/project-schema.json"), '{"project_name":"Codex Task Board"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Orchestrator":{"can_create_issues":true}}\n', "utf8");
}

test("GET /internal/agent-context returns ordered bundle payload", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "agent-context-bundle-"));
  await writeFixtureFiles(tempRepoRoot);

  const app = {
    routePath: null,
    handler: null,
    get(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };

  await registerInternalAgentContextRoute(app, { repoRoot: tempRepoRoot, env: {} });

  assert.equal(app.routePath, "/internal/agent-context");
  assert.equal(typeof app.handler, "function");

  const reply = buildReply();
  const result = await app.handler({ query: { role: "ORCHESTRATOR" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "ORCHESTRATOR");
  assert.equal(result.files.length, 6);
  assert.deepEqual(
    result.files.map((entry) => entry.path),
    [
      "AGENTS.md",
      "agents/ORCHESTRATOR.md",
      "policy/github-project.json",
      "policy/project-schema.json",
      "policy/transitions.json",
      "policy/role-permissions.json",
    ],
  );

  const computedBundleHash = hash(
    result.files.map((entry) => `${entry.path}\n${entry.sha256}\n${entry.size_bytes}\n`).join(""),
  );
  assert.equal(result.bundle_hash, computedBundleHash);
  assert.deepEqual(result.task_brief, {});
  assert.deepEqual(result.repository_map, []);
});

test("GET /internal/agent-context accepts lowercase role and normalizes it", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "agent-context-bundle-"));
  await writeFixtureFiles(tempRepoRoot);

  const app = {
    routePath: null,
    handler: null,
    get(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };

  await registerInternalAgentContextRoute(app, { repoRoot: tempRepoRoot, env: {} });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "ORCHESTRATOR");
  assert.equal(result.files[1].path, "agents/ORCHESTRATOR.md");
  assert.deepEqual(result.task_brief, {});
  assert.deepEqual(result.repository_map, []);
});

test("GET /internal/agent-context includes parsed task_brief and filtered repository_map", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "agent-context-bundle-"));
  await writeFixtureFiles(tempRepoRoot);
  await writeFile(
    join(tempRepoRoot, ".agent-swarm.yml"),
    [
      "version: \"1.0\"",
      "agent:",
      "  ignore_paths:",
      "    - node_modules",
      "    - .git",
      "    - dist",
      "    - build",
      "    - __pycache__",
      "    - .env*",
    ].join("\n"),
    "utf8",
  );

  const app = {
    routePath: null,
    handler: null,
    get(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/issues/42")) {
      return buildJsonResponse({
        body: [
          "### Goal",
          "Ship enriched context payload.",
          "",
          "### Non-goals",
          "- Do not change runner policy contracts.",
          "",
          "### Acceptance Criteria",
          "- endpoint includes task_brief",
          "- endpoint includes repository_map",
          "",
          "### Files Likely Touched",
          "- apps/api/src/routes/internal-agent-context.js",
          "",
          "### Definition of Done",
          "- tests pass",
        ].join("\n"),
      });
    }

    if (href.includes("/git/trees/HEAD?recursive=1")) {
      return buildJsonResponse({
        tree: [
          { path: "apps/api/src/routes/internal-agent-context.js", type: "blob" },
          { path: "apps/api/src/internal/task-brief-parser.js", type: "blob" },
          { path: "node_modules/pkg/index.js", type: "blob" },
          { path: ".git/config", type: "blob" },
          { path: "dist/output.js", type: "blob" },
          { path: "build/output.js", type: "blob" },
          { path: "__pycache__/cache.pyc", type: "blob" },
          { path: ".env", type: "blob" },
        ],
      });
    }

    return buildJsonResponse({ message: "not found" }, 404);
  };

  await registerInternalAgentContextRoute(app, {
    repoRoot: tempRepoRoot,
    env: { GITHUB_TOKEN: "token" },
    fetchImpl,
  });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "orchestrator", issue_number: "42" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "ORCHESTRATOR");
  assert.deepEqual(result.task_brief, {
    goal: "Ship enriched context payload.",
    non_goals: "- Do not change runner policy contracts.",
    acceptance_criteria: "- endpoint includes task_brief\n- endpoint includes repository_map",
    files_likely_touched: "- apps/api/src/routes/internal-agent-context.js",
    definition_of_done: "- tests pass",
  });
  assert.deepEqual(result.repository_map, [
    "apps/api/src/internal/task-brief-parser.js",
    "apps/api/src/routes/internal-agent-context.js",
  ]);
});

test("GET /internal/agent-context returns 400 when issue_number is invalid", async () => {
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "agent-context-bundle-"));
  await writeFixtureFiles(tempRepoRoot);

  const app = {
    routePath: null,
    handler: null,
    get(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };

  await registerInternalAgentContextRoute(app, { repoRoot: tempRepoRoot, env: {} });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "ORCHESTRATOR", issue_number: "abc" } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.match(result.error, /issue_number/);
});
