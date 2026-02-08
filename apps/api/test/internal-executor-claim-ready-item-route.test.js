import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalExecutorClaimReadyItemRoute } from "../src/routes/internal-executor-claim-ready-item.js";

function buildPreflightPass() {
  return async () => ({
    role: "EXECUTOR",
    bundle_hash: "bundle-hash",
    template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 10, sha256: "abc" },
    project_schema: { status: "PASS", mismatches: [] },
    status: "PASS",
    errors: [],
  });
}

async function writeBundleFiles(repoRoot, { executorCanUpdateStatusOnly = true } = {}) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });
  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/EXECUTOR.md"), "executor overlay\n", "utf8");
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
          { name: "Size", type: "single_select", allowed_options: ["S", "M", "L"] },
          { name: "Area", type: "single_select", allowed_options: ["db", "api", "web", "providers", "infra", "docs"] },
          { name: "Priority", type: "single_select", allowed_options: ["P0", "P1", "P2"] },
          { name: "Sprint", type: "single_select", allowed_options: ["M1", "M2", "M3", "M4"] },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/transitions.json"),
    JSON.stringify(
      {
        status_field: "Status",
        transitions: [{ from: "Ready", to: "In Progress", allowed_roles: ["Executor"] }],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/role-permissions.json"),
    JSON.stringify(
      {
        Executor: {
          can_set_project_fields: false,
          can_update_status_only: executorCanUpdateStatusOnly,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function buildMarkerBody({ issueNumber, projectItemId, runId }) {
  return [
    `Refs #${issueNumber}`,
    "<!-- EXECUTOR_RUN_V1",
    `issue: ${issueNumber}`,
    `project_item_id: ${projectItemId}`,
    `run_id: ${runId}`,
    "-->",
  ].join("\n");
}

function buildClaimMarkerBody({ issueNumber, projectItemId, runId, claimedAt }) {
  return [
    "<!-- EXECUTOR_CLAIM_V1",
    `issue: ${issueNumber}`,
    `project_item_id: ${projectItemId}`,
    `run_id: ${runId}`,
    `claimed_at: ${claimedAt}`,
    "-->",
  ].join("\n");
}

function createMockGithubClient({
  issueNumber = 21,
  issueUrl = "https://github.com/benjaminlu34/agent-dashboard/issues/21",
  projectItemId = "PVTI_ready_1",
  sprint = "M1",
  initialStatus = "Ready",
  pullRequests = [],
  initialComments = [],
} = {}) {
  let nextCommentId = 1000;
  const statusByItem = new Map([[projectItemId, initialStatus]]);
  const commentsByIssue = new Map([[issueNumber, [...initialComments]]]);

  return {
    async listProjectItems() {
      return [
        {
          project_item_id: projectItemId,
          issue_number: issueNumber,
          issue_url: issueUrl,
          fields: { Status: "Ready", Sprint: sprint },
        },
      ];
    },
    async listPullRequests() {
      return pullRequests;
    },
    async listIssueComments({ issueNumber: issueNum }) {
      return [...(commentsByIssue.get(issueNum) ?? [])];
    },
    async createIssueComment({ issueNumber: issueNum, body }) {
      const now = new Date().toISOString();
      const comment = {
        id: nextCommentId,
        body,
        created_at: now,
        html_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${issueNum}#issuecomment-${nextCommentId}`,
      };
      nextCommentId += 1;
      const existing = commentsByIssue.get(issueNum) ?? [];
      commentsByIssue.set(issueNum, [...existing, comment]);
      return comment;
    },
    async getProjectItemFieldValue({ projectItemId: itemId }) {
      return statusByItem.get(itemId) ?? "";
    },
    async updateProjectItemField({ projectItemId: itemId, field, value }) {
      assert.equal(field, "Status");
      statusByItem.set(itemId, value);
    },
  };
}

async function buildTestApp(options) {
  const app = Fastify({ logger: false });
  await registerInternalExecutorClaimReadyItemRoute(app, options);
  return app;
}

test("POST /internal/executor/claim-ready-item claims one Ready item when no linked PR exists", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-ok-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => createMockGithubClient(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      sprint: "M1",
      run_id: "11111111-1111-4111-8111-111111111111",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    role: "EXECUTOR",
    run_id: "11111111-1111-4111-8111-111111111111",
    claimed: {
      issue_number: 21,
      issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/21",
      project_item_id: "PVTI_ready_1",
      branch: "executor/issue-21",
      fields_set: { Status: "In Progress" },
    },
  });

  await app.close();
});

test("POST /internal/executor/claim-ready-item is idempotent for same run_id", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-idempotent-"));
  await writeBundleFiles(repoRoot);

  const sharedClient = createMockGithubClient();
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => sharedClient,
  });

  const first = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "12121212-1212-4212-8212-121212121212",
    },
  });
  const second = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "12121212-1212-4212-8212-121212121212",
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.json(), second.json());
  await app.close();
});

