import assert from "node:assert/strict";
import test from "node:test";

import { assertZeroLinkedPullRequests, ExecutorPrLinkageError } from "../src/internal/executor-pr-linkage.js";

function buildMarkedBody({ issueNumber, projectItemId, runId }) {
  return [
    `Refs #${issueNumber}`,
    "<!-- EXECUTOR_RUN_V1",
    `issue: ${issueNumber}`,
    `project_item_id: ${projectItemId}`,
    `run_id: ${runId}`,
    "-->",
  ].join("\n");
}

test("assertZeroLinkedPullRequests returns linked=true for marked linked PR", async () => {
  const result = await assertZeroLinkedPullRequests({
    githubClient: {
      async listPullRequests() {
        return [
          {
            number: 7,
            html_url: "https://github.com/org/repo/pull/7",
            body: buildMarkedBody({
              issueNumber: 12,
              projectItemId: "PVTI_12",
              runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            }),
          },
        ];
      },
    },
    issueNumber: 12,
    projectItemId: "PVTI_12",
  });

  assert.deepEqual(result, {
    linked: true,
    reason: "marked_linked_pr",
    pr_number: 7,
    pr_url: "https://github.com/org/repo/pull/7",
  });
});

test("assertZeroLinkedPullRequests accepts marker header without whitespace", async () => {
  const result = await assertZeroLinkedPullRequests({
    githubClient: {
      async listPullRequests() {
        return [
          {
            number: 12,
            html_url: "https://github.com/org/repo/pull/12",
            body: [
              "Refs #44",
              "<!--EXECUTOR_RUN_V1",
              "issue: 44",
              "project_item_id: PVTI_44",
              "run_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "-->",
            ].join("\n"),
          },
        ];
      },
    },
    issueNumber: 44,
    projectItemId: "PVTI_44",
  });

  assert.deepEqual(result, {
    linked: true,
    reason: "marked_linked_pr",
    pr_number: 12,
    pr_url: "https://github.com/org/repo/pull/12",
  });
});

test("assertZeroLinkedPullRequests accepts indented marker closing delimiter", async () => {
  const result = await assertZeroLinkedPullRequests({
    githubClient: {
      async listPullRequests() {
        return [
          {
            number: 10,
            html_url: "https://github.com/org/repo/pull/10",
            body: [
              "Refs #12",
              "<!-- EXECUTOR_RUN_V1",
              "issue: 12",
              "project_item_id: PVTI_12",
              "run_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "  -->",
            ].join("\n"),
          },
        ];
      },
    },
    issueNumber: 12,
    projectItemId: "PVTI_12",
  });

  assert.deepEqual(result, {
    linked: true,
    reason: "marked_linked_pr",
    pr_number: 10,
    pr_url: "https://github.com/org/repo/pull/10",
  });
});

test("assertZeroLinkedPullRequests hydrates PR body when list body is incomplete", async () => {
  const result = await assertZeroLinkedPullRequests({
    githubClient: {
      async listPullRequests() {
        return [
          {
            number: 11,
            html_url: "https://github.com/org/repo/pull/11",
            body: "Refs #12\nBody truncated before marker.",
          },
        ];
      },
      async getPullRequest({ prNumber }) {
        assert.equal(prNumber, 11);
        return {
          number: 11,
          html_url: "https://github.com/org/repo/pull/11",
          body: buildMarkedBody({
            issueNumber: 12,
            projectItemId: "PVTI_12",
            runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
        };
      },
    },
    issueNumber: 12,
    projectItemId: "PVTI_12",
  });

  assert.deepEqual(result, {
    linked: true,
    reason: "marked_linked_pr",
    pr_number: 11,
    pr_url: "https://github.com/org/repo/pull/11",
  });
});

test("assertZeroLinkedPullRequests returns linked=true for unmarked Refs #N", async () => {
  const result = await assertZeroLinkedPullRequests({
    githubClient: {
      async listPullRequests() {
        return [
          {
            number: 8,
            html_url: "https://github.com/org/repo/pull/8",
            body: "Refs #12\nSome body without marker.",
          },
        ];
      },
    },
    issueNumber: 12,
    projectItemId: "PVTI_12",
  });

  assert.deepEqual(result, {
    linked: true,
    reason: "unmarked_refs",
    pr_number: 8,
    pr_url: "https://github.com/org/repo/pull/8",
  });
});

test("assertZeroLinkedPullRequests throws when auto-close keyword targets the issue", async () => {
  await assert.rejects(
    () =>
      assertZeroLinkedPullRequests({
        githubClient: {
          async listPullRequests() {
            return [
              {
                number: 9,
                html_url: "https://github.com/org/repo/pull/9",
                body: "Closes #12",
              },
            ];
          },
        },
        issueNumber: 12,
        projectItemId: "PVTI_12",
      }),
    (error) => {
      assert.equal(error instanceof ExecutorPrLinkageError, true);
      assert.equal(error.message, "forbidden auto-close keyword detected for issue linkage");
      return true;
    },
  );
});
