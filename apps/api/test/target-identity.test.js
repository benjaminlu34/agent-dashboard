import assert from "node:assert/strict";
import test from "node:test";

import { resolveTargetIdentity, TargetIdentityError, toProjectSchemaIdentity } from "../src/internal/target-identity.js";

test("resolveTargetIdentity uses TARGET_* env override when provided", () => {
  const identity = resolveTargetIdentity({
    env: {
      TARGET_OWNER_LOGIN: "target-owner",
      TARGET_OWNER_TYPE: "org",
      TARGET_REPO_NAME: "target-repo",
      TARGET_PROJECT_NAME: "Target Project",
      TARGET_TEMPLATE_PATH: ".github/ISSUE_TEMPLATE/custom.yml",
      TARGET_REF: "main",
    },
    repoPolicy: {
      owner_login: "policy-owner",
      owner_type: "user",
      project_name: "Policy Project",
      repository_name: "policy-repo",
    },
  });

  assert.deepEqual(identity, {
    owner_login: "target-owner",
    owner_type: "org",
    repo_name: "target-repo",
    project_name: "Target Project",
    template_path: ".github/ISSUE_TEMPLATE/custom.yml",
    ref: "main",
    source: "env_override",
  });
});

test("resolveTargetIdentity falls back to policy/github-project.json identity", () => {
  const identity = resolveTargetIdentity({
    env: {},
    repoPolicy: {
      owner_login: "policy-owner",
      owner_type: "organization",
      project_name: "Policy Project",
      repository_name: "policy-repo",
    },
  });

  assert.deepEqual(identity, {
    owner_login: "policy-owner",
    owner_type: "org",
    repo_name: "policy-repo",
    project_name: "Policy Project",
    template_path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
    ref: "HEAD",
    source: "policy",
  });
});

test("resolveTargetIdentity fails closed when TARGET_* override is partial", () => {
  assert.throws(
    () =>
      resolveTargetIdentity({
        env: {
          TARGET_OWNER_LOGIN: "partial",
        },
        repoPolicy: {
          owner_login: "policy-owner",
          owner_type: "user",
          project_name: "Policy Project",
          repository_name: "policy-repo",
        },
      }),
    (error) => {
      assert.equal(error instanceof TargetIdentityError, true);
      assert.equal(error.code, "target_identity_missing_env");
      return true;
    },
  );
});

test("toProjectSchemaIdentity strips repo/template fields for schema reader", () => {
  const result = toProjectSchemaIdentity({
    owner_login: "owner",
    owner_type: "user",
    repo_name: "repo",
    project_name: "Project",
    template_path: ".github/ISSUE_TEMPLATE/milestone-task.yml",
    ref: "HEAD",
  });

  assert.deepEqual(result, {
    owner_login: "owner",
    owner_type: "user",
    project_name: "Project",
  });
});
