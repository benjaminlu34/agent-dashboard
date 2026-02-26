import process from "node:process";

import { loadAgentSwarmConfig } from "../config.js";

const GITHUB_API_BASE = "https://api.github.com";
const REQUIRED_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/milestone-task.yml";
const REQUIRED_TEMPLATE_CONTENT = `name: Milestone Task
description: Create a concrete, testable milestone task with explicit scope and outcomes.
title: "[TASK] "
labels:
  - infrastructure
body:
  - type: markdown
    attributes:
      value: |
        Use this template for milestone-scoped tasks only.

        Vague tasks are not allowed.
        Every task must be testable, include clear success criteria, and avoid ambiguous wording.

  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: State one concrete outcome.
      placeholder: Describe the exact result this task must produce.
    validations:
      required: true

  - type: textarea
    id: non_goals
    attributes:
      label: Non-goals
      description: Explicitly list what is out of scope.
      placeholder: |
        - Not included:
        - Not included:
    validations:
      required: true

  - type: textarea
    id: acceptance_criteria
    attributes:
      label: Acceptance Criteria
      description: Provide a checklist of testable, objective criteria.
      placeholder: |
        - [ ]
        - [ ]
        - [ ]
    validations:
      required: true

  - type: textarea
    id: files_likely_touched
    attributes:
      label: Files Likely Touched
      description: List expected files or directories.
      placeholder: |
        - path/to/file
        - path/to/dir/
    validations:
      required: true

  - type: textarea
    id: definition_of_done
    attributes:
      label: Definition of Done
      description: Define the completion checklist.
      placeholder: |
        - [ ] Implementation complete
        - [ ] Tests pass
        - [ ] Documentation updated (if needed)
    validations:
      required: true

  - type: dropdown
    id: size
    attributes:
      label: Size (S/M/L only)
      description: Select one size.
      options:
        - S
        - M
        - L
    validations:
      required: true
`;

function green(text) {
  return `\u001b[32m${text}\u001b[0m`;
}

function red(text) {
  return `\u001b[31m${text}\u001b[0m`;
}

function encodeContentPath(path) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function githubJsonRequest({ path, token, method = "GET", body }) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-swarm-cli/0.1.0",
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
  return [
    `gh repo clone ${owner}/${repo} /tmp/${repo}`,
    `cd /tmp/${repo}`,
    "mkdir -p .github/ISSUE_TEMPLATE",
    "cat > .github/ISSUE_TEMPLATE/milestone-task.yml <<'YAML'",
    REQUIRED_TEMPLATE_CONTENT.trimEnd(),
    "YAML",
    'git add .github/ISSUE_TEMPLATE/milestone-task.yml && git commit -m "Add required milestone task template"',
    "git push",
  ].join("\n");
}

async function checkToken({ tokenEnvName }) {
  const token = process.env[tokenEnvName];
  if (!token || token.trim().length === 0) {
    return {
      ok: false,
      title: `GITHUB token is available in ${tokenEnvName}`,
      remediation: `Run: export ${tokenEnvName}=<your_github_pat_with_repo_and_project_access>`,
    };
  }

  const { response, data } = await githubJsonRequest({
    path: "/user",
    token,
  });

  if (response.status === 401) {
    return {
      ok: false,
      title: "GITHUB_TOKEN is valid and authenticated",
      remediation: `Run: gh auth login --scopes "repo,project" && export ${tokenEnvName}=$(gh auth token)`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      title: "GITHUB_TOKEN is valid and authenticated",
      remediation: `Run: curl -i -H "Authorization: Bearer $${tokenEnvName}" https://api.github.com/user`,
    };
  }

  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  const scopes = scopesHeader
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (scopes.length === 0) {
    return {
      ok: false,
      title: "GITHUB_TOKEN has active OAuth scopes",
      remediation:
        `Regenerate token with scopes and export it: gh auth login --scopes "repo,project" && export ${tokenEnvName}=$(gh auth token)`,
    };
  }

  return {
    ok: true,
    title: "GITHUB_TOKEN is set and has active scopes",
    detail: `as ${data?.login ?? "unknown-user"} with scopes: ${scopes.join(", ")}`,
    token,
  };
}

