import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const AGENT_SWARM_CONFIG_PATH = ".agent-swarm.yml";
const ENV_FILE_PATH = ".env";
const DEFAULT_AGENT_SWARM_CONFIG = {
  version: "1.0",
  target: {
    owner: "",
    repo: "",
    project_v2_number: null,
  },
  auth: {
    github_token_env: "GITHUB_TOKEN",
  },
};
const ENV_ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;
const REPO_CONFIG_MUTEXES = new Map();

class AsyncMutex {
  #locked = false;
  #waiters = [];

  async lock() {
    return new Promise((resolve) => {
      if (!this.#locked) {
        this.#locked = true;
        resolve(() => this.#unlock());
        return;
      }
      this.#waiters.push(resolve);
    });
  }

  #unlock() {
    const next = this.#waiters.shift();
    if (next) {
      next(() => this.#unlock());
      return;
    }
    this.#locked = false;
  }

  isIdle() {
    return !this.#locked && this.#waiters.length === 0;
  }
}

function getRepoConfigMutex(repoRoot) {
  const key = resolve(repoRoot);
  const existing = REPO_CONFIG_MUTEXES.get(key);
  if (existing) {
    return { key, mutex: existing };
  }
  const created = new AsyncMutex();
  REPO_CONFIG_MUTEXES.set(key, created);
  return { key, mutex: created };
}

async function withRepoConfigWriteLock(repoRoot, fn) {
  const { key, mutex } = getRepoConfigMutex(repoRoot);
  const unlock = await mutex.lock();
  try {
    return await fn();
  } finally {
    unlock();
  }
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toPositiveInteger(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function parseRequiredString(value, fieldName) {
  if (!hasNonEmptyString(value)) {
    return { error: `${fieldName} must be a non-empty string` };
  }
  return { value: value.trim() };
}

function parseRequiredPositiveInteger(value, fieldName) {
  const parsed = toPositiveInteger(value);
  if (!parsed) {
    return { error: `${fieldName} must be a positive integer` };
  }
  return { value: parsed };
}

function parseQuotedEnvValue(rawValue) {
  const trimmed = rawValue.trim();

  let withoutInlineComment = trimmed;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#" && (index === 0 || /\s/u.test(trimmed[index - 1]))) {
      withoutInlineComment = trimmed.slice(0, index).trim();
      break;
    }
  }

  if (withoutInlineComment.startsWith('"') && withoutInlineComment.endsWith('"')) {
    try {
      return JSON.parse(withoutInlineComment);
    } catch {
      return withoutInlineComment.slice(1, -1);
    }
  }
  if (withoutInlineComment.startsWith("'") && withoutInlineComment.endsWith("'")) {
    return withoutInlineComment.slice(1, -1);
  }

  return withoutInlineComment;
}

function parseEnvVariables(rawEnvContent) {
  const variables = new Map();
  const lines = String(rawEnvContent ?? "").split(/\r?\n/u);

  for (const line of lines) {
    const match = line.match(ENV_ASSIGNMENT_RE);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    variables.set(key, parseQuotedEnvValue(rawValue));
  }

  return variables;
}

function formatEnvValue(value) {
  const normalized = String(value ?? "");
  if (normalized.length === 0) {
    return '""';
  }
  if (/[\s#"'`\\]/.test(normalized)) {
    return JSON.stringify(normalized);
  }
  return normalized;
}

function upsertEnvVariable(rawEnvContent, key, value) {
  const normalized = String(rawEnvContent ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }

  const nextLine = `${key}=${formatEnvValue(value)}`;
  let updated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(ENV_ASSIGNMENT_RE);
    if (!match || match[1] !== key) {
      continue;
    }
    lines[index] = nextLine;
    updated = true;
    break;
  }

  if (!updated) {
    lines.push(nextLine);
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function readOrCreateFile(filePath, initialContent = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await writeFile(filePath, initialContent, "utf8");
    return initialContent;
  }
}

function parseAgentSwarmConfig(rawConfig) {
  try {
    const parsed = YAML.parse(rawConfig) ?? {};
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeAgentSwarmConfig(config) {
  const base = isObject(config) ? { ...config } : {};
  const target = isObject(base.target) ? { ...base.target } : {};
  const auth = isObject(base.auth) ? { ...base.auth } : {};

  if (!hasNonEmptyString(auth.github_token_env)) {
    auth.github_token_env = "GITHUB_TOKEN";
  }

  return {
    ...base,
    target,
    auth,
  };
}

function buildConfigPayload({ config, envVars }) {
  const targetOwner = hasNonEmptyString(config?.target?.owner) ? config.target.owner.trim() : "";
  const targetRepo = hasNonEmptyString(config?.target?.repo) ? config.target.repo.trim() : "";

  return {
    targetOwner,
    targetRepo,
    projectNumber: toPositiveInteger(config?.target?.project_v2_number),
    maxExecutors: toPositiveInteger(envVars.get("RUNNER_MAX_EXECUTORS")),
    maxReviewers: toPositiveInteger(envVars.get("RUNNER_MAX_REVIEWERS")),
    hasGithubToken: hasNonEmptyString(envVars.get("GITHUB_TOKEN")),
  };
}

function parseConfigBody(body) {
  if (!isObject(body)) {
    return { error: "request body must be a JSON object" };
  }

  const errors = [];
  const targetOwner = parseRequiredString(body.targetOwner, "targetOwner");
  const targetRepo = parseRequiredString(body.targetRepo, "targetRepo");
  const projectNumber = parseRequiredPositiveInteger(body.projectNumber, "projectNumber");
  const maxExecutors = parseRequiredPositiveInteger(body.maxExecutors, "maxExecutors");
  const maxReviewers = parseRequiredPositiveInteger(body.maxReviewers, "maxReviewers");

  if (targetOwner.error) {
    errors.push({ field: "targetOwner", message: targetOwner.error });
  }
  if (targetRepo.error) {
    errors.push({ field: "targetRepo", message: targetRepo.error });
  }
  if (projectNumber.error) {
    errors.push({ field: "projectNumber", message: projectNumber.error });
  }
  if (maxExecutors.error) {
    errors.push({ field: "maxExecutors", message: maxExecutors.error });
  }
  if (maxReviewers.error) {
    errors.push({ field: "maxReviewers", message: maxReviewers.error });
  }

  if (body.githubToken !== undefined && typeof body.githubToken !== "string") {
    errors.push({ field: "githubToken", message: "githubToken must be a string when provided" });
  }

  if (errors.length > 0) {
    return {
      error: errors[0].message,
      errors,
    };
  }

  return {
    value: {
      targetOwner: targetOwner.value,
      targetRepo: targetRepo.value,
      projectNumber: projectNumber.value,
      maxExecutors: maxExecutors.value,
      maxReviewers: maxReviewers.value,
      githubToken: hasNonEmptyString(body.githubToken) ? body.githubToken.trim() : "",
    },
  };
}

export function buildInternalConfigGetHandler({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return async function internalConfigGetHandler(_request, _reply) {
    const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
    const envPath = resolve(repoRoot, ENV_FILE_PATH);

    const [rawConfig, rawEnv] = await Promise.all([
      readOrCreateFile(configPath, YAML.stringify(DEFAULT_AGENT_SWARM_CONFIG)),
      readOrCreateFile(envPath, ""),
    ]);

    const config = normalizeAgentSwarmConfig(parseAgentSwarmConfig(rawConfig));
    const envVars = parseEnvVariables(rawEnv);

    return buildConfigPayload({ config, envVars });
  };
}

export function buildInternalConfigPostHandler({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return async function internalConfigPostHandler(request, reply) {
    const parsedBody = parseConfigBody(request?.body);
    if (parsedBody.error) {
      reply.code(400);
      return {
        error: parsedBody.error,
        errors: Array.isArray(parsedBody.errors) ? parsedBody.errors : undefined,
      };
    }

    return withRepoConfigWriteLock(repoRoot, async () => {
      const { targetOwner, targetRepo, projectNumber, maxExecutors, maxReviewers, githubToken } = parsedBody.value;
      const configPath = resolve(repoRoot, AGENT_SWARM_CONFIG_PATH);
      const envPath = resolve(repoRoot, ENV_FILE_PATH);

      const [rawConfig, rawEnv] = await Promise.all([
        readOrCreateFile(configPath, YAML.stringify(DEFAULT_AGENT_SWARM_CONFIG)),
        readOrCreateFile(envPath, ""),
      ]);

      const config = normalizeAgentSwarmConfig(parseAgentSwarmConfig(rawConfig));
      config.version = hasNonEmptyString(config.version) ? config.version.trim() : "1.0";
      config.target = {
        ...(isObject(config.target) ? config.target : {}),
        owner: targetOwner,
        repo: targetRepo,
        project_v2_number: projectNumber,
      };
      config.auth = {
        ...(isObject(config.auth) ? config.auth : {}),
        github_token_env: "GITHUB_TOKEN",
      };

      let nextEnv = upsertEnvVariable(rawEnv, "RUNNER_MAX_EXECUTORS", String(maxExecutors));
      nextEnv = upsertEnvVariable(nextEnv, "RUNNER_MAX_REVIEWERS", String(maxReviewers));
      if (hasNonEmptyString(githubToken)) {
        nextEnv = upsertEnvVariable(nextEnv, "GITHUB_TOKEN", githubToken);
      }

      await Promise.all([writeFile(configPath, YAML.stringify(config), "utf8"), writeFile(envPath, nextEnv, "utf8")]);

      const envVars = parseEnvVariables(nextEnv);
      return buildConfigPayload({ config, envVars });
    });
  };
}

export async function registerInternalConfigRoute(fastify, options = {}) {
  fastify.get("/internal/config", buildInternalConfigGetHandler(options));
  fastify.post("/internal/config", buildInternalConfigPostHandler(options));
}
