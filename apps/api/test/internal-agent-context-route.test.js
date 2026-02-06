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

async function writeFixtureFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });

  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/PLANNER.md"), "planner overlay\n", "utf8");
  await writeFile(join(repoRoot, "policy/project-schema.json"), '{"project_name":"Codex Task Board"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status"}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Planner":{"can_create_issues":true}}\n', "utf8");
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

  await registerInternalAgentContextRoute(app, { repoRoot: tempRepoRoot });

  assert.equal(app.routePath, "/internal/agent-context");
  assert.equal(typeof app.handler, "function");

  const reply = buildReply();
  const result = await app.handler({ query: { role: "PLANNER" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "PLANNER");
  assert.equal(result.files.length, 5);
  assert.deepEqual(
    result.files.map((entry) => entry.path),
    [
      "AGENTS.md",
      "agents/PLANNER.md",
      "policy/project-schema.json",
      "policy/transitions.json",
      "policy/role-permissions.json",
    ],
  );

  const computedBundleHash = hash(
    result.files.map((entry) => `${entry.path}\n${entry.sha256}\n${entry.size_bytes}\n`).join(""),
  );
  assert.equal(result.bundle_hash, computedBundleHash);
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

  await registerInternalAgentContextRoute(app, { repoRoot: tempRepoRoot });

  const reply = buildReply();
  const result = await app.handler({ query: { role: "planner" } }, reply);

  assert.equal(reply.statusCode, 200);
  assert.equal(result.role, "PLANNER");
  assert.equal(result.files[1].path, "agents/PLANNER.md");
});