async function checkRepoConnection({ owner, repo, token, tokenEnvName }) {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const { response, data } = await githubJsonRequest({
    path: repoPath,
    token,
  });

  if (response.status === 404) {
    return {
      ok: false,
      title: `Target repo ${owner}/${repo} is reachable`,
      remediation: `Fix ${owner}/${repo} in .agent-swarm.yml and verify with: curl -H "Authorization: Bearer $${tokenEnvName}" https://api.github.com/repos/${owner}/${repo}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      title: `Target repo ${owner}/${repo} is reachable`,
      remediation: `Run: curl -i -H "Authorization: Bearer $${tokenEnvName}" https://api.github.com/repos/${owner}/${repo}`,
    };
  }

  const permissions = data?.permissions && typeof data.permissions === "object" ? data.permissions : {};
  const hasWrite = Boolean(permissions.admin || permissions.maintain || permissions.push);

  if (!hasWrite) {
    return {
      ok: false,
      title: `Read/write access to ${owner}/${repo}`,
      remediation:
        `Grant this token write access to ${owner}/${repo} (Write/Maintain/Admin), then verify with: ` +
        `curl -H "Authorization: Bearer $${tokenEnvName}" https://api.github.com/repos/${owner}/${repo}`,
    };
  }

  return {
    ok: true,
    title: `Read/write access to ${owner}/${repo}`,
    detail: "repository read and write permissions confirmed",
  };
}

async function checkTemplateExists({ owner, repo, token, tokenEnvName }) {
  const encodedTemplatePath = encodeContentPath(REQUIRED_TEMPLATE_PATH);
  const { response } = await githubJsonRequest({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedTemplatePath}`,
    token,
  });

  if (response.status === 404) {
    return {
      ok: false,
      title: `Required issue template exists (${REQUIRED_TEMPLATE_PATH})`,
      remediation: templateRemediation(owner, repo),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      title: `Required issue template exists (${REQUIRED_TEMPLATE_PATH})`,
      remediation: `Run: curl -i -H "Authorization: Bearer $${tokenEnvName}" https://api.github.com/repos/${owner}/${repo}/contents/${encodedTemplatePath}`,
    };
  }

  return {
    ok: true,
    title: `Required issue template exists (${REQUIRED_TEMPLATE_PATH})`,
  };
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

      const tokenCheck = await checkToken({ tokenEnvName: config.auth.githubTokenEnv });
      printResult(tokenCheck);

      let repoCheck;
      if (tokenCheck.ok) {
        repoCheck = await checkRepoConnection({
          owner: config.target.owner,
          repo: config.target.repo,
          token: tokenCheck.token,
          tokenEnvName: config.auth.githubTokenEnv,
        });
      } else {
        repoCheck = {
          ok: false,
          title: `Read/write access to ${config.target.owner}/${config.target.repo}`,
          remediation: `Fix check 1 first, then rerun: export ${config.auth.githubTokenEnv}=<your_github_pat_with_repo_and_project_access>`,
        };
      }
      printResult(repoCheck);

      let templateCheck;
      if (tokenCheck.ok && repoCheck.ok) {
        templateCheck = await checkTemplateExists({
          owner: config.target.owner,
          repo: config.target.repo,
          token: tokenCheck.token,
          tokenEnvName: config.auth.githubTokenEnv,
        });
      } else {
        templateCheck = {
          ok: false,
          title: `Required issue template exists (${REQUIRED_TEMPLATE_PATH})`,
          remediation: `Fix checks 1 and 2 first, then rerun: node apps/cli/src/index.js doctor`,
        };
      }
      printResult(templateCheck);

      const checks = [tokenCheck, repoCheck, templateCheck];

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
