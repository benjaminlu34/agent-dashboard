import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { AgentContextBundleError, loadAgentContextBundle } from "../internal/agent-context-loader.js";
import { readAgentSwarmTarget } from "../internal/agent-swarm-config.js";
import { fetchIssueBodyFromGithub, fetchRepositoryMapFromGithub } from "../internal/github-repository-map.js";
import { parseIssueTaskBrief } from "../internal/task-brief-parser.js";
import { resolveTargetIdentity, TargetIdentityError } from "../internal/target-identity.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const UPPERCASE_ROLE_RE = /^[A-Z][A-Z0-9_]*$/;
const PROJECT_IDENTITY_PATH = "policy/github-project.json";
const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";

function parseIssueNumberParam(rawIssueNumber) {
  if (rawIssueNumber === undefined || rawIssueNumber === null || rawIssueNumber === "") {
    return { issueNumber: null };
  }

  const parsed = Number(rawIssueNumber);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      error: "query parameter 'issue_number' must be a positive integer when provided",
    };
  }

  return { issueNumber: parsed };
}

function readRepoPolicyFromBundle(bundle) {
  const identityFile = bundle.files.find((file) => file.path === PROJECT_IDENTITY_PATH);
  if (!identityFile) {
    return null;
  }

  try {
    return JSON.parse(identityFile.content);
  } catch {
    return null;
  }
}

function readGitHubToken(env) {
  if (typeof env?.GITHUB_PAT === "string" && env.GITHUB_PAT.trim().length > 0) {
    return env.GITHUB_PAT.trim();
  }
  if (typeof env?.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0) {
    return env.GITHUB_TOKEN.trim();
  }
  return "";
}

async function readIgnorePathsConfig({ repoRoot }) {
  const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
  let rawConfig;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    return [];
  }

  let parsed;
  try {
    parsed = YAML.parse(rawConfig) ?? {};
  } catch {
    return [];
  }

  const ignorePaths = parsed?.agent?.ignore_paths;
  if (!Array.isArray(ignorePaths)) {
    return [];
  }

  return ignorePaths
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function buildAgentContextEnrichment({
  bundle,
  issueNumber,
  env,
  repoRoot,
  fetchImpl,
}) {
  const fallback = {
    task_brief: {},
    repository_map: [],
  };

  const repoPolicy = readRepoPolicyFromBundle(bundle);
  if (!repoPolicy) {
    return fallback;
  }

  let targetIdentity;
  try {
    const agentSwarmTarget = await readAgentSwarmTarget({ repoRoot });
    targetIdentity = resolveTargetIdentity({
      env,
      repoPolicy,
      agentSwarmTarget,
    });
  } catch (error) {
    if (error instanceof TargetIdentityError) {
      return fallback;
    }
    throw error;
  }

  const githubToken = readGitHubToken(env);
  if (!githubToken) {
    return fallback;
  }
  const ignorePaths = await readIgnorePathsConfig({ repoRoot });

  const [repositoryMap, issueBody] = await Promise.all([
    fetchRepositoryMapFromGithub({
      ownerLogin: targetIdentity.owner_login,
      repoName: targetIdentity.repo_name,
      ref: targetIdentity.ref,
      githubToken,
      ignorePaths,
      fetchImpl,
    }),
    issueNumber
      ? fetchIssueBodyFromGithub({
          ownerLogin: targetIdentity.owner_login,
          repoName: targetIdentity.repo_name,
          issueNumber,
          githubToken,
          fetchImpl,
        })
      : Promise.resolve(null),
  ]);

  return {
    repository_map: repositoryMap,
    task_brief: typeof issueBody === "string" ? parseIssueTaskBrief(issueBody) : {},
  };
}

export function buildAgentContextHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return async function agentContextHandler(request, reply) {
    const role = request?.query?.role;
    const issueNumberResult = parseIssueNumberParam(request?.query?.issue_number);

    if (typeof role !== "string" || role.trim().length === 0) {
      reply.code(400);
      return { error: "query parameter 'role' is required" };
    }

    const normalizedRole = role.toUpperCase();

    if (!UPPERCASE_ROLE_RE.test(normalizedRole)) {
      reply.code(400);
      return { error: "role must be a valid filename token (letters, digits, underscore)" };
    }
    if (issueNumberResult.error) {
      reply.code(400);
      return { error: issueNumberResult.error };
    }

    try {
      const bundle = await loadAgentContextBundle({ repoRoot, role: normalizedRole });
      const enrichment = await buildAgentContextEnrichment({
        bundle,
        issueNumber: issueNumberResult.issueNumber,
        env,
        repoRoot,
        fetchImpl,
      });

      return {
        ...bundle,
        task_brief: enrichment.task_brief,
        repository_map: enrichment.repository_map,
      };
    } catch (error) {
      if (error instanceof AgentContextBundleError) {
        reply.code(500);
        return {
          error: error.message,
          path: error.details.path,
        };
      }
      throw error;
    }
  };
}

export async function registerInternalAgentContextRoute(fastify, options = {}) {
  fastify.get("/internal/agent-context", buildAgentContextHandler(options));
}
