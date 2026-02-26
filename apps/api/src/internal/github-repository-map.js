const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePathLikeValue(value) {
  if (!hasNonEmptyString(value)) {
    return "";
  }

  return value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\.\/+/u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
}

function normalizeApiBaseUrl(apiBaseUrl) {
  if (!hasNonEmptyString(apiBaseUrl)) {
    return DEFAULT_GITHUB_API_BASE_URL;
  }
  return apiBaseUrl.trim().replace(/\/+$/u, "");
}

function escapeRegexCharacter(character) {
  return character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globPatternToRegex(pattern) {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegexCharacter(character);
  }

  return new RegExp(`^${source}$`, "u");
}

function normalizeIgnorePaths(ignorePaths) {
  if (!Array.isArray(ignorePaths)) {
    return [];
  }

  return ignorePaths
    .filter((entry) => typeof entry === "string")
    .map((entry) => normalizePathLikeValue(entry).toLowerCase())
    .filter((entry) => entry.length > 0);
}

function buildIgnoreMatchers(ignorePaths) {
  const normalizedPatterns = normalizeIgnorePaths(ignorePaths);
  return normalizedPatterns.map((pattern) => {
    const hasWildcard = /[*?]/u.test(pattern);
    const hasSlash = pattern.includes("/");

    if (!hasWildcard && !hasSlash) {
      return {
        kind: "segment",
        value: pattern,
      };
    }
    if (!hasWildcard && hasSlash) {
      return {
        kind: "prefix",
        value: pattern,
      };
    }
    if (hasWildcard && !hasSlash) {
      return {
        kind: "segment_glob",
        regex: globPatternToRegex(pattern),
      };
    }

    return {
      kind: "path_glob",
      regex: globPatternToRegex(pattern),
    };
  });
}

function isIgnoredPath({ normalizedPathLower, pathSegmentsLower, ignoreMatchers }) {
  for (const matcher of ignoreMatchers) {
    if (matcher.kind === "segment" && pathSegmentsLower.includes(matcher.value)) {
      return true;
    }

    if (
      matcher.kind === "prefix" &&
      (normalizedPathLower === matcher.value || normalizedPathLower.startsWith(`${matcher.value}/`))
    ) {
      return true;
    }

    if (matcher.kind === "segment_glob" && pathSegmentsLower.some((segment) => matcher.regex.test(segment))) {
      return true;
    }

    if (matcher.kind === "path_glob" && matcher.regex.test(normalizedPathLower)) {
      return true;
    }
  }

  return false;
}

async function requestGithubJson({
  url,
  githubToken,
  fetchImpl = fetch,
}) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
      },
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        payload,
      };
    }

    return {
      ok: true,
      status: response.status,
      payload,
    };
  } catch {
    return {
      ok: false,
      status: 0,
      payload: null,
    };
  }
}

async function fetchDefaultBranch({
  ownerLogin,
  repoName,
  githubToken,
  fetchImpl,
  apiBaseUrl,
}) {
  const url =
    `${normalizeApiBaseUrl(apiBaseUrl)}/repos/${encodeURIComponent(ownerLogin)}` +
    `/${encodeURIComponent(repoName)}`;
  const result = await requestGithubJson({
    url,
    githubToken,
    fetchImpl,
  });
  if (!result.ok) {
    return "";
  }
  return hasNonEmptyString(result.payload?.default_branch) ? result.payload.default_branch.trim() : "";
}

function buildTreeUrl({ ownerLogin, repoName, ref, apiBaseUrl }) {
  return (
    `${normalizeApiBaseUrl(apiBaseUrl)}/repos/${encodeURIComponent(ownerLogin)}` +
    `/${encodeURIComponent(repoName)}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  );
}

export function filterRepositoryMapPaths(treeEntries, ignorePaths = []) {
  if (!Array.isArray(treeEntries)) {
    return [];
  }

  const ignoreMatchers = buildIgnoreMatchers(ignorePaths);
  const uniquePaths = new Set();
  for (const entry of treeEntries) {
    if (entry?.type !== "blob" || !hasNonEmptyString(entry?.path)) {
      continue;
    }

    const normalizedPath = normalizePathLikeValue(entry.path);
    if (normalizedPath.length === 0) {
      continue;
    }

    const normalizedPathLower = normalizedPath.toLowerCase();
    const pathSegmentsLower = normalizedPathLower.split("/");
    if (isIgnoredPath({ normalizedPathLower, pathSegmentsLower, ignoreMatchers })) {
      continue;
    }

    uniquePaths.add(normalizedPath);
  }

  return Array.from(uniquePaths).sort((left, right) => left.localeCompare(right));
}

export async function fetchIssueBodyFromGithub({
  ownerLogin,
  repoName,
  issueNumber,
  githubToken,
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
} = {}) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }
  if (!hasNonEmptyString(ownerLogin) || !hasNonEmptyString(repoName) || !hasNonEmptyString(githubToken)) {
    return null;
  }

  const url =
    `${normalizeApiBaseUrl(apiBaseUrl)}/repos/${encodeURIComponent(ownerLogin)}` +
    `/${encodeURIComponent(repoName)}/issues/${issueNumber}`;
  const result = await requestGithubJson({
    url,
    githubToken,
    fetchImpl,
  });
  if (!result.ok) {
    return null;
  }
  return typeof result.payload?.body === "string" ? result.payload.body : "";
}

export async function fetchRepositoryMapFromGithub({
  ownerLogin,
  repoName,
  ref = "HEAD",
  githubToken,
  ignorePaths = [],
  fetchImpl = fetch,
  apiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
} = {}) {
  if (!hasNonEmptyString(ownerLogin) || !hasNonEmptyString(repoName) || !hasNonEmptyString(githubToken)) {
    return [];
  }

  const candidateRefs = [];
  const normalizedRef = hasNonEmptyString(ref) ? ref.trim() : "HEAD";
  candidateRefs.push(normalizedRef);

  for (const candidateRef of candidateRefs) {
    const treeResult = await requestGithubJson({
      url: buildTreeUrl({
        ownerLogin,
        repoName,
        ref: candidateRef,
        apiBaseUrl,
      }),
      githubToken,
      fetchImpl,
    });

    if (treeResult.ok && Array.isArray(treeResult.payload?.tree)) {
      return filterRepositoryMapPaths(treeResult.payload.tree, ignorePaths);
    }
  }

  if (normalizedRef.toUpperCase() !== "HEAD") {
    return [];
  }

  const defaultBranch = await fetchDefaultBranch({
    ownerLogin,
    repoName,
    githubToken,
    fetchImpl,
    apiBaseUrl,
  });
  if (!defaultBranch || defaultBranch.toUpperCase() === "HEAD") {
    return [];
  }

  const fallbackResult = await requestGithubJson({
    url: buildTreeUrl({
      ownerLogin,
      repoName,
      ref: defaultBranch,
      apiBaseUrl,
    }),
    githubToken,
    fetchImpl,
  });
  if (!fallbackResult.ok || !Array.isArray(fallbackResult.payload?.tree)) {
    return [];
  }

  return filterRepositoryMapPaths(fallbackResult.payload.tree, ignorePaths);
}
