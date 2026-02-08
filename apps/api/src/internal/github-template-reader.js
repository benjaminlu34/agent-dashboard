import { createHash } from "node:crypto";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_BASE_DELAY_MS = 150;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function decodeGitHubContent(payload) {
  if (!hasNonEmptyString(payload?.content)) {
    throw new GitHubTemplateReadError("invalid template contents response: missing content", {
      code: "template_invalid_response",
    });
  }

  const encoding = hasNonEmptyString(payload?.encoding) ? payload.encoding.trim().toLowerCase() : "";
  if (encoding !== "base64") {
    throw new GitHubTemplateReadError("invalid template contents response: unsupported encoding", {
      code: "template_invalid_response",
    });
  }

  const normalized = payload.content.replace(/\s+/g, "");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function buildTemplateUrl({ endpoint, ownerLogin, repoName, path, ref }) {
  const encodedPath = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const encodedRef = encodeURIComponent(ref);
  return `${endpoint}/repos/${ownerLogin}/${repoName}/contents/${encodedPath}?ref=${encodedRef}`;
}

export class GitHubTemplateReadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GitHubTemplateReadError";
    this.details = details;
    this.code = details.code ?? "template_read_error";
  }
}

export async function readTemplateMetadataFromGitHub({
  owner_login: ownerLogin,
  repo_name: repoName,
  path,
  ref = "HEAD",
  githubToken = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN,
  endpoint = DEFAULT_GITHUB_API_BASE_URL,
  retries = DEFAULT_RETRY_COUNT,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  fetchImpl = fetch,
} = {}) {
  if (!hasNonEmptyString(ownerLogin) || !hasNonEmptyString(repoName) || !hasNonEmptyString(path)) {
    throw new GitHubTemplateReadError("owner_login, repo_name, and path are required", {
      code: "template_invalid_identity",
    });
  }
  if (!hasNonEmptyString(githubToken)) {
    throw new GitHubTemplateReadError("missing GitHub token for template read", {
      code: "template_missing_token",
    });
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw new GitHubTemplateReadError("retries must be a non-negative integer", {
      code: "template_invalid_retries",
    });
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new GitHubTemplateReadError("baseDelayMs must be a non-negative integer", {
      code: "template_invalid_retry_delay",
    });
  }

  const url = buildTemplateUrl({ endpoint, ownerLogin, repoName, path, ref });
  const maxAttempts = retries + 1;
  let lastTransient = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${githubToken}`,
          accept: "application/vnd.github+json",
        },
      });
    } catch (error) {
      const transientError = new GitHubTemplateReadError("template fetch failed due to network error", {
        code: "template_fetch_network_error",
        attempt,
      });
      transientError.cause = error;
      lastTransient = transientError;

      if (attempt >= maxAttempts) {
        break;
      }
      await sleep(baseDelayMs * attempt);
      continue;
    }

    if (response.status === 404) {
      throw new GitHubTemplateReadError("required issue template is missing in target repo", {
        code: "template_missing",
        path,
        repo: `${ownerLogin}/${repoName}`,
        ref,
      });
    }

    if (RETRYABLE_STATUS_CODES.has(response.status)) {
      const payload = await parseResponseJson(response);
      lastTransient = new GitHubTemplateReadError("template fetch failed with transient GitHub response", {
        code: "template_fetch_transient",
        attempt,
        status: response.status,
        message: payload?.message,
      });

      if (attempt >= maxAttempts) {
        break;
      }
      await sleep(baseDelayMs * attempt);
      continue;
    }

    if (!response.ok) {
      const payload = await parseResponseJson(response);
      throw new GitHubTemplateReadError("template fetch failed", {
        code: "template_fetch_failed",
        status: response.status,
        message: payload?.message,
      });
    }

    const payload = await parseResponseJson(response);
    const templateContent = decodeGitHubContent(payload);
    return {
      path,
      size_bytes: Buffer.byteLength(templateContent, "utf8"),
      sha256: sha256(templateContent),
    };
  }

  throw new GitHubTemplateReadError("template fetch transient failures exhausted retries", {
    code: "template_fetch_transient_exhausted",
    attempts: maxAttempts,
    last_error_code: lastTransient?.code ?? "",
  });
}
