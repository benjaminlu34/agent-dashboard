import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import YAML from "yaml";

export const DEFAULT_CONFIG_FILE = ".agent-swarm.yml";

export class ConfigError extends Error {
  constructor(message, { code = "config_error", remediation } = {}) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.remediation = remediation;
  }
}

function asNonEmptyString(value, fieldPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`Invalid configuration: "${fieldPath}" must be a non-empty string.`, {
      code: "invalid_field",
      remediation: `Update ${DEFAULT_CONFIG_FILE} so "${fieldPath}" is set.`,
    });
  }
  return value.trim();
}

function asPositiveInteger(value, fieldPath) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return Number(value.trim());
  }
  throw new ConfigError(`Invalid configuration: "${fieldPath}" must be a positive integer.`, {
    code: "invalid_field",
    remediation: `Update ${DEFAULT_CONFIG_FILE} so "${fieldPath}" is set to 1 or greater.`,
  });
}

export async function loadAgentSwarmConfig({ cwd = process.cwd(), readFileImpl = readFile } = {}) {
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILE);
  let raw;
  try {
    raw = await readFileImpl(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new ConfigError(`Missing required config file: ${DEFAULT_CONFIG_FILE}.`, {
        code: "config_missing",
        remediation: `Create ${DEFAULT_CONFIG_FILE} in ${cwd} with target.owner, target.repo, and target.project_v2_number.`,
      });
    }
    throw error;
  }

  let parsed;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (error) {
    throw new ConfigError(`Failed to parse ${DEFAULT_CONFIG_FILE}: ${error.message}`, {
      code: "config_parse_error",
      remediation: `Fix YAML syntax in ${DEFAULT_CONFIG_FILE}.`,
    });
  }

  const target = parsed?.target;
  if (!target || typeof target !== "object") {
    throw new ConfigError(`Invalid configuration: "${DEFAULT_CONFIG_FILE}" must include "target".`, {
      code: "invalid_field",
      remediation: `Add a "target" section to ${DEFAULT_CONFIG_FILE}.`,
    });
  }

  const owner = asNonEmptyString(target.owner, "target.owner");
  const repo = asNonEmptyString(target.repo, "target.repo");
  const projectV2Number = asPositiveInteger(target.project_v2_number, "target.project_v2_number");

  const tokenEnvRaw = parsed?.auth?.github_token_env;
  const githubTokenEnv =
    typeof tokenEnvRaw === "string" && tokenEnvRaw.trim().length > 0 ? tokenEnvRaw.trim() : "GITHUB_TOKEN";

  return {
    path: configPath,
    target: {
      owner,
      repo,
      projectV2Number,
    },
    auth: {
      githubTokenEnv,
    },
  };
}