test("POST /internal/executor/claim-ready-item repairs Ready status for an existing claim marker owned by run_id", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-repair-ready-"));
  await writeBundleFiles(repoRoot);

  const issueNumber = 61;
  const projectItemId = "PVTI_ready_61";
  const runId = "61616161-6161-4161-8161-616161616161";

  const sharedClient = createMockGithubClient({
    issueNumber,
    issueUrl: "https://github.com/benjaminlu34/agent-dashboard/issues/61",
    projectItemId,
    initialStatus: "Ready",
    initialComments: [
      {
        id: 42,
        body: buildClaimMarkerBody({
          issueNumber,
          projectItemId,
          runId,
          claimedAt: "2026-02-08T17:00:00.000Z",
        }),
        created_at: "2026-02-08T17:00:00.000Z",
        html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/61#issuecomment-42",
      },
    ],
  });

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => sharedClient,
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: runId,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    role: "EXECUTOR",
    run_id: runId,
    claimed: {
      issue_number: issueNumber,
      issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/61",
      project_item_id: projectItemId,
      branch: "executor/issue-61",
      fields_set: { Status: "In Progress" },
    },
  });

  const status = await sharedClient.getProjectItemFieldValue({ projectItemId, field: "Status" });
  assert.equal(status, "In Progress");

  await app.close();
});

test("POST /internal/executor/claim-ready-item reclaims a Ready item when the existing claim marker is expired", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-expired-claim-"));
  await writeBundleFiles(repoRoot);

  const previousTtl = process.env.EXECUTOR_CLAIM_TTL_MINUTES;
  process.env.EXECUTOR_CLAIM_TTL_MINUTES = "15";
  try {
    const issueNumber = 62;
    const projectItemId = "PVTI_ready_62";
    const oldRunId = "62626262-6262-4262-8262-626262626262";
    const newRunId = "63636363-6363-4363-8363-636363636363";

    const sharedClient = createMockGithubClient({
      issueNumber,
      issueUrl: "https://github.com/benjaminlu34/agent-dashboard/issues/62",
      projectItemId,
      initialStatus: "Ready",
      initialComments: [
        {
          id: 40,
          body: buildClaimMarkerBody({
            issueNumber,
            projectItemId,
            runId: oldRunId,
            claimedAt: "2026-02-08T00:00:00.000Z",
          }),
          created_at: "2026-02-08T00:00:00.000Z",
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/62#issuecomment-40",
        },
      ],
    });

    const app = await buildTestApp({
      repoRoot,
      preflightHandler: buildPreflightPass(),
      githubClientFactory: async () => sharedClient,
    });

    const response = await app.inject({
      method: "POST",
      url: "/internal/executor/claim-ready-item",
      payload: {
        role: "EXECUTOR",
        run_id: newRunId,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      role: "EXECUTOR",
      run_id: newRunId,
      claimed: {
        issue_number: issueNumber,
        issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/62",
        project_item_id: projectItemId,
        branch: "executor/issue-62",
        fields_set: { Status: "In Progress" },
      },
    });

    await app.close();
  } finally {
    if (previousTtl === undefined) {
      delete process.env.EXECUTOR_CLAIM_TTL_MINUTES;
    } else {
      process.env.EXECUTOR_CLAIM_TTL_MINUTES = previousTtl;
    }
  }
});

test("POST /internal/executor/claim-ready-item skips when another run_id already claimed", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-other-run-"));
  await writeBundleFiles(repoRoot);

  const sharedClient = createMockGithubClient();
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => sharedClient,
  });

  const first = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "13131313-1313-4313-8313-131313131313",
    },
  });
  const second = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "14141414-1414-4414-8414-141414141414",
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), {
    role: "EXECUTOR",
    run_id: "14141414-1414-4414-8414-141414141414",
    claimed: null,
    reason: "no_claimable_ready_item_found",
  });
  await app.close();
});

test("POST /internal/executor/claim-ready-item prevents dual claim under concurrent requests", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-race-"));
  await writeBundleFiles(repoRoot);

  const sharedClient = createMockGithubClient({
    issueNumber: 41,
    issueUrl: "https://github.com/benjaminlu34/agent-dashboard/issues/41",
    projectItemId: "PVTI_ready_41",
    sprint: "M2",
  });

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => sharedClient,
  });

  const [first, second] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/internal/executor/claim-ready-item",
      payload: {
        role: "EXECUTOR",
        sprint: "M2",
        run_id: "15151515-1515-4515-8515-151515151515",
      },
    }),
    app.inject({
      method: "POST",
      url: "/internal/executor/claim-ready-item",
      payload: {
        role: "EXECUTOR",
        sprint: "M2",
        run_id: "16161616-1616-4616-8616-161616161616",
      },
    }),
  ]);

  const successful = [first, second].filter((response) => response.json().claimed !== null);
  const noClaim = [first, second].filter((response) => response.json().claimed === null);
  assert.equal(successful.length, 1);
  assert.equal(noClaim.length, 1);
  assert.equal(noClaim[0].json().reason, "no_claimable_ready_item_found");
  await app.close();
});

