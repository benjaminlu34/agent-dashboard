import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "../src/index.js";

async function writeFixtureFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });
  await mkdir(join(repoRoot, ".github/ISSUE_TEMPLATE"), { recursive: true });

  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/PLANNER.md"), "planner overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board"}\n',
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/project-schema.json"),
    '{"project_name":"Codex Task Board","required_fields":[]}\n',
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"transitions":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Planner":{"can_create_issues":true}}\n', "utf8");
  await writeFile(join(repoRoot, ".github/ISSUE_TEMPLATE/milestone-task.yml"), "name: Milestone Task\n", "utf8");
}

test("buildApp registers routes and GET /internal/agent-context returns 200 for role=PLANNER", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "api-index-route-"));
  await writeFixtureFiles(repoRoot);

  const app = await buildApp({ repoRoot, logger: false });

  const response = await app.inject({
    method: "GET",
    url: "/internal/agent-context?role=PLANNER",
  });

  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.role, "PLANNER");
  assert.equal(Array.isArray(payload.files), true);
  assert.equal(typeof payload.bundle_hash, "string");
  assert.equal(payload.bundle_hash.length, 64);

  await app.close();
});
