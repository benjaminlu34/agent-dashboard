import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalSprintSealRoute } from "../src/routes/internal-sprint-seal.js";

function buildPreflightPass() {
  return async () => ({
    role: "ORCHESTRATOR",
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
          { name: "Status", type: "single_select", allowed_options: ["Backlog", "Ready", "In Progress"] },
          { name: "Size", type: "single_select", allowed_options: ["S", "M", "L"] },
          { name: "Area", type: "single_select", allowed_options: ["api"] },
          { name: "Priority", type: "single_select", allowed_options: ["P0", "P1", "P2"] },
          { name: "Sprint", type: "text" },
          { name: "DependsOn", type: "text" },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"transitions":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Orchestrator":{"can_create_issues":true}}\n', "utf8");
}

async function buildTestApp(options) {
  const app = Fastify({ logger: false });
  await registerInternalSprintSealRoute(app, options);
  return app;
}

test("POST /internal/sprint/seal returns 400 for dangling DependsOn references", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-sprint-seal-dangling-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [
          {
            project_item_id: "PVTI_45",
            issue_number: 45,
            issue_title: "Task 45",
            issue_url: "https://github.com/acme/repo/issues/45",
            fields: { Sprint: "M1-20260228", DependsOn: "#42" },
          },
        ];
      },
    }),
    nowIso: () => "2026-02-28T12:00:00.000Z",
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/sprint/seal",
    payload: { role: "ORCHESTRATOR", sprint: "M1-20260228" },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "dangling_depends_on_references",
    errors: ["Issue #42 is referenced by #45 but does not exist in this sprint"],
  });

  await assert.rejects(readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8"), /ENOENT/);
  await assert.rejects(
    readFile(join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"), "utf8"),
    /ENOENT/,
  );

  await app.close();
});

test("POST /internal/sprint/seal returns 400 when DependsOn introduces a cycle", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-sprint-seal-cycle-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [
          {
            project_item_id: "PVTI_1",
            issue_number: 1,
            issue_title: "Task 1",
            issue_url: "https://github.com/acme/repo/issues/1",
            fields: { Sprint: "M1-20260228", DependsOn: "#2" },
          },
          {
            project_item_id: "PVTI_2",
            issue_number: 2,
            issue_title: "Task 2",
            issue_url: "https://github.com/acme/repo/issues/2",
            fields: { Sprint: "M1-20260228", DependsOn: "#1" },
          },
        ];
      },
    }),
    nowIso: () => "2026-02-28T12:00:00.000Z",
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/sprint/seal",
    payload: { role: "ORCHESTRATOR", sprint: "M1-20260228" },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "dependency_cycle_detected",
    cycles: [
      [
        { project_item_id: "PVTI_1", issue_number: 1 },
        { project_item_id: "PVTI_2", issue_number: 2 },
      ],
    ],
  });

  await assert.rejects(readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8"), /ENOENT/);
  await assert.rejects(
    readFile(join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"), "utf8"),
    /ENOENT/,
  );

  await app.close();
});

