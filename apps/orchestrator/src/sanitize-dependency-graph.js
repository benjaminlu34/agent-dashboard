/*
Plan + assumptions:
- In this repo, Backlog -> Ready promotion is performed by runner autopromotion using sprint scope metadata
  (`touch_paths`, `owns_paths`, `depends_on`, `isolation_mode`).
- This module stays pure and side-effect free so the promotion layer can sanitize dependency graphs before
  eligibility checks.
- `depends_on` is only used to sequence tasks that contend on `owns_paths`; pure ordering dependencies without
  ownership overlap are unsupported and intentionally pruned by rule `NO_OVERLAP`.
*/

const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

function normalizePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
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
  while (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function pathHasDocSignals(pathValue) {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (lower.includes("/docs/") || lower.startsWith("docs/") || lower.endsWith("/docs")) {
    return true;
  }

  for (const extension of DOC_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function isDocOnlyItem(item) {
  const touchPaths = Array.isArray(item?.touch_paths) ? item.touch_paths : [];
  if (touchPaths.length === 0) {
    return false;
  }
  return touchPaths.every((entry) => pathHasDocSignals(entry));
}

function pathsOverlap(leftPath, rightPath) {
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

function hasOwnsPrefixOverlap(leftOwns, rightOwns) {
  for (const left of leftOwns) {
    for (const right of rightOwns) {
      if (pathsOverlap(left, right)) {
        return true;
      }
    }
  }
  return false;
}

function buildCyclesByStronglyConnectedComponent(itemsByNumber) {
  const numbers = [...itemsByNumber.keys()].sort((left, right) => left - right);
  const indexByNumber = new Map();
  const lowLinkByNumber = new Map();
  const stack = [];
  const onStack = new Set();
  let nextIndex = 0;
  const components = [];

  function strongConnect(number) {
    indexByNumber.set(number, nextIndex);
    lowLinkByNumber.set(number, nextIndex);
    nextIndex += 1;
    stack.push(number);
    onStack.add(number);

    const item = itemsByNumber.get(number);
    const dependencies = Array.isArray(item?.depends_on) ? item.depends_on : [];
    for (const dependency of dependencies) {
      if (!itemsByNumber.has(dependency)) {
        continue;
      }
      if (!indexByNumber.has(dependency)) {
        strongConnect(dependency);
        lowLinkByNumber.set(number, Math.min(lowLinkByNumber.get(number), lowLinkByNumber.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLinkByNumber.set(number, Math.min(lowLinkByNumber.get(number), indexByNumber.get(dependency)));
      }
    }

    if (lowLinkByNumber.get(number) !== indexByNumber.get(number)) {
      return;
    }

    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      onStack.delete(current);
      component.push(current);
      if (current === number) {
        break;
      }
    }
    component.sort((left, right) => left - right);
    components.push(component);
  }

  for (const number of numbers) {
    if (!indexByNumber.has(number)) {
      strongConnect(number);
    }
  }

  const cycles = [];
  for (const component of components) {
    if (component.length > 1) {
      cycles.push(component);
      continue;
    }

    const [single] = component;
    const item = itemsByNumber.get(single);
    const deps = Array.isArray(item?.depends_on) ? item.depends_on : [];
    if (deps.includes(single)) {
      cycles.push(component);
    }
  }

  cycles.sort((left, right) => left[0] - right[0]);
  return cycles;
}

export function sanitizeDependencyGraph(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const report = {
    droppedEdges: [],
    cycles: null,
  };

  const byNumber = new Map();
  for (const item of safeItems) {
    if (!Number.isInteger(item?.number) || item.number <= 0) {
      continue;
    }
    byNumber.set(item.number, item);
  }

  const docOnlyByNumber = new Map();
  for (const item of safeItems) {
    if (!Number.isInteger(item?.number) || item.number <= 0) {
      continue;
    }
    docOnlyByNumber.set(item.number, isDocOnlyItem(item));
  }

  const sanitizedItems = safeItems.map((item) => {
    const currentNumber = item?.number;
    const dependsOn = Array.isArray(item?.depends_on) ? item.depends_on : [];
    const ownsPaths = Array.isArray(item?.owns_paths) ? item.owns_paths : [];

    const nextDependsOn = [];
    for (const dependency of dependsOn) {
      if (!Number.isInteger(dependency)) {
        report.droppedEdges.push({
          from: Number.isInteger(currentNumber) ? currentNumber : -1,
          to: dependency,
          reason: "DEAD_REF",
        });
        continue;
      }

      const dependencyItem = byNumber.get(dependency);
      if (!dependencyItem) {
        report.droppedEdges.push({
          from: Number.isInteger(currentNumber) ? currentNumber : -1,
          to: dependency,
          reason: "DEAD_REF",
        });
        continue;
      }

      const currentIsDocOnly = docOnlyByNumber.get(currentNumber) === true;
      const dependencyIsDocOnly = docOnlyByNumber.get(dependency) === true;
      if (dependencyIsDocOnly && !currentIsDocOnly) {
        report.droppedEdges.push({
          from: currentNumber,
          to: dependency,
          reason: "DOC_BLOCKER",
        });
        continue;
      }

      const dependencyOwnsPaths = Array.isArray(dependencyItem?.owns_paths) ? dependencyItem.owns_paths : [];
      if (ownsPaths.length > 0 && dependencyOwnsPaths.length > 0) {
        if (!hasOwnsPrefixOverlap(ownsPaths, dependencyOwnsPaths)) {
          report.droppedEdges.push({
            from: currentNumber,
            to: dependency,
            reason: "NO_OVERLAP",
          });
          continue;
        }
      }

      nextDependsOn.push(dependency);
    }

    return {
      ...item,
      depends_on: nextDependsOn,
    };
  });

  const sanitizedByNumber = new Map();
  for (const item of sanitizedItems) {
    if (!Number.isInteger(item?.number) || item.number <= 0) {
      continue;
    }
    sanitizedByNumber.set(item.number, item);
  }

  const cycles = buildCyclesByStronglyConnectedComponent(sanitizedByNumber);
  if (cycles.length > 0) {
    report.cycles = cycles;
    return {
      items: sanitizedItems,
      report,
      error: { cycles },
    };
  }

  return {
    items: sanitizedItems,
    report,
    error: null,
  };
}
