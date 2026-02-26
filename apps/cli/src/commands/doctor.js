import process from "node:process";

import {
  DOCTOR_USER_AGENT,
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  REQUIRED_TEMPLATE_CONTENT,
  REQUIRED_TEMPLATE_PATH,
  SAFE_TEMPLATE_FIX_BRANCH,
} from "../constants/doctor.js";
import { loadAgentSwarmConfig } from "../config.js";
import { green, red } from "../util/colors.js";

function success(title, { detail, extra } = {}) {
  return {
    ok: true,
    title,
    ...(detail ? { detail } : {}),
    ...(extra ?? {}),
  };
}

function failure(title, remediation) {
  return {
    ok: false,
    title,
    remediation,
  };
}

function blocked(title, remediation) {
  return failure(`${title} could not be verified`, remediation);
}

function encodeContentPath(path) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCurlCommand({ tokenEnvName, apiPath }) {
  return `curl -i -H "Authorization: Bearer $${tokenEnvName}" "${GITHUB_API_BASE}${apiPath}"`;
}

function formatRemediationScript(lines) {
  return ["Run:", ...lines].join("\n");
}

async function githubJsonRequest({ path, token, method = "GET", body }) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": DOCTOR_USER_AGENT,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = null;
    }
  }

  return { response, data };
}

function templateRemediation(owner, repo) {
  const repoSlug = `${owner}/${repo}`;

  return formatRemediationScript([
    "bash <<'BASH'",
    "set -euo pipefail",
    `REPO_SLUG=${shellQuote(repoSlug)}`,
    `TEMPLATE_PATH=${shellQuote(REQUIRED_TEMPLATE_PATH)}`,
    `BRANCH_NAME=${shellQuote(SAFE_TEMPLATE_FIX_BRANCH)}`,
    "command -v gh >/dev/null",
    "gh auth status >/dev/null",
    "WORKDIR=$(mktemp -d -t agent-swarm-template-XXXXXX)",
    "trap 'rm -rf \"$WORKDIR\"' EXIT",
    "gh repo clone \"$REPO_SLUG\" \"$WORKDIR/repo\"",
    "cd \"$WORKDIR/repo\"",
    "git switch -c \"$BRANCH_NAME\"",
    "mkdir -p \"$(dirname \"$TEMPLATE_PATH\")\"",
    "if [ -f \"$TEMPLATE_PATH\" ]; then",
    "  echo \"Template already exists at $TEMPLATE_PATH; refusing to overwrite.\" >&2",
    "  exit 1",
    "fi",
    "cat > \"$TEMPLATE_PATH\" <<'YAML'",
    REQUIRED_TEMPLATE_CONTENT.trimEnd(),
    "YAML",
    "git add \"$TEMPLATE_PATH\"",
    "git commit -m \"Add required milestone task template\"",
    "git push --set-upstream origin \"$BRANCH_NAME\"",
    "echo \"Open a PR from $BRANCH_NAME for human approval before merge.\"",
    "BASH",
  ]);
}

async function checkToken({ tokenEnvName }) {
  const token = process.env[tokenEnvName];
  if (!token || token.trim().length === 0) {
    return failure(
      `GitHub token is missing in ${tokenEnvName}`,
      `Run: export ${tokenEnvName}=<your_github_pat_with_repo_and_project_access>`,
    );
  }

  const { response, data } = await githubJsonRequest({
    path: "/user",
    token,
  });

  if (response.status === 401) {
    return failure(
      `${tokenEnvName} is invalid or unauthenticated`,
      `Run: gh auth login --scopes \"repo,project\" && export ${tokenEnvName}=$(gh auth token)`,
    );
  }

  if (!response.ok) {
    return failure(
      `Failed to verify ${tokenEnvName} authentication (status ${response.status})`,
      `Run: ${buildCurlCommand({ tokenEnvName, apiPath: "/user" })}`,
    );
  }

  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (scopes.length === 0) {
    return failure(
      `${tokenEnvName} has no active OAuth scopes`,
      `Run: gh auth login --scopes \"repo,project\" && export ${tokenEnvName}=$(gh auth token)`,
    );
  }

  return success(`${tokenEnvName} is set and has active scopes`, {
    detail: `as ${data?.login ?? "unknown-user"} with scopes: ${scopes.join(", ")}`,
    extra: { token },
  });
}