test("POST /internal/sprint/seal writes runner caches and updates orchestrator state", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-sprint-seal-success-"));
  await writeBundleFiles(repoRoot);

  const planVersion = "2026-02-28T12:00:00.000Z";

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [
          {
            project_item_id: "PVTI_20",
            issue_number: 20,
            issue_title: "Task 20",
            issue_url: "https://github.com/acme/repo/issues/20",
            fields: { Sprint: "M1-20260228", DependsOn: "" },
          },
          {
            project_item_id: "PVTI_10",
            issue_number: 10,
            issue_title: "Task 10",
            issue_url: "https://github.com/acme/repo/issues/10",
            fields: { Sprint: "M1-20260228", DependsOn: " #20 " },
          },
          {
            project_item_id: "PVTI_30",
            issue_number: 30,
            issue_title: "Task 30",
            issue_url: "https://github.com/acme/repo/issues/30",
            fields: { Sprint: "M1-20260228", DependsOn: "\n#20\n" },
          },
        ];
      },
    }),
    nowIso: () => planVersion,
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/sprint/seal",
    payload: { sprint: "M1-20260228" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "SEALED", plan_version: planVersion });

  const planRaw = await readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8");
  const plan = JSON.parse(planRaw);
  assert.equal(plan.plan_version, planVersion);
  assert.equal(plan.sprint, "M1-20260228");
  assert.deepEqual(
    plan.tasks.map((task) => ({ issue_number: task.issue_number, depends_on: task.depends_on })),
    [
      { issue_number: 10, depends_on: ["PVTI_20"] },
      { issue_number: 20, depends_on: [] },
      { issue_number: 30, depends_on: ["PVTI_20"] },
    ],
  );

  const ledgerRaw = await readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8");
  const ledger = JSON.parse(ledgerRaw);
  assert.equal(ledger.plan_version, planVersion);
  assert.deepEqual(ledger.runs, {});
  assert.equal(ledger.tasks.PVTI_10.last_activity_at, planVersion);
  assert.equal(ledger.tasks.PVTI_20.last_activity_at, planVersion);
  assert.equal(ledger.tasks.PVTI_30.last_activity_at, planVersion);

  const orchestratorRaw = await readFile(join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"), "utf8");
  const orchestrator = JSON.parse(orchestratorRaw);
  assert.equal(orchestrator.sprint_phase, "ACTIVE");
  assert.equal(orchestrator.sealed_at, planVersion);

  await assert.rejects(readFile(join(repoRoot, ".runner-sprint-plan.json.tmp"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json.tmp"), "utf8"), /ENOENT/);

  await app.close();
});

test("POST /internal/sprint/seal returns 409 when sprint is ACTIVE and runner ledger has runs", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-sprint-seal-active-has-runs-"));
  await writeBundleFiles(repoRoot);

  await writeFile(
    join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"),
    JSON.stringify(
      {
        sprint_phase: "ACTIVE",
        sealed_at: "2026-02-28T11:00:00.000Z",
        poll_count: 0,
        items: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"),
    JSON.stringify(
      {
        plan_version: "2026-02-28T11:00:00.000Z",
        runs: {
          "run-1": {
            run_id: "run-1",
            role: "ORCHESTRATOR",
            status: "running",
            result: null,
          },
        },
        tasks: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  let githubFactoryCalls = 0;

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => {
      githubFactoryCalls += 1;
      return {
        async listProjectItems() {
          throw new Error("should not fetch project items when reseal is rejected");
        },
      };
    },
    nowIso: () => "2026-02-28T12:00:00.000Z",
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/sprint/seal",
    payload: { sprint: "M1-20260228" },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "sprint_already_active",
    detail: "Runner ledger contains execution runs; reseal is not allowed once execution starts.",
  });
  assert.equal(githubFactoryCalls, 0);

  await app.close();
});

test("POST /internal/sprint/seal allows reseal when sprint is ACTIVE but runner ledger has no runs", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-sprint-seal-active-empty-runs-"));
  await writeBundleFiles(repoRoot);

  await writeFile(
    join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"),
    JSON.stringify(
      {
        sprint_phase: "ACTIVE",
        sealed_at: "2026-02-28T11:00:00.000Z",
        poll_count: 0,
        items: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"),
    JSON.stringify(
      {
        plan_version: "2026-02-28T11:00:00.000Z",
        runs: {},
        tasks: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const planVersion = "2026-02-28T12:00:00.000Z";
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [
          {
            project_item_id: "PVTI_10",
            issue_number: 10,
            issue_title: "Task 10",
            issue_url: "https://github.com/acme/repo/issues/10",
            fields: { Sprint: "M1-20260228", DependsOn: "" },
          },
        ];
      },
    }),
    nowIso: () => planVersion,
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/sprint/seal",
    payload: { sprint: "M1-20260228" },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "SEALED", plan_version: planVersion });

  const ledgerRaw = await readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8");
  const ledger = JSON.parse(ledgerRaw);
  assert.equal(ledger.plan_version, planVersion);
  assert.deepEqual(ledger.runs, {});

  const orchestratorRaw = await readFile(join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json"), "utf8");
  const orchestrator = JSON.parse(orchestratorRaw);
  assert.equal(orchestrator.sprint_phase, "ACTIVE");
  assert.equal(orchestrator.sealed_at, planVersion);

  await app.close();
});
