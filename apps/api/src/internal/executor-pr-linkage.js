const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER_START = "<!-- EXECUTOR_RUN_V1";
const AUTO_CLOSE_RE = /\b(?:closes|closed|fixes|fixed|resolves|resolved)\s*#(\d+)\b/gi;

export class ExecutorPrLinkageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExecutorPrLinkageError";
    this.details = details;
  }
}

function hasRefsIssue(body, issueNumber) {
  if (typeof body !== "string") {
    return false;
  }
  const refsRe = new RegExp(`\\bRefs\\s*#${issueNumber}\\b`, "i");
  return refsRe.test(body);
}

function hasForbiddenAutoClose(body, issueNumber) {
  if (typeof body !== "string") {
    return false;
  }
  const matches = body.matchAll(AUTO_CLOSE_RE);
  for (const match of matches) {
    if (Number(match[1]) === issueNumber) {
      return true;
    }
  }
  return false;
}

function parseMarkerBlock(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  const markerMatch = body.match(/<!-- EXECUTOR_RUN_V1\s*\n([\s\S]*?)\n-->/);
  if (!markerMatch) {
    return null;
  }

  const lines = markerMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const values = new Map();
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) {
      throw new ExecutorPrLinkageError("malformed executor marker line", { ambiguous: true });
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    values.set(key, value);
  }

  const issueValue = values.get("issue");
  const projectItemId = values.get("project_item_id");
  const runId = values.get("run_id");
  const issue = Number(issueValue);

  if (!Number.isInteger(issue) || issue <= 0) {
    throw new ExecutorPrLinkageError("invalid executor marker issue", { ambiguous: true });
  }
  if (typeof projectItemId !== "string" || projectItemId.length === 0) {
    throw new ExecutorPrLinkageError("invalid executor marker project_item_id", { ambiguous: true });
  }
  if (typeof runId === "string" && runId.length > 0 && !UUID_RE.test(runId)) {
    throw new ExecutorPrLinkageError("invalid executor marker run_id", { ambiguous: true });
  }

  return {
    issue,
    project_item_id: projectItemId,
    run_id: typeof runId === "string" && runId.length > 0 ? runId : null,
  };
}

export async function assertZeroLinkedPullRequests({ githubClient, issueNumber, projectItemId }) {
  if (!githubClient || typeof githubClient.listPullRequests !== "function") {
    throw new ExecutorPrLinkageError("github client missing listPullRequests capability");
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new ExecutorPrLinkageError("issueNumber must be a positive integer");
  }
  if (typeof projectItemId !== "string" || projectItemId.trim().length === 0) {
    throw new ExecutorPrLinkageError("projectItemId is required");
  }

  const pulls = await githubClient.listPullRequests({ state: "all" });
  const linked = [];

  for (const pr of pulls) {
    const body = typeof pr?.body === "string" ? pr.body : "";
    const refsThisIssue = hasRefsIssue(body, issueNumber);
    const marker = parseMarkerBlock(body);

    if (hasForbiddenAutoClose(body, issueNumber)) {
      throw new ExecutorPrLinkageError("forbidden auto-close keyword detected for issue linkage", {
        pr_number: pr?.number,
        pr_url: pr?.html_url ?? "",
      });
    }

    if (!refsThisIssue && marker?.issue === issueNumber) {
      throw new ExecutorPrLinkageError("executor marker references issue without Refs #N", {
        ambiguous: true,
        pr_number: pr?.number,
        pr_url: pr?.html_url ?? "",
      });
    }

    if (!refsThisIssue) {
      continue;
    }

    if (!marker) {
      linked.push({
        reason: "unmarked_refs",
        pr_number: pr?.number,
        pr_url: pr?.html_url ?? "",
      });
      continue;
    }

    if (marker.issue !== issueNumber) {
      throw new ExecutorPrLinkageError("executor marker issue mismatch for Refs #N", {
        ambiguous: true,
        pr_number: pr?.number,
        pr_url: pr?.html_url ?? "",
      });
    }
    if (marker.project_item_id !== projectItemId) {
      throw new ExecutorPrLinkageError("executor marker project_item_id mismatch for issue", {
        ambiguous: true,
        pr_number: pr?.number,
        pr_url: pr?.html_url ?? "",
      });
    }

    linked.push({
      reason: "marked_linked_pr",
      pr_number: pr?.number,
      pr_url: pr?.html_url ?? "",
    });
  }

  if (linked.length > 1) {
    throw new ExecutorPrLinkageError("multiple linked PRs found for issue", {
      ambiguous: true,
      prs: linked,
    });
  }

  if (linked.length === 1) {
    return {
      linked: true,
      reason: linked[0].reason,
      pr_number: linked[0].pr_number,
      pr_url: linked[0].pr_url,
    };
  }

  return { linked: false };
}
