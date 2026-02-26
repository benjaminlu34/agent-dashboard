import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, loadAgentSwarmConfig } from "../src/config.js";

test("loadAgentSwarmConfig parses target owner/repo/project_v2_number", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-swarm-config-success-"));
  await writeFile(
    join(cwd, ".agent-swarm.yml"),
    `version: "1.0"
target:
  owner: "target-org-or-user"
  repo: "target-repo-name"
  project_v2_number: 1
`,
    "utf8",
  );

  const config = await loadAgentSwarmConfig({ cwd });

  assert.equal(config.target.owner, "target-org-or-user");
  assert.equal(config.target.repo, "target-repo-name");
  assert.equal(config.target.projectV2Number, 1);
  assert.equal(config.auth.githubTokenEnv, "GITHUB_TOKEN");
});

test("loadAgentSwarmConfig throws when required target fields are missing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-swarm-config-fail-"));
  await writeFile(
    join(cwd, ".agent-swarm.yml"),
    `version: "1.0"
target:
  owner: "target-org-or-user"
  repo: ""
`,
    "utf8",
  );

  await assert.rejects(
    () => loadAgentSwarmConfig({ cwd }),
    (error) => {
      assert.equal(error instanceof ConfigError, true);
      assert.equal(error.code, "invalid_field");
      assert.match(error.message, /target\.repo/);
      return true;
    },
  );
});
