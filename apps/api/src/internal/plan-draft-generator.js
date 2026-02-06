const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const VALID_SIZES = new Set(["S", "M", "L"]);
const VALID_AREAS = new Set(["db", "api", "web", "providers", "infra", "docs"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2"]);
const VALID_INITIAL_STATUSES = new Set(["Backlog", "Ready"]);
const FORBIDDEN_MIGRATION_FILENAME_RE = /migrations\/\d+_.*\.(sql|ts)$/i;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureStringArray(value, fieldPath) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
    throw new PlanDraftGenerationError(`${fieldPath} must be an array of non-empty strings`);
  }
}

function goalExplicitlyDemandsMoreThanTen(goal) {
  if (!isNonEmptyString(goal)) {
    return false;
  }

  const normalized = goal.toLowerCase();
  if (/(more than|at least|minimum of)\s+1[1-9]/.test(normalized)) {
    return true;
  }
  if (/\b1[1-9]\+\b/.test(normalized)) {
    return true;
  }

  const numericTokens = normalized.match(/\b\d+\b/g) ?? [];
  return numericTokens.some((token) => Number.parseInt(token, 10) > 10);
}

function looksVagueCriterion(criterion) {
  return /\b(tbd|etc|and so on|as needed|somehow|appropriate|maybe)\b/i.test(criterion);
}

function looksLikeForbiddenMigrationFilename(entry) {
  return FORBIDDEN_MIGRATION_FILENAME_RE.test(entry);
}

function buildBundleContext(bundle) {
  const files = Array.isArray(bundle?.files) ? bundle.files : [];
  return files.map((file) => `FILE: ${file.path}\n${file.content}`).join("\n\n");
}

function extractOutputText(payload) {
  if (isNonEmptyString(payload?.output_text)) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textParts = [];

  for (const item of output) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const contentItem of contentItems) {
      if (isNonEmptyString(contentItem?.text)) {
        textParts.push(contentItem.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

function validateIssue(issue, index) {
  const issuePath = `issues[${index}]`;

  if (!issue || typeof issue !== "object") {
    throw new PlanDraftGenerationError(`${issuePath} must be an object`);
  }

  if (!isNonEmptyString(issue.title)) {
    throw new PlanDraftGenerationError(`${issuePath}.title must be a non-empty string`);
  }
  if (!isNonEmptyString(issue.goal)) {
    throw new PlanDraftGenerationError(`${issuePath}.goal must be a non-empty string`);
  }

  ensureStringArray(issue.non_goals, `${issuePath}.non_goals`);
  ensureStringArray(issue.acceptance_criteria, `${issuePath}.acceptance_criteria`);
  ensureStringArray(issue.files_likely_touched, `${issuePath}.files_likely_touched`);
  ensureStringArray(issue.definition_of_done, `${issuePath}.definition_of_done`);

  for (const criterion of issue.acceptance_criteria) {
    if (looksVagueCriterion(criterion)) {
      throw new PlanDraftGenerationError(`${issuePath}.acceptance_criteria contains a vague criterion`);
    }
  }

  for (const touchedEntry of issue.files_likely_touched) {
    if (looksLikeForbiddenMigrationFilename(touchedEntry)) {
      throw new PlanDraftGenerationError(
        `${issuePath}.files_likely_touched must not include exact migration filenames`,
      );
    }
  }

  if (!VALID_SIZES.has(issue.size)) {
    throw new PlanDraftGenerationError(`${issuePath}.size must be one of S, M, L`);
  }
  if (!VALID_AREAS.has(issue.area)) {
    throw new PlanDraftGenerationError(`${issuePath}.area must match policy enum`);
  }
  if (!VALID_PRIORITIES.has(issue.priority)) {
    throw new PlanDraftGenerationError(`${issuePath}.priority must match policy enum`);
  }
  if (!VALID_INITIAL_STATUSES.has(issue.initial_status)) {
    throw new PlanDraftGenerationError(`${issuePath}.initial_status must be Backlog or Ready`);
  }
}

function validateDraftShape(draft, requestedSprint, goal) {
  if (!draft || typeof draft !== "object") {
    throw new PlanDraftGenerationError("model output must be a JSON object");
  }

  if (draft.sprint !== requestedSprint) {
    throw new PlanDraftGenerationError("model output sprint must match request sprint");
  }

  if (!Array.isArray(draft.issues)) {
    throw new PlanDraftGenerationError("model output issues must be an array");
  }

  if (draft.issues.length > 10 && !goalExplicitlyDemandsMoreThanTen(goal)) {
    throw new PlanDraftGenerationError("model output includes more than 10 issues without explicit goal request");
  }

  draft.issues.forEach((issue, index) => validateIssue(issue, index));
  return draft;
}

function buildSystemInstruction() {
  return [
    "You are a planning assistant for software sprint execution.",
    "Return valid JSON only. Do not include markdown or prose.",
    "Return exactly one JSON object with keys: sprint, issues.",
    "Each issue must include keys:",
    "title, goal, non_goals, acceptance_criteria, files_likely_touched, definition_of_done, size, area, priority, initial_status.",
    "files_likely_touched must list directories or high-level components only.",
    "Do not prescribe exact filenames for new artifacts, especially migration filenames.",
    "acceptance_criteria must be concrete and verifiable; avoid vague criteria.",
    "size must be one of S,M,L.",
    "area must be one of db,api,web,providers,infra,docs.",
    "priority must be one of P0,P1,P2.",
    "initial_status must be one of Backlog,Ready.",
    "sprint must exactly match the requested sprint.",
    "Generate at most 10 issues unless the goal explicitly asks for more.",
  ].join(" ");
}

function buildUserPrompt({ sprint, goal, bundle }) {
  return [
    `Requested sprint: ${sprint}`,
    `Sprint goal: ${goal}`,
    "Context bundle follows. Use it to align file paths and scope:",
    buildBundleContext(bundle),
  ].join("\n\n");
}

export class PlanDraftGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlanDraftGenerationError";
  }
}

export async function generatePlanDraft({
  sprint,
  goal,
  bundle,
  fetchImpl = fetch,
  endpoint = OPENAI_RESPONSES_ENDPOINT,
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_MODEL ?? "gpt-5-mini",
  maxTokens = 1400,
  temperature = 0.1,
} = {}) {
  if (!isNonEmptyString(apiKey)) {
    throw new PlanDraftGenerationError("missing OPENAI_API_KEY for plan drafting");
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature,
      max_output_tokens: maxTokens,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildSystemInstruction() }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: buildUserPrompt({ sprint, goal, bundle }) }],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new PlanDraftGenerationError(`model request failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);
  if (!isNonEmptyString(outputText)) {
    throw new PlanDraftGenerationError("model output was empty");
  }

  let draft;
  try {
    draft = JSON.parse(outputText);
  } catch {
    throw new PlanDraftGenerationError("model output was not valid JSON");
  }

  return validateDraftShape(draft, sprint, goal);
}
