import assert from "node:assert/strict";
import test from "node:test";

import { GitHubTemplateReadError, readTemplateMetadataFromGitHub } from "../src/internal/github-template-reader.js";

function buildResponse({ ok, status, payload }) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("readTemplateMetadataFromGitHub returns size and sha256 when template exists", async () => {
  const content = "name: Milestone Task\n";
  const base64 = Buffer.from(content, "utf8").toString("base64");

  const result = await readTemplateMetadataFromGitHub({
    owner_login: "owner",
    repo_name: "repo",
    path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
    ref: "main",
    githubToken: "token",
    fetchImpl: async () =>
      buildResponse({
        ok: true,
        status: 200,
        payload: {
          encoding: "base64",
          content: base64,
        },
      }),
  });

  assert.equal(result.path, ".github/ISSUE_TEMPLATE/milestone-task.yml");
  assert.equal(result.size_bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(typeof result.sha256, "string");
  assert.equal(result.sha256.length, 64);
});

test("readTemplateMetadataFromGitHub throws template_missing for 404", async () => {
  await assert.rejects(
    () =>
      readTemplateMetadataFromGitHub({
        owner_login: "owner",
        repo_name: "repo",
        path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
        githubToken: "token",
        fetchImpl: async () => buildResponse({ ok: false, status: 404, payload: { message: "Not Found" } }),
      }),
    (error) => {
      assert.equal(error instanceof GitHubTemplateReadError, true);
      assert.equal(error.code, "template_missing");
      return true;
    },
  );
});

test("readTemplateMetadataFromGitHub retries transient failures and errors when exhausted", async () => {
  let calls = 0;

  await assert.rejects(
    () =>
      readTemplateMetadataFromGitHub({
        owner_login: "owner",
        repo_name: "repo",
        path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
        githubToken: "token",
        retries: 2,
        baseDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return buildResponse({ ok: false, status: 503, payload: { message: "Service Unavailable" } });
        },
      }),
    (error) => {
      assert.equal(error instanceof GitHubTemplateReadError, true);
      assert.equal(error.code, "template_fetch_transient_exhausted");
      return true;
    },
  );

  assert.equal(calls, 3);
});
