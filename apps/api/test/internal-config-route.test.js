import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import YAML from "yaml";

import { registerInternalConfigRoute } from "../src/routes/internal-config.js";

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
    routes: new Map(),
    get(path, handler) {
      this.routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      this.routes.set(`POST ${path}`, handler);
    },
  };
}

test("GET /internal/config creates missing config files and returns defaults", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-config-defaults-"));
  const app = buildApp();
  await registerInternalConfigRoute(app, { repoRoot });

  const getHandler = app.routes.get("GET /internal/config");
  assert.equal(typeof getHandler, "function");

  const reply = buildReply();
  const result = await getHandler({}, reply);

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(result, {
    targetOwner: "",
    targetRepo: "",
    projectNumber: null,
    maxExecutors: null,
    maxReviewers: null,
    hasGithubToken: false,
  });

  const rawConfig = await readFile(join(repoRoot, ".agent-swarm.yml"), "utf8");
  const parsedConfig = YAML.parse(rawConfig);
  assert.deepEqual(parsedConfig, {
    version: "1.0",
    target: {
      owner: "",
      repo: "",
      project_v2_number: null,
    },
    auth: {
      github_token_env: "GITHUB_TOKEN",
    },
  });

  const rawEnv = await readFile(join(repoRoot, ".env"), "utf8");
  assert.equal(rawEnv, "");
});

test("GET /internal/config reads target and runner values from .agent-swarm.yml and .env", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-config-read-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    [
      "version: \"1.0\"",
      "target:",
      "  owner: acme",
      "  repo: swarm",
      "  project_v2_number: 7",
      "auth:",
      "  github_token_env: GITHUB_TOKEN",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".env"),
    ["GITHUB_TOKEN=abc123", "RUNNER_MAX_EXECUTORS=4", "RUNNER_MAX_REVIEWERS=2"].join("\n"),
    "utf8",
  );

  const app = buildApp();
  await registerInternalConfigRoute(app, { repoRoot });
  const getHandler = app.routes.get("GET /internal/config");

  const result = await getHandler({}, buildReply());
  assert.deepEqual(result, {
    targetOwner: "acme",
    targetRepo: "swarm",
    projectNumber: 7,
    maxExecutors: 4,
    maxReviewers: 2,
    hasGithubToken: true,
  });
});

test("POST /internal/config updates .agent-swarm.yml and upserts .env values", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-config-write-"));
  await writeFile(
    join(repoRoot, ".agent-swarm.yml"),
    [
      "version: \"1.0\"",
      "target:",
      "  owner: old-owner",
      "  repo: old-repo",
      "  project_v2_number: 1",
      "agent:",
      "  ignore_paths:",
      "    - node_modules/**",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".env"),
    ["RUNNER_MAX_EXECUTORS=1", "OTHER_SETTING=keep-me", "GITHUB_TOKEN=old-token"].join("\n"),
    "utf8",
  );

  const app = buildApp();
  await registerInternalConfigRoute(app, { repoRoot });
  const postHandler = app.routes.get("POST /internal/config");
  assert.equal(typeof postHandler, "function");

  const reply = buildReply();
  const payload = await postHandler(
    {
      body: {
        targetOwner: "new-owner",
        targetRepo: "new-repo",
        projectNumber: 11,
        maxExecutors: 5,
        maxReviewers: 3,
        githubToken: "new token value",
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(payload, {
    targetOwner: "new-owner",
    targetRepo: "new-repo",
    projectNumber: 11,
    maxExecutors: 5,
    maxReviewers: 3,
    hasGithubToken: true,
  });

  const updatedConfig = YAML.parse(await readFile(join(repoRoot, ".agent-swarm.yml"), "utf8"));
  assert.equal(updatedConfig.target.owner, "new-owner");
  assert.equal(updatedConfig.target.repo, "new-repo");
  assert.equal(updatedConfig.target.project_v2_number, 11);
  assert.deepEqual(updatedConfig.agent, { ignore_paths: ["node_modules/**"] });

  const updatedEnv = await readFile(join(repoRoot, ".env"), "utf8");
  assert.match(updatedEnv, /^RUNNER_MAX_EXECUTORS=5$/m);
  assert.match(updatedEnv, /^RUNNER_MAX_REVIEWERS=3$/m);
  assert.match(updatedEnv, /^GITHUB_TOKEN="new token value"$/m);
  assert.match(updatedEnv, /^OTHER_SETTING=keep-me$/m);
});

test("POST /internal/config keeps existing token when githubToken is omitted", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-config-token-omit-"));
  await writeFile(join(repoRoot, ".agent-swarm.yml"), "{}", "utf8");
  await writeFile(join(repoRoot, ".env"), "GITHUB_TOKEN=already-set\n", "utf8");

  const app = buildApp();
  await registerInternalConfigRoute(app, { repoRoot });
  const postHandler = app.routes.get("POST /internal/config");

  const result = await postHandler(
    {
      body: {
        targetOwner: "owner",
        targetRepo: "repo",
        projectNumber: 3,
        maxExecutors: 2,
        maxReviewers: 2,
      },
    },
    buildReply(),
  );

  assert.equal(result.hasGithubToken, true);

  const updatedEnv = await readFile(join(repoRoot, ".env"), "utf8");
  assert.match(updatedEnv, /^GITHUB_TOKEN=already-set$/m);
});
