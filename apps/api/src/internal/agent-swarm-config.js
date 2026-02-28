import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import YAML from "yaml";

const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  if (hasNonEmptyString(value)) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

export async function readAgentSwarmTarget({ repoRoot } = {}) {
  if (!hasNonEmptyString(repoRoot)) {
    return null;
  }

  const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
  let rawConfig = "";
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsedConfig = null;
  try {
    parsedConfig = YAML.parse(rawConfig) ?? {};
  } catch {
    return null;
  }

  const target = parsedConfig?.target;
  if (!target || typeof target !== "object") {
    return null;
  }

  const owner = hasNonEmptyString(target.owner) ? target.owner.trim() : "";
  const repo = hasNonEmptyString(target.repo) ? target.repo.trim() : "";
  const projectV2Number = toPositiveInteger(target.project_v2_number);
  const projectName = hasNonEmptyString(target.project_name) ? target.project_name.trim() : "";

  if (!owner && !repo && projectV2Number === null && !projectName) {
    return null;
  }

  return {
    owner,
    repo,
    project_v2_number: projectV2Number,
    project_name: projectName,
  };
}