test("POST /internal/executor/claim-ready-item resolves dual claim markers by earliest comment id", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-winner-rule-"));
  await writeBundleFiles(repoRoot);

  const issueNumber = 52;
  const projectItemId = "PVTI_ready_52";
  const winnerRunId = "52525252-5252-4252-8252-525252525252";
  const loserRunId = "53535353-5353-4353-8353-535353535353";
  const freshClaimedAt = new Date().toISOString();

  let created = false;
  const comments = [];
  const githubClient = {
    async listProjectItems() {
      return [
        {
          project_item_id: projectItemId,
          issue_number: issueNumber,
          issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/52",
          fields: { Status: "Ready", Sprint: "M1" },
        },
      ];
    },
    async listPullRequests() {
      return [];
    },
    async listIssueComments() {
      return [...comments].sort((left, right) => left.id - right.id);
    },
    async createIssueComment({ body }) {
      if (!created) {
        created = true;
        comments.push({
          id: 10,
          body: buildClaimMarkerBody({
            issueNumber,
            projectItemId,
            runId: winnerRunId,
            claimedAt: freshClaimedAt,
          }),
          created_at: freshClaimedAt,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/52#issuecomment-10",
        });
        comments.push({
          id: 11,
          body,
          created_at: freshClaimedAt,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/issues/52#issuecomment-11",
        });
      }
      return comments[comments.length - 1];
    },
    async getProjectItemFieldValue() {
      return "In Progress";
    },
    async updateProjectItemField() {
      throw new Error("status update should not run for loser");
    },
  };

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => githubClient,
  });

  const [first, second] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/internal/executor/claim-ready-item",
      payload: {
        role: "EXECUTOR",
        run_id: loserRunId,
      },
    }),
    app.inject({
      method: "POST",
      url: "/internal/executor/claim-ready-item",
      payload: {
        role: "EXECUTOR",
        run_id: winnerRunId,
      },
    }),
  ]);

  const loserResponse = [first, second].find((response) => response.json().run_id === loserRunId);
  const winnerResponse = [first, second].find((response) => response.json().run_id === winnerRunId);

  assert.equal(loserResponse.statusCode, 200);
  assert.deepEqual(loserResponse.json(), {
    role: "EXECUTOR",
    run_id: loserRunId,
    claimed: null,
    reason: "no_claimable_ready_item_found",
  });

  assert.equal(winnerResponse.statusCode, 200);
  assert.deepEqual(winnerResponse.json(), {
    role: "EXECUTOR",
    run_id: winnerRunId,
    claimed: {
      issue_number: 52,
      issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/52",
      project_item_id: projectItemId,
      branch: "executor/issue-52",
      fields_set: { Status: "In Progress" },
    },
  });

  const rerunWinner = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: winnerRunId,
    },
  });
  assert.equal(rerunWinner.statusCode, 200);
  assert.deepEqual(rerunWinner.json(), winnerResponse.json());

  await app.close();
});

test("POST /internal/executor/claim-ready-item returns 200 claimed=null when linked PR exists", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-linked-pr-"));
  await writeBundleFiles(repoRoot);

  const linkedPrBody = buildMarkerBody({
    issueNumber: 32,
    projectItemId: "PVTI_ready_32",
    runId: "17171717-1717-4717-8717-171717171717",
  });

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () =>
      createMockGithubClient({
        issueNumber: 32,
        issueUrl: "https://github.com/benjaminlu34/agent-dashboard/issues/32",
        projectItemId: "PVTI_ready_32",
        pullRequests: [
          {
            number: 99,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/99",
            body: linkedPrBody,
            state: "open",
          },
        ],
      }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      sprint: "M1",
      run_id: "18181818-1818-4818-8818-181818181818",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    role: "EXECUTOR",
    run_id: "18181818-1818-4818-8818-181818181818",
    claimed: null,
    reason: "no_claimable_ready_item_found",
  });
  await app.close();
});

test("POST /internal/executor/claim-ready-item returns 409 with preflight payload on preflight FAIL", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-preflight-fail-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: async () => ({
      role: "EXECUTOR",
      status: "FAIL",
      errors: [{ source: "project_schema", message: "drift detected" }],
    }),
    githubClientFactory: async () => createMockGithubClient(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "19191919-1919-4919-8919-191919191919",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().status, "FAIL");
  assert.equal(response.json().errors[0].source, "project_schema");
  await app.close();
});

test("POST /internal/executor/claim-ready-item returns 403 when policy denies status updates", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "executor-claim-policy-deny-"));
  await writeBundleFiles(repoRoot, { executorCanUpdateStatusOnly: false });

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => createMockGithubClient(),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/executor/claim-ready-item",
    payload: {
      role: "EXECUTOR",
      run_id: "20202020-2020-4020-8020-202020202020",
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: "role is not allowed to update status" });
  await app.close();
});
