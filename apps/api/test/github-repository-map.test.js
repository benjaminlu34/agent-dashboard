import assert from "node:assert/strict";
import test from "node:test";

import { fetchRepositoryMapFromGithub, filterRepositoryMapPaths } from "../src/internal/github-repository-map.js";

function buildJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("filterRepositoryMapPaths applies dynamic segment and glob ignore paths", () => {
  const filtered = filterRepositoryMapPaths([
    { path: "apps/api/src/index.js", type: "blob" },
    { path: "node_modules/a/index.js", type: "blob" },
    { path: ".git/config", type: "blob" },
    { path: "dist/output.js", type: "blob" },
    { path: "build/output.js", type: "blob" },
    { path: "__pycache__/cache.pyc", type: "blob" },
    { path: ".env", type: "blob" },
    { path: ".env.local", type: "blob" },
    { path: "apps/api/src/generated/openapi.json", type: "blob" },
    { path: "apps/api/src/routes", type: "tree" },
  ], ["node_modules", ".git", "dist", "build", "__pycache__", ".env*", "apps/api/src/generated/**"]);

  assert.deepEqual(filtered, ["apps/api/src/index.js"]);
});

test("fetchRepositoryMapFromGithub returns [] when GitHub API fails", async () => {
  const fetchImpl = async () => buildJsonResponse({ message: "rate limit exceeded" }, 429);

  const filtered = await fetchRepositoryMapFromGithub({
    ownerLogin: "example",
    repoName: "demo",
    githubToken: "token",
    ignorePaths: ["node_modules"],
    fetchImpl,
  });

  assert.deepEqual(filtered, []);
});

test("fetchRepositoryMapFromGithub falls back from HEAD to default branch", async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/git/trees/HEAD?recursive=1")) {
      return buildJsonResponse({ message: "Not Found" }, 404);
    }
    if (href.endsWith("/repos/example/demo")) {
      return buildJsonResponse({ default_branch: "main" }, 200);
    }
    if (href.includes("/git/trees/main?recursive=1")) {
      return buildJsonResponse(
        {
          tree: [
            { path: "apps/api/src/index.js", type: "blob" },
            { path: "node_modules/a/index.js", type: "blob" },
          ],
        },
        200,
      );
    }
    return buildJsonResponse({ message: "not found" }, 404);
  };

  const filtered = await fetchRepositoryMapFromGithub({
    ownerLogin: "example",
    repoName: "demo",
    githubToken: "token",
    ref: "HEAD",
    ignorePaths: ["node_modules"],
    fetchImpl,
  });

  assert.deepEqual(filtered, ["apps/api/src/index.js"]);
});