async function checkRepoConnection({ owner, repo, token, tokenEnvName }) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { response, data } = await githubJsonRequest({
    path: repoPath,
    token,
  });

  if (response.status === 404) {
    return failure(
      `Target repo ${owner}/${repo} is not reachable (404)`,
      `Run: ${buildCurlCommand({ tokenEnvName, apiPath: repoPath })}`,
    );
  }

  if (!response.ok) {
    return failure(
      `Failed to verify repo access for ${owner}/${repo} (status ${response.status})`,
      `Run: ${buildCurlCommand({ tokenEnvName, apiPath: repoPath })}`,
    );
  }

  const permissions = data?.permissions && typeof data.permissions === "object" ? data.permissions : {};
  const hasWrite = Boolean(permissions.admin || permissions.maintain || permissions.push);

  if (!hasWrite) {
    return failure(
      `Read/write access to ${owner}/${repo} is missing`,
      `Grant this token write access to ${owner}/${repo} (Write/Maintain/Admin), then verify with: ${buildCurlCommand({ tokenEnvName, apiPath: repoPath })}`,
    );
  }

  return success(`Read/write access to ${owner}/${repo}`, {
    detail: "repository read and write permissions confirmed",
  });
}

async function checkTemplateExists({ owner, repo, token, tokenEnvName }) {
  const encodedTemplatePath = encodeContentPath(REQUIRED_TEMPLATE_PATH);
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedTemplatePath}`;
  const { response } = await githubJsonRequest({
    path: apiPath,
    token,
  });

  if (response.status === 404) {
    return failure(`Required issue template is missing (${REQUIRED_TEMPLATE_PATH})`, templateRemediation(owner, repo));
  }

  if (!response.ok) {
    return failure(
      `Failed to verify required issue template (${REQUIRED_TEMPLATE_PATH})`,
      `Run: ${buildCurlCommand({ tokenEnvName, apiPath })}`,
    );
  }

  return success(`Required issue template exists (${REQUIRED_TEMPLATE_PATH})`);
}

function printResult(result) {
  if (result.ok) {
    const suffix = result.detail ? ` (${result.detail})` : "";
    process.stdout.write(`${green("✔")} ${result.title}${suffix}\n`);
    return;
  }

  process.stderr.write(`${red("X")} ${result.title}\n`);
  process.stderr.write(`  Remediation:\n${result.remediation}\n`);
}

export function registerDoctorCommand(program) {
  program
    .command("doctor")
    .description("Run preflight checks for GitHub auth, repo access, and required issue template.")
    .action(async () => {
      let config;
      try {
        config = await loadAgentSwarmConfig();
      } catch (error) {
        process.stderr.write(`${red("X")} Failed to load .agent-swarm.yml\n`);
        process.stderr.write(`  ${error.message}\n`);
        if (error.remediation) {
          process.stderr.write(`  Remediation: ${error.remediation}\n`);
        }
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        `Running doctor checks for ${config.target.owner}/${config.target.repo} (Project V2 #${config.target.projectV2Number})\n`,
      );

      const checks = [];

      const tokenCheck = await checkToken({ tokenEnvName: config.auth.githubTokenEnv });
      checks.push(tokenCheck);

      const repoCheck = tokenCheck.ok
        ? await checkRepoConnection({
            owner: config.target.owner,
            repo: config.target.repo,
            token: tokenCheck.token,
            tokenEnvName: config.auth.githubTokenEnv,
          })
        : blocked(
            `Read/write access to ${config.target.owner}/${config.target.repo}`,
            `Fix check 1 first, then rerun: export ${config.auth.githubTokenEnv}=<your_github_pat_with_repo_and_project_access>`,
          );
      checks.push(repoCheck);

      const templateCheck = tokenCheck.ok && repoCheck.ok
        ? await checkTemplateExists({
            owner: config.target.owner,
            repo: config.target.repo,
            token: tokenCheck.token,
            tokenEnvName: config.auth.githubTokenEnv,
          })
        : blocked(
            `Required issue template (${REQUIRED_TEMPLATE_PATH})`,
            "Fix checks 1 and 2 first, then rerun: pnpm doctor",
          );
      checks.push(templateCheck);

      for (const check of checks) {
        printResult(check);
      }

      const failures = checks.filter((check) => !check.ok).length;
      if (failures > 0) {
        process.stderr.write(`${red("X")} Doctor failed (${failures} check${failures === 1 ? "" : "s"} failed)\n`);
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${green("✔")} Doctor passed (all checks succeeded)\n`);
      process.exitCode = 0;
    });
}
