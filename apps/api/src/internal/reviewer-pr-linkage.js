const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTO_CLOSE_RE = /\b(?:closes|closed|fixes|fixed|resolves|resolved)\s*#(\d+)\b/gi;

export class ReviewerPrLinkageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReviewerPrLinkageError";
    this.details = details;
  }
}

function createLinkageError(code, message, details = {}) {
  return new ReviewerPrLinkageError(message, { code, ...details });
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

function parseExecutorRunMarker(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }

  // Allow optional whitespace after `<!--` so the marker can be rendered visibly inside
  // fenced code blocks without changing the canonical content.
  const markerMatch = body.match(/<!--\s*EXECUTOR_RUN_V1\s*\r?\n([\s\S]*?)\r?\n\s*-->/);
  if (!markerMatch) {
    if (/<!--\s*EXECUTOR_RUN_V1/.test(body)) {
      throw createLinkageError("malformed_marker", "malformed EXECUTOR_RUN_V1 marker block", { ambiguous: true });
    }
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
      throw createLinkageError("malformed_marker", "malformed EXECUTOR_RUN_V1 marker line", { ambiguous: true });
    }
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    values.set(key, value);
  }

  const issue = Number(values.get("issue"));
  const projectItemId = values.get("project_item_id");
  const runId = values.get("run_id");

  if (!Number.isInteger(issue) || issue <= 0) {
    throw createLinkageError("malformed_marker", "invalid EXECUTOR_RUN_V1 marker issue", { ambiguous: true });
  }
  if (typeof projectItemId !== "string" || projectItemId.length === 0) {
    throw createLinkageError("malformed_marker", "invalid EXECUTOR_RUN_V1 marker project_item_id", { ambiguous: true });
  }
  if (typeof runId !== "string" || runId.length === 0 || !UUID_RE.test(runId)) {
    throw createLinkageError("malformed_marker", "invalid EXECUTOR_RUN_V1 marker run_id", { ambiguous: true });
  }

  return {
    issue,
    project_item_id: projectItemId,
    run_id: runId,
  };
}

export async function resolveLinkedPullRequestForIssue({ githubClient, issueNumber }) {
  if (!githubClient || typeof githubClient.listPullRequests !== "function") {
    throw createLinkageError("invalid_client", "github client missing listPullRequests capability");
  }
  if (typeof githubClient.listProjectItems !== "function") {
    throw createLinkageError("invalid_client", "github client missing listProjectItems capability");
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw createLinkageError("invalid_input", "issueNumber must be a positive integer");
  }

  const projectItems = await githubClient.listProjectItems();
  const issueItems = projectItems.filter((item) => item?.issue_number === issueNumber);
  if (issueItems.length !== 1) {
    throw createLinkageError("ambiguous_linked_pr", "issue maps to zero or multiple project items", {
      ambiguous: true,
      issue_number: issueNumber,
      project_item_match_count: issueItems.length,
    });
  }
  const expectedProjectItemId = issueItems[0]?.project_item_id;
  if (typeof expectedProjectItemId !== "string" || expectedProjectItemId.length === 0) {
    throw createLinkageError("ambiguous_linked_pr", "resolved project item id is invalid", {
      ambiguous: true,
      issue_number: issueNumber,
    });
  }

  const pulls = await githubClient.listPullRequests({ state: "all" });
  const linked = [];

  for (const pr of pulls) {
    let body = typeof pr?.body === "string" ? pr.body : "";
    let prUrl = pr?.html_url ?? "";
    const prNumber = pr?.number;

    async function hydrateIfPossible(reason) {
      if (typeof githubClient.getPullRequest !== "function") {
        throw createLinkageError("ambiguous_linked_pr", "PR body unavailable and getPullRequest is not supported", {
          ambiguous: true,
          reason,
          pr_number: prNumber,
          pr_url: prUrl,
        });
      }
      const hydrated = await githubClient.getPullRequest({ prNumber });
      body = typeof hydrated?.body === "string" ? hydrated.body : "";
      prUrl = typeof hydrated?.html_url === "string" && hydrated.html_url.length > 0 ? hydrated.html_url : prUrl;
    }

    if (body.trim().length === 0) {
      await hydrateIfPossible("empty_body");
    }

    let refsThisIssue = hasRefsIssue(body, issueNumber);
    let marker = parseExecutorRunMarker(body);
    // Defensive: PR list endpoints can return incomplete bodies. If we see Refs #N but
    // can't parse the marker block, re-fetch the full PR body before failing closed.
    if (refsThisIssue && !marker && typeof githubClient.getPullRequest === "function" && body.trim().length > 0) {
      await hydrateIfPossible("marker_missing_from_list_body");
      refsThisIssue = hasRefsIssue(body, issueNumber);
      marker = parseExecutorRunMarker(body);
    }

    if (hasForbiddenAutoClose(body, issueNumber)) {
      throw createLinkageError("forbidden_autoclose", "forbidden auto-close keyword detected for linked issue", {
        ambiguous: true,
        pr_number: prNumber,
        pr_url: prUrl,
      });
    }

    if (!refsThisIssue && marker?.issue === issueNumber) {
      throw createLinkageError("marker_without_refs", "marker references issue without Refs #N", {
        ambiguous: true,
        pr_number: prNumber,
        pr_url: prUrl,
      });
    }

    if (!refsThisIssue) {
      continue;
    }

    if (!marker) {
      throw createLinkageError("unmarked_refs", "unmarked_refs", {
        ambiguous: true,
        pr_number: prNumber,
        pr_url: prUrl,
      });
    }

    if (marker.issue !== issueNumber) {
      throw createLinkageError("marker_issue_mismatch", "marker issue mismatch for Refs #N", {
        ambiguous: true,
        pr_number: prNumber,
        pr_url: prUrl,
      });
    }
    if (marker.project_item_id !== expectedProjectItemId) {
      throw createLinkageError("project_item_id_mismatch", "marker project_item_id does not match project item for issue", {
        ambiguous: true,
        pr_number: prNumber,
        pr_url: prUrl,
        issue_number: issueNumber,
        expected_project_item_id: expectedProjectItemId,
        actual_project_item_id: marker.project_item_id,
      });
    }

    linked.push({
      pr_number: prNumber,
      pr_url: prUrl,
      issue_number: issueNumber,
      project_item_id: marker.project_item_id,
      run_id: marker.run_id,
    });
  }

  if (linked.length !== 1) {
    throw createLinkageError("ambiguous_linked_pr", "ambiguous linked PR resolution", {
      ambiguous: true,
      issue_number: issueNumber,
      linked_count: linked.length,
      prs: linked,
    });
  }

  return linked[0];
}
