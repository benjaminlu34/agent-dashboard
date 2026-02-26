const HEADING_TO_KEY = new Map([
  ["goal", "goal"],
  ["non goals", "non_goals"],
  ["non goal", "non_goals"],
  ["acceptance criteria", "acceptance_criteria"],
  ["files likely touched", "files_likely_touched"],
  ["definition of done", "definition_of_done"],
]);

function normalizeHeadingToken(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/:+$/, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseIssueTaskBrief(issueBody) {
  const markdown = typeof issueBody === "string" ? issueBody : "";
  const lines = markdown.split(/\r?\n/u);
  const sections = new Map();
  let activeKey = null;

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/u);
    if (headingMatch) {
      const normalizedHeading = normalizeHeadingToken(headingMatch[1]);
      activeKey = HEADING_TO_KEY.get(normalizedHeading) ?? null;
      if (activeKey && !sections.has(activeKey)) {
        sections.set(activeKey, []);
      }
      continue;
    }

    if (!activeKey) {
      continue;
    }

    sections.get(activeKey).push(line);
  }

  const structured = {};
  for (const [key, capturedLines] of sections.entries()) {
    const value = capturedLines.join("\n").trim();
    if (value.length > 0) {
      structured[key] = value;
    }
  }

  if (Object.keys(structured).length > 0) {
    return structured;
  }

  return {
    raw_description: markdown.trim(),
  };
}
