function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const SPRINT_GOAL_TOKEN_RE = /\[\s*SPRINT\s+GOAL\s*\]/i;

function isSprintGoalIssue(issue) {
  const title = isNonEmptyString(issue?.title) ? issue.title.trim() : "";
  if (SPRINT_GOAL_TOKEN_RE.test(title)) {
    return true;
  }
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const raw of labels) {
    if (!isNonEmptyString(raw)) {
      continue;
    }
    if (raw.trim().toLowerCase() === "meta:sprint-goal") {
      return true;
    }
  }
  return false;
}

export function normalizePath(value) {
  if (!isNonEmptyString(value)) {
    return "";
  }

  let normalized = value.trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.replace(/\/+/g, "/");

  if (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized;
}

export function pathsOverlap(leftPath, rightPath) {
  const left = normalizePath(leftPath);
  const right = normalizePath(rightPath);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  if (left.startsWith(`${right}/`)) {
    return true;
  }
  if (right.startsWith(`${left}/`)) {
    return true;
  }
  return false;
}

function priorityRank(value) {
  const normalized = isNonEmptyString(value) ? value.trim().toUpperCase() : "";
  if (normalized === "P0") {
    return 0;
  }
  if (normalized === "P1") {
    return 1;
  }
  if (normalized === "P2") {
    return 2;
  }
  return 99;
}

function uniqueSortedStrings(values) {
  const set = new Set();
  for (const entry of values ?? []) {
    const normalized = normalizePath(entry);
    if (normalized) {
      set.add(normalized);
    }
  }
  return [...set].sort((left, right) => left.localeCompare(right));
}

function normalizeBuckets(buckets) {
  const normalized = uniqueSortedStrings(buckets);
  // Prefer longest-prefix matches.
  normalized.sort((left, right) => right.length - left.length || left.localeCompare(right));
  return normalized;
}

function bucketForPath(pathValue, buckets) {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return "";
  }

  for (const bucket of buckets) {
    if (normalized === bucket) {
      return bucket;
    }
    if (normalized.startsWith(`${bucket}/`)) {
      return bucket;
    }
  }

  const [firstSegment] = normalized.split("/", 1);
  return firstSegment ?? "";
}

