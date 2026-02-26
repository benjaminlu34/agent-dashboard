import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";
const DEFAULT_ORCHESTRATOR_STATE_PATH = "./.orchestrator-state.json";
const DEFAULT_RUNNER_LEDGER_PATH = "./.runner-ledger.json";

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeStatePathToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function resolveDefaultStatePaths(targetIdentity) {
  const owner = targetIdentity?.owner;
  const repo = targetIdentity?.repo;
  if (!hasNonEmptyString(owner) || !hasNonEmptyString(repo)) {
    return {
      orchestrator: DEFAULT_ORCHESTRATOR_STATE_PATH,
      runner: DEFAULT_RUNNER_LEDGER_PATH,
    };
  }

  const ownerToken = sanitizeStatePathToken(owner);
  const repoToken = sanitizeStatePathToken(repo);
  return {
    orchestrator: `./.orchestrator-state.${ownerToken}.${repoToken}.json`,
    runner: `./.runner-ledger.${ownerToken}.${repoToken}.json`,
  };
}

async function readTargetIdentityFromAgentSwarm({ repoRoot }) {
  const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
  let rawConfig;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed;
  try {
    parsed = YAML.parse(rawConfig) ?? {};
  } catch {
    return null;
  }

  const owner = parsed?.target?.owner;
  const repo = parsed?.target?.repo;
  if (!hasNonEmptyString(owner) || !hasNonEmptyString(repo)) {
    return null;
  }

  return {
    owner: owner.trim(),
    repo: repo.trim(),
  };
}

function resolveStatePaths({ repoRoot, env, targetIdentity }) {
  const defaultPaths = resolveDefaultStatePaths(targetIdentity);

  const orchestratorPath = hasNonEmptyString(env?.ORCHESTRATOR_STATE_PATH)
    ? env.ORCHESTRATOR_STATE_PATH.trim()
    : defaultPaths.orchestrator;
  const runnerPath = hasNonEmptyString(env?.RUNNER_LEDGER_PATH) ? env.RUNNER_LEDGER_PATH.trim() : defaultPaths.runner;

  return {
    orchestratorPath: resolve(repoRoot, orchestratorPath),
    runnerPath: resolve(repoRoot, runnerPath),
  };
}

async function readJsonObjectOrEmpty(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function buildInternalStatusHandler({ repoRoot = DEFAULT_REPO_ROOT, env = process.env } = {}) {
  return async function internalStatusHandler(_request, reply) {
    const targetIdentity = await readTargetIdentityFromAgentSwarm({ repoRoot });
    const { orchestratorPath, runnerPath } = resolveStatePaths({
      repoRoot,
      env,
      targetIdentity,
    });

    const [orchestrator, runner] = await Promise.all([
      readJsonObjectOrEmpty(orchestratorPath),
      readJsonObjectOrEmpty(runnerPath),
    ]);

    if (hasNonEmptyString(targetIdentity?.owner) && hasNonEmptyString(targetIdentity?.repo)) {
      reply.header("x-target-owner", targetIdentity.owner);
      reply.header("x-target-repo", targetIdentity.repo);
    }

    return {
      orchestrator,
      runner,
    };
  };
}

export async function registerInternalStatusRoute(fastify, options = {}) {
  fastify.get("/internal/status", buildInternalStatusHandler(options));
}
