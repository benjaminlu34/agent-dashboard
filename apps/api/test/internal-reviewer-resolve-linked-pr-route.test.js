import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalReviewerResolveLinkedPrRoute } from "../src/routes/internal-reviewer-resolve-linked-pr.js";

function buildPreflightPass() {
  return async () => ({
    role: "REVIEWER",
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
  await writeFile(join(repoRoot, "agents/REVIEWER.md"), "reviewer overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board","repository_name":"agent-dashboard"}\n',
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/project-schema.json"),
    '{"project_name":"Codex Task Board","required_fields":[]}\n',
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"status_field":"Status","transitions":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Reviewer":{"can_comment_on_pr":true}}\n', "utf8");
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

async function buildTestApp(options) {
  const app = Fastify({ logger: false });
  await registerInternalReviewerResolveLinkedPrRoute(app, options);
  return app;
}

test("POST /internal/reviewer/resolve-linked-pr returns exactly one linked PR", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-ok-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 77,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/77",
            head_ref: "executor/issue-44",
            head_sha: "deadbeef",
            body: buildMarkerBody({
              issueNumber: 44,
              projectItemId: "PVTI_44",
              runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            }),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    pr_number: 77,
    pr_url: "https://github.com/benjaminlu34/agent-dashboard/pull/77",
    issue_number: 44,
    project_item_id: "PVTI_44",
    run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    head_ref: "executor/issue-44",
    head_sha: "deadbeef",
  });
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr accepts indented marker closing delimiter", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-indented-marker-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 91,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/91",
            body: [
              "Refs #44",
              "<!-- EXECUTOR_RUN_V1",
              "issue: 44",
              "project_item_id: PVTI_44",
              "run_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "  -->",
            ].join("\n"),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pr_number, 91);
  assert.equal(response.json().issue_number, 44);
  assert.equal(response.json().project_item_id, "PVTI_44");
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr accepts marker header without whitespace (fenced)", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-fenced-marker-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 93,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/93",
            body: [
              "Refs #44",
              "```text",
              "<!--EXECUTOR_RUN_V1",
              "issue: 44",
              "project_item_id: PVTI_44",
              "run_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "-->",
              "```",
            ].join("\n"),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pr_number, 93);
  assert.equal(response.json().issue_number, 44);
  assert.equal(response.json().project_item_id, "PVTI_44");
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr accepts marker closing delimiter on same line", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-inline-marker-close-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 94,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/94",
            body: [
              "Refs #44",
              "<!-- EXECUTOR_RUN_V1",
              "issue: 44",
              "project_item_id: PVTI_44",
              "run_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa -->",
            ].join("\n"),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().pr_number, 94);
  assert.equal(response.json().issue_number, 44);
  assert.equal(response.json().project_item_id, "PVTI_44");
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr returns 409 for unmarked Refs #N", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-unmarked-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 78,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/78",
            body: "Refs #44\nNo marker",
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "unmarked_refs");
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr returns 409 for marker project_item_id mismatch", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-item-mismatch-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_expected_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 79,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/79",
            body: buildMarkerBody({
              issueNumber: 44,
              projectItemId: "PVTI_wrong_44",
              runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            }),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "project_item_id_mismatch");
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr hydrates PR body with getPullRequest when list body is empty", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-hydrate-body-"));
  await writeBundleFiles(repoRoot);

  let getPullRequestCalled = false;
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 90,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/90",
            body: "",
          },
        ];
      },
      async getPullRequest({ prNumber }) {
        getPullRequestCalled = true;
        assert.equal(prNumber, 90);
        return {
          number: 90,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/90",
          body: buildMarkerBody({
            issueNumber: 44,
            projectItemId: "PVTI_44",
            runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          }),
        };
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(getPullRequestCalled, true);
  assert.equal(response.json().pr_number, 90);
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr hydrates PR body when list body is incomplete", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-hydrate-incomplete-body-"));
  await writeBundleFiles(repoRoot);

  let getPullRequestCalled = false;
  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 92,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/92",
            body: "Refs #44\nBody truncated before marker.",
          },
        ];
      },
      async getPullRequest({ prNumber }) {
        getPullRequestCalled = true;
        assert.equal(prNumber, 92);
        return {
          number: 92,
          html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/92",
          body: buildMarkerBody({
            issueNumber: 44,
            projectItemId: "PVTI_44",
            runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
        };
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(getPullRequestCalled, true);
  assert.equal(response.json().pr_number, 92);
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr returns 409 for multiple marked PRs", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-multiple-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [{ project_item_id: "PVTI_44", issue_number: 44 }];
      },
      async listPullRequests() {
        return [
          {
            number: 80,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/80",
            body: buildMarkerBody({
              issueNumber: 44,
              projectItemId: "PVTI_44",
              runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            }),
          },
          {
            number: 81,
            html_url: "https://github.com/benjaminlu34/agent-dashboard/pull/81",
            body: buildMarkerBody({
              issueNumber: 44,
              projectItemId: "PVTI_44",
              runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            }),
          },
        ];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "ambiguous_linked_pr");
  assert.equal(response.json().linked_count, 2);
  await app.close();
});

test("POST /internal/reviewer/resolve-linked-pr returns 409 with preflight payload on preflight FAIL", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "reviewer-resolve-preflight-fail-"));
  await writeBundleFiles(repoRoot);

  const app = await buildTestApp({
    repoRoot,
    preflightHandler: async () => ({
      role: "REVIEWER",
      status: "FAIL",
      errors: [{ source: "project_schema", message: "drift detected" }],
    }),
    githubClientFactory: async () => ({
      async listProjectItems() {
        return [];
      },
      async listPullRequests() {
        return [];
      },
    }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/internal/reviewer/resolve-linked-pr",
    payload: {
      role: "REVIEWER",
      issue_number: 44,
    },
  });

  assert.equal(response.statusCode, 409);
  const payload = response.json();
  assert.equal(payload.status, "FAIL");
  assert.equal(payload.errors[0].source, "project_schema");
  await app.close();
});
