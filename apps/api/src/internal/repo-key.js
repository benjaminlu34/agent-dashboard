import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import YAML from "yaml";

const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizeRepoKeyToken(value) {
  return String(value).trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function readTargetIdentityFromAgentSwarm({ repoRoot }) {
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

export async function requireRepoKeyFromAgentSwarm({ repoRoot }) {
  const targetIdentity = await readTargetIdentityFromAgentSwarm({ repoRoot });
  if (!targetIdentity) {
    const error = new Error("Missing target.owner/target.repo in .agent-swarm.yml; cannot derive Redis repo_key");
    error.code = "repo_key_missing";
    throw error;
  }

  const ownerToken = sanitizeRepoKeyToken(targetIdentity.owner);
  const repoToken = sanitizeRepoKeyToken(targetIdentity.repo);
  return {
    repoKey: `${ownerToken}.${repoToken}`,
    targetIdentity,
  };
}

