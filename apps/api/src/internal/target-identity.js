const DEFAULT_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/milestone-task.yml";
const DEFAULT_TARGET_REF = "HEAD";
const REQUIRED_TARGET_ENV_KEYS = ["TARGET_OWNER_LOGIN", "TARGET_OWNER_TYPE", "TARGET_REPO_NAME", "TARGET_PROJECT_NAME"];

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOwnerType(value) {
  if (!hasNonEmptyString(value)) {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "organization") {
    return "org";
  }
  return normalized;
}

function parseRepoNameFromGithubRepository(value) {
  if (!hasNonEmptyString(value)) {
    return "";
  }

  const parts = value.trim().split("/");
  if (parts.length !== 2) {
    return "";
  }

  return parts[1].trim();
}

function readPolicyRepoName(repoPolicy, env) {
  if (hasNonEmptyString(repoPolicy?.repository_name)) {
    return repoPolicy.repository_name.trim();
  }
  if (hasNonEmptyString(repoPolicy?.repo_name)) {
    return repoPolicy.repo_name.trim();
  }
  if (hasNonEmptyString(repoPolicy?.repo)) {
    return repoPolicy.repo.trim();
  }
  if (hasNonEmptyString(repoPolicy?.repository)) {
    return repoPolicy.repository.trim();
  }

  const repoFromEnv = parseRepoNameFromGithubRepository(env?.GITHUB_REPOSITORY);
  if (repoFromEnv) {
    return repoFromEnv;
  }

  return "";
}

function readRequiredEnvIdentity(env) {
  const missing = REQUIRED_TARGET_ENV_KEYS.filter((key) => !hasNonEmptyString(env?.[key]));
  if (missing.length > 0) {
    throw new TargetIdentityError("target identity env override is incomplete", {
      code: "target_identity_missing_env",
      missing,
    });
  }

  const ownerType = normalizeOwnerType(env.TARGET_OWNER_TYPE);
  if (ownerType !== "user" && ownerType !== "org") {
    throw new TargetIdentityError("TARGET_OWNER_TYPE must be user or org", {
      code: "target_identity_invalid_owner_type",
      value: env.TARGET_OWNER_TYPE,
    });
  }

  return {
    owner_login: env.TARGET_OWNER_LOGIN.trim(),
    owner_type: ownerType,
    repo_name: env.TARGET_REPO_NAME.trim(),
    project_name: env.TARGET_PROJECT_NAME.trim(),
    template_path: hasNonEmptyString(env.TARGET_TEMPLATE_PATH) ? env.TARGET_TEMPLATE_PATH.trim() : DEFAULT_TEMPLATE_PATH,
    ref: hasNonEmptyString(env.TARGET_REF) ? env.TARGET_REF.trim() : DEFAULT_TARGET_REF,
    source: "env_override",
  };
}

function readPolicyIdentity(repoPolicy, env) {
  const ownerLogin = hasNonEmptyString(repoPolicy?.owner_login) ? repoPolicy.owner_login.trim() : "";
  const ownerType = normalizeOwnerType(repoPolicy?.owner_type);
  const projectName = hasNonEmptyString(repoPolicy?.project_name) ? repoPolicy.project_name.trim() : "";
  const repoName = readPolicyRepoName(repoPolicy, env);

  const missing = [];
  if (!ownerLogin) {
    missing.push("owner_login");
  }
  if (ownerType !== "user" && ownerType !== "org") {
    missing.push("owner_type");
  }
  if (!projectName) {
    missing.push("project_name");
  }
  if (!repoName) {
    missing.push("repository_name");
  }

  if (missing.length > 0) {
    throw new TargetIdentityError("target identity policy is incomplete", {
      code: "target_identity_policy_incomplete",
      missing,
      path: "policy/github-project.json",
    });
  }

  return {
    owner_login: ownerLogin,
    owner_type: ownerType,
    repo_name: repoName,
    project_name: projectName,
    template_path: hasNonEmptyString(env?.TARGET_TEMPLATE_PATH) ? env.TARGET_TEMPLATE_PATH.trim() : DEFAULT_TEMPLATE_PATH,
    ref: hasNonEmptyString(env?.TARGET_REF) ? env.TARGET_REF.trim() : DEFAULT_TARGET_REF,
    source: "policy",
  };
}

export class TargetIdentityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TargetIdentityError";
    this.details = details;
    this.code = details.code ?? "target_identity_error";
  }
}

export function resolveTargetIdentity({
  env = process.env,
  repoPolicy,
} = {}) {
  if (!repoPolicy || typeof repoPolicy !== "object") {
    throw new TargetIdentityError("project identity policy JSON is required", {
      code: "target_identity_missing_policy",
      path: "policy/github-project.json",
    });
  }

  const hasEnvOverride = REQUIRED_TARGET_ENV_KEYS.some((key) => hasNonEmptyString(env?.[key]));
  if (hasEnvOverride) {
    return readRequiredEnvIdentity(env);
  }

  return readPolicyIdentity(repoPolicy, env);
}

export function toProjectSchemaIdentity(targetIdentity) {
  return {
    owner_login: targetIdentity.owner_login,
    owner_type: targetIdentity.owner_type,
    project_name: targetIdentity.project_name,
  };
}