function computeTouchAndOwnsPaths({ rawTouchPaths, buckets, sharedCorePaths }) {
  const normalizedBuckets = normalizeBuckets(buckets);
  const touched = [];

  for (const raw of rawTouchPaths ?? []) {
    const bucket = bucketForPath(raw, normalizedBuckets);
    if (bucket) {
      touched.push(bucket);
    }
  }

  const touchPaths = uniqueSortedStrings(touched);
  const sharedTouched = touchPaths.filter((path) => sharedCorePaths.has(path));

  let primary = "";
  const counts = new Map();
  for (const raw of rawTouchPaths ?? []) {
    const bucket = bucketForPath(raw, normalizedBuckets);
    if (!bucket) {
      continue;
    }
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  for (const [bucket, count] of counts.entries()) {
    if (!touchPaths.includes(bucket)) {
      continue;
    }
    if (!primary) {
      primary = bucket;
      continue;
    }
    const primaryCount = counts.get(primary) ?? 0;
    if (count > primaryCount) {
      primary = bucket;
      continue;
    }
    if (count === primaryCount && bucket.localeCompare(primary) < 0) {
      primary = bucket;
    }
  }

  // Own the primary component bucket, plus any shared-core buckets touched.
  const ownsPaths = uniqueSortedStrings([primary, ...sharedTouched].filter(Boolean));
  return { touch_paths: touchPaths, owns_paths: ownsPaths };
}

function determineGroupId({ ownsPaths, sharedCorePaths }) {
  const sharedOwned = ownsPaths.filter((path) => sharedCorePaths.has(path)).sort((a, b) => a.localeCompare(b));
  if (sharedOwned.length > 0) {
    return `shared:${sharedOwned[0]}`;
  }

  const primary = ownsPaths.length > 0 ? ownsPaths.slice().sort((a, b) => a.localeCompare(b))[0] : "unknown";
  return `component:${primary}`;
}

export async function buildRepoArchitectureMap({ githubClient }) {
  const rootEntries = await githubClient.listRepoDirectory({ path: "" });
  const rootDirs = new Set(rootEntries.filter((e) => e?.type === "dir").map((e) => e.name));
  const rootFiles = new Set(rootEntries.filter((e) => e?.type === "file").map((e) => e.name));

  const buckets = [];
  for (const dir of [...rootDirs].sort((a, b) => a.localeCompare(b))) {
    buckets.push(dir);
  }

  const appsBuckets = [];
  if (rootDirs.has("apps")) {
    const appsEntries = await githubClient.listRepoDirectory({ path: "apps" });
    for (const entry of appsEntries ?? []) {
      if (entry?.type === "dir" && isNonEmptyString(entry.name)) {
        appsBuckets.push(`apps/${entry.name.trim()}`);
      }
    }
  }

  const assetsBuckets = [];
  if (rootDirs.has("Assets")) {
    try {
      const assetsEntries = await githubClient.listRepoDirectory({ path: "Assets" });
      const assetsDirs = new Set(assetsEntries.filter((e) => e?.type === "dir").map((e) => e.name));
      for (const dir of [...assetsDirs].sort((a, b) => a.localeCompare(b))) {
        assetsBuckets.push(`Assets/${dir}`);
      }

      if (assetsDirs.has("Game")) {
        try {
          const gameEntries = await githubClient.listRepoDirectory({ path: "Assets/Game" });
          for (const entry of gameEntries ?? []) {
            if (entry?.type === "dir" && isNonEmptyString(entry.name)) {
              assetsBuckets.push(`Assets/Game/${entry.name.trim()}`);
            }
          }
        } catch {
          // Best-effort; must not break plan application.
        }
      }
    } catch {
      // Best-effort; must not break plan application.
    }
  }

  const sharedCorePaths = new Set();
  for (const filename of ["package.json", "pnpm-lock.yaml", "pnpm-lock.yml"]) {
    if (rootFiles.has(filename)) {
      sharedCorePaths.add(filename);
    }
  }

  if (rootDirs.has("policy")) {
    try {
      const policyEntries = await githubClient.listRepoDirectory({ path: "policy" });
      const policyFiles = new Set(policyEntries.filter((e) => e?.type === "file").map((e) => e.name));
      for (const filename of ["transitions.json", "project-schema.json", "role-permissions.json"]) {
        if (policyFiles.has(filename)) {
          sharedCorePaths.add(`policy/${filename}`);
        }
      }
    } catch {
      // Defensive: policy scanning is best-effort; it must not break plan application.
    }
  }

  // Shared-core file buckets must take precedence over directory buckets.
  for (const shared of [...sharedCorePaths].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    buckets.unshift(shared);
  }
  for (const bucket of appsBuckets.sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    buckets.unshift(bucket);
  }
  for (const bucket of assetsBuckets.sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    buckets.unshift(bucket);
  }

  return {
    buckets: normalizeBuckets(buckets),
    shared_core_paths: sharedCorePaths,
  };
}

export function computeSprintPlanMetadata({ issues, buckets, sharedCorePaths }) {
  const entries = [];

  for (const issue of issues ?? []) {
    const issueNumber = issue?.issue_number;
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      continue;
    }

    const rawTouchPaths = Array.isArray(issue?.files_likely_touched) ? issue.files_likely_touched : [];
    const { touch_paths, owns_paths } = computeTouchAndOwnsPaths({
      rawTouchPaths,
      buckets,
      sharedCorePaths,
    });

    const isGoal = isSprintGoalIssue(issue);
    const group_id = isGoal
      ? "meta:sprint-goal"
      : determineGroupId({ ownsPaths: owns_paths, sharedCorePaths });

    entries.push({
      issue_number: issueNumber,
      title: isNonEmptyString(issue?.title) ? issue.title.trim() : "",
      priority: isNonEmptyString(issue?.priority) ? issue.priority.trim().toUpperCase() : "",
      plan_order: Number.isInteger(issue?.plan_order) && issue.plan_order >= 0 ? issue.plan_order : issueNumber,
      touch_paths,
      owns_paths: isGoal ? [] : owns_paths,
      group_id,
    });
  }

  // Compute conflicts based on owns_paths overlap.
  const metaByIssue = new Map();
  for (const entry of entries) {
    metaByIssue.set(entry.issue_number, {
      touch_paths: entry.touch_paths,
      owns_paths: entry.owns_paths,
      conflicts_with: [],
      depends_on: [],
      group_id: entry.group_id,
      isolation_mode: "ISOLATED",
    });
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const left = entries[i];
      const right = entries[j];
      let overlaps = false;
      for (const leftOwn of left.owns_paths) {
        for (const rightOwn of right.owns_paths) {
          if (pathsOverlap(leftOwn, rightOwn)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) {
          break;
        }
      }
      if (!overlaps) {
        continue;
      }

      metaByIssue.get(left.issue_number).conflicts_with.push(right.issue_number);
      metaByIssue.get(right.issue_number).conflicts_with.push(left.issue_number);
    }
  }

  for (const [issueNumber, meta] of metaByIssue.entries()) {
    meta.conflicts_with.sort((a, b) => a - b);
    const ownsSharedCore = meta.owns_paths.some((path) => sharedCorePaths.has(path));
    if (meta.conflicts_with.length > 0 || ownsSharedCore) {
      meta.isolation_mode = "CHAINED";
    }
    metaByIssue.set(issueNumber, meta);
  }

  // Sequence CHAINED items within each group_id deterministically (priority -> title -> issue_number).
  const chainedGroups = new Map();
  for (const entry of entries) {
    const meta = metaByIssue.get(entry.issue_number);
    if (meta.isolation_mode !== "CHAINED") {
      continue;
    }
    const group = meta.group_id;
    if (!chainedGroups.has(group)) {
      chainedGroups.set(group, []);
    }
    chainedGroups.get(group).push(entry);
  }

  for (const [groupId, groupEntries] of chainedGroups.entries()) {
    const sorted = groupEntries
      .slice()
      .sort(
        (left, right) =>
          priorityRank(left.priority) - priorityRank(right.priority) ||
          left.plan_order - right.plan_order ||
          left.title.localeCompare(right.title) ||
          left.issue_number - right.issue_number,
      );

    if (sorted.length <= 1) {
      continue;
    }

    for (let idx = 1; idx < sorted.length; idx += 1) {
      const current = sorted[idx];
      const previous = sorted[idx - 1];
      const currentMeta = metaByIssue.get(current.issue_number);
      currentMeta.depends_on = [previous.issue_number];
      metaByIssue.set(current.issue_number, currentMeta);
    }

    // Ensure all items in chained groups record deterministic conflicts_with ordering.
    for (const entry of sorted) {
      const currentMeta = metaByIssue.get(entry.issue_number);
      currentMeta.conflicts_with.sort((a, b) => a - b);
      metaByIssue.set(entry.issue_number, currentMeta);
    }
  }

  const sprintPlan = {};
  for (const [issueNumber, meta] of metaByIssue.entries()) {
    sprintPlan[String(issueNumber)] = meta;
  }

  // Ownership index: path -> first issue in each chained group (or itself for isolated).
  const ownershipIndex = {};
  const orderedIssues = entries
    .slice()
    .sort(
      (left, right) =>
        left.group_id.localeCompare(right.group_id) ||
        priorityRank(left.priority) - priorityRank(right.priority) ||
        left.plan_order - right.plan_order ||
        left.title.localeCompare(right.title) ||
        left.issue_number - right.issue_number,
    );

  for (const entry of orderedIssues) {
    const meta = metaByIssue.get(entry.issue_number);
    for (const pathPrefix of meta.owns_paths) {
      if (ownershipIndex[pathPrefix] === undefined) {
        ownershipIndex[pathPrefix] = entry.issue_number;
      }
    }
  }

  return { sprintPlan, ownershipIndex };
}

export function formatScopeSection({ meta, issueNumber }) {
  const touch = Array.isArray(meta?.touch_paths) ? meta.touch_paths : [];
  const owns = Array.isArray(meta?.owns_paths) ? meta.owns_paths : [];
  const conflicts = Array.isArray(meta?.conflicts_with) ? meta.conflicts_with : [];
  const depends = Array.isArray(meta?.depends_on) ? meta.depends_on : [];

  const fmtPaths = (paths) => (paths.length === 0 ? "- (none)" : paths.map((p) => `- \`${p}\``).join("\n"));
  const fmtIssues = (issues) => (issues.length === 0 ? "(none)" : issues.map((n) => `#${n}`).join(", "));

  return [
    "## Scope",
    "Allowed touch paths:",
    fmtPaths(touch),
    "Owned paths (exclusive writer):",
    fmtPaths(owns),
    `Isolation mode: ${meta?.isolation_mode ?? "ISOLATED"}`,
    `Group: ${meta?.group_id ?? "unknown"}`,
    `conflicts_with: ${fmtIssues(conflicts)}`,
    `depends_on: ${fmtIssues(depends)}`,
    "If you need to modify files outside Allowed touch paths, comment on this issue requesting scope expansion and list the paths.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
