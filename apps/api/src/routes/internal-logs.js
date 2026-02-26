import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const RUN_ID_RE = /^[A-Za-z0-9-]+$/u;
const EMPTY_ETAG = 'W/"0-0"';
const DEFAULT_WAIT_TIMEOUT_MS = 25000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 30000;
const WAIT_POLL_INTERVAL_MS = 400;

function parseRunId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !RUN_ID_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseWaitQueryFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_WAIT_TIMEOUT_MS;
  }
  const rounded = Math.trunc(parsed);
  return Math.max(MIN_WAIT_TIMEOUT_MS, Math.min(MAX_WAIT_TIMEOUT_MS, rounded));
}

function toEtag(fileStat) {
  return `W/"${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}"`;
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function readMeta(logPath) {
  try {
    const fileStat = await stat(logPath);
    return { etag: toEtag(fileStat) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { etag: EMPTY_ETAG };
    }
    throw error;
  }
}

async function readLogs(logPath, expectedEtag) {
  if (expectedEtag === EMPTY_ETAG) {
    return "";
  }
  try {
    return await readFile(logPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function buildInternalLogsHandler({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return async function internalLogsHandler(request, reply) {
    const runId = parseRunId(request?.params?.runId);
    if (!runId) {
      reply.code(400);
      return { error: "runId must contain only letters, numbers, and hyphens" };
    }

    const logPath = resolve(repoRoot, `.run-transcript.${runId}.log`);
    const ifNoneMatch = typeof request?.headers?.["if-none-match"] === "string" ? request.headers["if-none-match"].trim() : "";
    const shouldWait = parseWaitQueryFlag(request?.query?.wait);
    const timeoutMs = parseTimeoutMs(request?.query?.timeoutMs);

    let meta = await readMeta(logPath);
    if (ifNoneMatch && ifNoneMatch === meta.etag) {
      if (shouldWait) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && ifNoneMatch === meta.etag) {
          const remainingMs = deadline - Date.now();
          await sleep(Math.min(WAIT_POLL_INTERVAL_MS, Math.max(50, remainingMs)));
          meta = await readMeta(logPath);
        }
      }

      if (ifNoneMatch === meta.etag) {
        reply.code(304);
        reply.header("etag", meta.etag);
        return;
      }
    }

    const logs = await readLogs(logPath, meta.etag);
    reply.header("etag", meta.etag);
    return { logs, etag: meta.etag };
  };
}

export async function registerInternalLogsRoute(fastify, options = {}) {
  fastify.get("/internal/logs/:runId", buildInternalLogsHandler(options));
}
