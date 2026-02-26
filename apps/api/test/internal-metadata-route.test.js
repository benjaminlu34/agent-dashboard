import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalMetadataRoute } from "../src/routes/internal-metadata.js";

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

function buildApp() {
  return {
    routes: new Map(),
    get(path, handler) {
      this.routes.set(path, handler);
    },
  };
}

async function writeBundleFiles(repoRoot, { ownerLogin = "benjaminlu34", repositoryName = "agent-dashboard" } = {}) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });

  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/ORCHESTRATOR.md"), "orchestrator overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    JSON.stringify({
      owner_login: ownerLogin,
      owner_type: "user",
      project_name: "Codex Task Board",
      repository_name: repositoryName,
    }),
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/project-schema.json"), '{"project_name":"Codex Task Board"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Orchestrator":{"can_create_issues":true}}\n', "utf8");
}

test("registerInternalMetadataRoute registers issue and pr endpoints", async () => {
  const app = buildApp();
  await registerInternalMetadataRoute(app, {});

  assert.equal(typeof app.routes.get("/internal/metadata/issue"), "function");
  assert.equal(typeof app.routes.get("/internal/metadata/pr"), "function");
});

test("GET /internal/metadata/issue returns sanitized issue payload", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-issue-"));
  await writeBundleFiles(repoRoot);

  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });

    return buildJsonResponse({
      number: 17,
      title: "Improve metadata proxy",
      body: "Keep payload compact for agents.",
      state: "open",
      labels: [{ name: "api" }, "priority:P1"],
      assignee: { login: "alice", id: 12345 },
      assignees: [{ login: "alice" }, { login: "bob" }, { id: 999 }],
      html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/17",
      created_at: "2026-02-20T12:00:00Z",
      updated_at: "2026-02-21T13:00:00Z",
      closed_at: null,
      comments_url: "https://api.github.com/unused/comments",
      repository_url: "https://api.github.com/unused/repo",
      _links: { self: { href: "unused" } },
    });
  };

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: { GITHUB_TOKEN: "token-123" },
    fetchImpl,
  });

  const reply = buildReply();
  const handler = app.routes.get("/internal/metadata/issue");
  const result = await handler({ query: { issue_number: "17" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(result, {
    issue: {
      number: 17,
      title: "Improve metadata proxy",
      body: "Keep payload compact for agents.",
      state: "open",
      labels: ["api", "priority:P1"],
      assignee: { login: "alice" },
      assignees: [{ login: "alice" }, { login: "bob" }],
      html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/17",
      created_at: "2026-02-20T12:00:00Z",
      updated_at: "2026-02-21T13:00:00Z",
      closed_at: null,
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/repos/benjaminlu34/agent-dashboard/issues/17");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[0].options.headers.authorization, "Bearer token-123");
});

test("GET /internal/metadata/pr resolves env override identity and returns sanitized payload", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-pr-"));
  await writeBundleFiles(repoRoot, { ownerLogin: "policy-owner", repositoryName: "policy-repo" });

  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return buildJsonResponse({
      number: 88,
      title: "Add metadata route",
      body: "Implements read-only endpoint.",
      state: "open",
      draft: true,
      labels: [{ name: "backend" }],
      assignee: { login: "reviewer1" },
      assignees: [{ login: "reviewer1" }],
      html_url: "https://github.com/override-owner/override-repo/pull/88",
      created_at: "2026-02-22T10:00:00Z",
      updated_at: "2026-02-23T11:00:00Z",
      closed_at: null,
      merged_at: null,
      head: { ref: "feature/metadata", sha: "abc123" },
      base: { ref: "main", sha: "def456" },
      diff_url: "https://api.github.com/unused/diff",
      patch_url: "https://api.github.com/unused/patch",
      _links: { self: { href: "unused" } },
    });
  };

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: {
      GITHUB_TOKEN: "token-abc",
      TARGET_OWNER_LOGIN: "override-owner",
      TARGET_OWNER_TYPE: "user",
      TARGET_REPO_NAME: "override-repo",
      TARGET_PROJECT_NAME: "Override Project",
    },
    fetchImpl,
  });

  const reply = buildReply();
  const handler = app.routes.get("/internal/metadata/pr");
  const result = await handler({ query: { pr_number: "88" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(result, {
    pr: {
      number: 88,
      title: "Add metadata route",
      body: "Implements read-only endpoint.",
      state: "open",
      labels: ["backend"],
      assignee: { login: "reviewer1" },
      assignees: [{ login: "reviewer1" }],
      html_url: "https://github.com/override-owner/override-repo/pull/88",
      created_at: "2026-02-22T10:00:00Z",
      updated_at: "2026-02-23T11:00:00Z",
      closed_at: null,
      draft: true,
      merged_at: null,
      head: { ref: "feature/metadata", sha: "abc123" },
      base: { ref: "main", sha: "def456" },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "https://api.github.com/repos/override-owner/override-repo/pulls/88");
});

test("GET /internal/metadata/issue validates issue_number", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-issue-validate-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: { GITHUB_TOKEN: "token" },
    fetchImpl: async () => buildJsonResponse({}),
  });

  const handler = app.routes.get("/internal/metadata/issue");

  const missingReply = buildReply();
  const missingResult = await handler({ query: {} }, missingReply);
  assert.equal(missingReply.statusCode, 400);
  assert.match(missingResult.error, /issue_number/);

  const invalidReply = buildReply();
  const invalidResult = await handler({ query: { issue_number: "abc" } }, invalidReply);
  assert.equal(invalidReply.statusCode, 400);
  assert.match(invalidResult.error, /positive integer/);
});

test("GET /internal/metadata/pr validates pr_number", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-pr-validate-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: { GITHUB_TOKEN: "token" },
    fetchImpl: async () => buildJsonResponse({}),
  });

  const handler = app.routes.get("/internal/metadata/pr");
  const reply = buildReply();
  const result = await handler({ query: { pr_number: "-1" } }, reply);

  assert.equal(reply.statusCode, 400);
  assert.match(result.error, /pr_number/);
});

test("GET /internal/metadata/pr requires GITHUB_TOKEN", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-missing-token-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: {},
    fetchImpl: async () => buildJsonResponse({}),
  });

  const handler = app.routes.get("/internal/metadata/pr");
  const reply = buildReply();
  const result = await handler({ query: { pr_number: "44" } }, reply);

  assert.equal(reply.statusCode, 500);
  assert.equal(result.error, "GITHUB_TOKEN is required");
});

test("GET /internal/metadata/issue returns structured 404 for missing issue", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-metadata-404-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalMetadataRoute(app, {
    repoRoot,
    env: { GITHUB_TOKEN: "token" },
    fetchImpl: async () => buildJsonResponse({ message: "Not Found" }, 404),
  });

  const handler = app.routes.get("/internal/metadata/issue");
  const reply = buildReply();
  const result = await handler({ query: { issue_number: "999" } }, reply);

  assert.equal(reply.statusCode, 404);
  assert.deepEqual(result, {
    error: "not_found",
    resource: "issue",
    number: 999,
    owner_login: "benjaminlu34",
    repo_name: "agent-dashboard",
  });
});
