import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerInternalPlanApplyRoute } from "../src/routes/internal-plan-apply.js";
import { createGitHubPlanApplyClient } from "../src/internal/github-plan-apply-client.js";

function buildReply() {
  return {
    statusCode: 200,
    code(nextStatus) {
      this.statusCode = nextStatus;
      return this;
    },
  };
}

function buildApp() {
  return {
    routePath: null,
    handler: null,
    post(path, handler) {
      this.routePath = path;
      this.handler = handler;
    },
  };
}

function buildPreflightPass() {
  return async () => ({
    role: "ORCHESTRATOR",
    bundle_hash: "bundle-hash",
    template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 10, sha256: "abc" },
    project_schema: { status: "PASS", mismatches: [] },
    status: "PASS",
    errors: [],
  });
}

async function writeBundleFiles(repoRoot) {
  await mkdir(join(repoRoot, "agents"), { recursive: true });
  await mkdir(join(repoRoot, "policy"), { recursive: true });
  await writeFile(join(repoRoot, "AGENTS.md"), "root governance\n", "utf8");
  await writeFile(join(repoRoot, "agents/ORCHESTRATOR.md"), "orchestrator overlay\n", "utf8");
  await writeFile(
    join(repoRoot, "policy/github-project.json"),
    '{"owner_login":"benjaminlu34","owner_type":"user","project_name":"Codex Task Board","repository_name":"agent-dashboard"}\n',
    "utf8",
  );
  await writeFile(
    join(repoRoot, "policy/project-schema.json"),
    JSON.stringify(
      {
        project_name: "Codex Task Board",
        required_fields: [
          {
            name: "Status",
            type: "single_select",
            allowed_options: ["Backlog", "Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked", "Done"],
          },
          { name: "Size", type: "single_select", allowed_options: ["S", "M", "L"] },
          { name: "Area", type: "single_select", allowed_options: ["db", "api", "web", "providers", "infra", "docs"] },
          { name: "Priority", type: "single_select", allowed_options: ["P0", "P1", "P2"] },
          { name: "Sprint", type: "text" },
          { name: "DependsOn", type: "text" },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(join(repoRoot, "policy/transitions.json"), '{"transitions":[]}\n', "utf8");
  await writeFile(join(repoRoot, "policy/role-permissions.json"), '{"Orchestrator":{"can_create_issues":true}}\n', "utf8");
}

test("POST /internal/plan-apply provisions project fields via batched GraphQL mutations and freezes orchestrator state when require_verification=true", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-pass-"));
  await writeBundleFiles(repoRoot);

  const graphqlCalls = [];
  const graphqlEndpoint = "https://example.test/graphql";
  const restEndpoint = "https://example.test/rest";
  let issueCounter = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    const payload = typeof options.body === "string" ? JSON.parse(options.body) : null;

    if (href === graphqlEndpoint) {
      graphqlCalls.push(payload);

      const query = typeof payload?.query === "string" ? payload.query : "";

      if (query.includes("projectsV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                user: {
                  repository: {
                    id: "R_repo",
                    labels: {
                      nodes: [
                        { id: "L_meta_sprint_goal", name: "meta:sprint-goal" },
                        { id: "L_meta_runner", name: "meta:runner" },
                      ],
                    },
                  },
                  projectsV2: {
                    nodes: [
                      {
                        id: "PVT_project",
                        number: 1,
                        title: "Codex Task Board",
                        fields: {
                          nodes: [
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_status",
                              name: "Status",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_backlog", name: "Backlog" },
                                { id: "opt_ready", name: "Ready" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_size",
                              name: "Size",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_s", name: "S" },
                                { id: "opt_m", name: "M" },
                                { id: "opt_l", name: "L" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_area",
                              name: "Area",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_api", name: "api" },
                                { id: "opt_docs", name: "docs" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_priority",
                              name: "Priority",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_p0", name: "P0" },
                                { id: "opt_p1", name: "P1" },
                                { id: "opt_p2", name: "P2" },
                              ],
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_sprint",
                              name: "Sprint",
                              dataType: "TEXT",
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_depends",
                              name: "DependsOn",
                              dataType: "TEXT",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("createIssue")) {
        issueCounter += 1;
        const number = 100 + issueCounter;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                createIssue: {
                  issue: {
                    id: `I_kw_test_${number}`,
                    number,
                    url: `https://github.com/benjaminlu34/agent-dashboard/issues/${number}`,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("addProjectV2ItemById")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                addProjectV2ItemById: {
                  item: {
                    id: `PVTI_test_${issueCounter}`,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("updateProjectV2ItemFieldValue")) {
        const data = {};
        for (const key of Object.keys(payload?.variables ?? {})) {
          if (!key.startsWith("fieldId")) {
            continue;
          }
          const suffix = key.slice("fieldId".length);
          data[`f${suffix}`] = { projectV2Item: { id: "PVTI_updated" } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data };
          },
        };
      }

      throw new Error(`unexpected GraphQL request: ${query}`);
    }

    if (href.startsWith(restEndpoint)) {
      if (method === "PATCH" && href.includes("/issues/")) {
        const match = href.match(/\/issues\/(\d+)$/u);
        const issueNumber = match ? Number(match[1]) : 0;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              number: issueNumber,
              html_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${issueNumber}`,
              node_id: `I_kw_rest_${issueNumber}`,
            };
          },
        };
      }
      throw new Error(`unexpected REST request: ${method} ${href}`);
    }

    throw new Error(`unexpected fetch url: ${href}`);
  };

  const githubClientFactory = async ({ repoRoot: root, projectIdentity }) => {
    const client = await createGitHubPlanApplyClient({
      repoRoot: root,
      projectIdentity,
      githubToken: "test-token",
      graphqlEndpoint,
      restEndpoint,
    });

    return {
      ...client,
      async listRepoDirectory() {
        throw new Error("repo scan disabled for test");
      },
    };
  };

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  let result;
  try {
    result = await app.handler(
      {
        body: {
          role: "ORCHESTRATOR",
          draft: {
            sprint: "M1",
            require_verification: true,
            issues: [
              {
                title: "Build runner lifecycle persistence",
                goal: "Persist run metadata for observability.",
                non_goals: ["No UI pages"],
                acceptance_criteria: ["When run succeeds, metadata row exists in storage."],
                files_likely_touched: ["apps/api/src/routes/", "packages/db/migrations/"],
                definition_of_done: ["Tests cover success and error flows."],
                size: "M",
                area: "api",
                priority: "P1",
                depends_on: [42, "Bootstrap infra"],
              },
            ],
          },
        },
      },
      reply,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(app.routePath, "/internal/plan-apply");
  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");

  const createIssueCall = graphqlCalls.find((entry) => typeof entry?.query === "string" && entry.query.includes("createIssue"));
  assert.equal(createIssueCall?.variables?.title, "[TASK] Build runner lifecycle persistence");

  const createdBody = createIssueCall?.variables?.body ?? "";
  assert.match(createdBody, /^## Goal$/m);
  assert.match(createdBody, /^## Non-goals$/m);
  assert.match(createdBody, /^## Acceptance Criteria$/m);
  assert.match(createdBody, /^## Files Likely Touched$/m);
  assert.match(createdBody, /^## Definition of Done$/m);
  assert.match(createdBody, /^## Size$/m);
  assert.match(createdBody, /^- \[ \] When run succeeds, metadata row exists in storage\.$/m);
  assert.match(createdBody, /^- \[ \] Tests cover success and error flows\.$/m);

  const updateCalls = graphqlCalls.filter(
    (entry) => typeof entry?.query === "string" && entry.query.includes("updateProjectV2ItemFieldValue"),
  );
  assert.equal(updateCalls.length, 1);

  const updateCall = updateCalls[0];
  assert.match(updateCall.query, /\bf0:\s*updateProjectV2ItemFieldValue/gu);
  assert.ok((updateCall.query.match(/updateProjectV2ItemFieldValue/gu) ?? []).length > 1);

  const updateVars = updateCall?.variables ?? {};
  const suffixes = Object.keys(updateVars)
    .filter((key) => key.startsWith("fieldId"))
    .map((key) => key.slice("fieldId".length));

  const sprintSuffix = suffixes.find((suffix) => updateVars[`fieldId${suffix}`] === "field_sprint");
  assert.equal(updateVars[`textValue${sprintSuffix}`], "M1");

  const dependsSuffix = suffixes.find((suffix) => updateVars[`fieldId${suffix}`] === "field_depends");
  assert.equal(updateVars[`textValue${dependsSuffix}`], "42, Bootstrap infra");

  const statePath = join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.sprint_phase, "PENDING_VERIFICATION");

  await assert.rejects(readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8"), /ENOENT/);
});

test("POST /internal/plan-apply auto-seals runner caches when require_verification=false", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-auto-seal-"));
  await writeBundleFiles(repoRoot);

  const graphqlCalls = [];
  const graphqlEndpoint = "https://example.test/graphql";
  const restEndpoint = "https://example.test/rest";
  const planVersion = "2026-02-28T12:00:00.000Z";
  let issueCounter = 0;
  const createdIssues = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    const payload = typeof options.body === "string" ? JSON.parse(options.body) : null;

    if (href === graphqlEndpoint) {
      graphqlCalls.push(payload);
      const query = typeof payload?.query === "string" ? payload.query : "";

      if (query.includes("projectsV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                user: {
                  repository: {
                    id: "R_repo",
                    labels: { nodes: [] },
                  },
                  projectsV2: {
                    nodes: [
                      {
                        id: "PVT_project",
                        number: 1,
                        title: "Codex Task Board",
                        fields: {
                          nodes: [
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_status",
                              name: "Status",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_backlog", name: "Backlog" },
                                { id: "opt_ready", name: "Ready" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_size",
                              name: "Size",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_s", name: "S" },
                                { id: "opt_m", name: "M" },
                                { id: "opt_l", name: "L" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_area",
                              name: "Area",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_api", name: "api" },
                                { id: "opt_docs", name: "docs" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_priority",
                              name: "Priority",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_p0", name: "P0" },
                                { id: "opt_p1", name: "P1" },
                                { id: "opt_p2", name: "P2" },
                              ],
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_sprint",
                              name: "Sprint",
                              dataType: "TEXT",
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_depends",
                              name: "DependsOn",
                              dataType: "TEXT",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("createIssue")) {
        issueCounter += 1;
        const number = 900 + issueCounter;
        createdIssues.push({
          number,
          title: payload?.variables?.title ?? "",
          url: `https://github.com/benjaminlu34/agent-dashboard/issues/${number}`,
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                createIssue: {
                  issue: {
                    id: `I_kw_test_${number}`,
                    number,
                    url: `https://github.com/benjaminlu34/agent-dashboard/issues/${number}`,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("addProjectV2ItemById")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                addProjectV2ItemById: {
                  item: {
                    id: `PVTI_test_${issueCounter}`,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("updateProjectV2ItemFieldValue")) {
        const data = {};
        for (const key of Object.keys(payload?.variables ?? {})) {
          if (!key.startsWith("fieldId")) {
            continue;
          }
          const suffix = key.slice("fieldId".length);
          data[`f${suffix}`] = { projectV2Item: { id: "PVTI_updated" } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data };
          },
        };
      }

      if (query.includes("items(first: 100") && query.includes("... on ProjectV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                node: {
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: createdIssues.map((issue, index) => ({
                      id: `PVTI_test_${index + 1}`,
                      content: {
                        number: issue.number,
                        title: issue.title,
                        url: issue.url,
                        repository: {
                          name: "agent-dashboard",
                          owner: { login: "benjaminlu34" },
                        },
                      },
                      fieldValues: {
                        nodes: [
                          {
                            text: "M1",
                            field: { name: "Sprint" },
                          },
                          {
                            text: "",
                            field: { name: "DependsOn" },
                          },
                          {
                            name: "P1",
                            field: { name: "Priority" },
                          },
                        ],
                      },
                    })),
                  },
                },
              },
            };
          },
        };
      }

      throw new Error(`unexpected GraphQL request: ${query}`);
    }

    if (href.startsWith(restEndpoint)) {
      if (method === "PATCH" && href.includes("/issues/")) {
        const match = href.match(/\/issues\/(\d+)$/u);
        const issueNumber = match ? Number(match[1]) : 0;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              number: issueNumber,
              html_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${issueNumber}`,
              node_id: `I_kw_rest_${issueNumber}`,
            };
          },
        };
      }
      throw new Error(`unexpected REST request: ${method} ${href}`);
    }

    throw new Error(`unexpected fetch url: ${href}`);
  };

  const githubClientFactory = async ({ repoRoot: root, projectIdentity }) => {
    const client = await createGitHubPlanApplyClient({
      repoRoot: root,
      projectIdentity,
      githubToken: "test-token",
      graphqlEndpoint,
      restEndpoint,
    });

    return {
      ...client,
      async listRepoDirectory() {
        throw new Error("repo scan disabled for test");
      },
    };
  };

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
    nowIso: () => planVersion,
  });

  const reply = buildReply();
  let result;
  try {
    result = await app.handler(
      {
        body: {
          role: "ORCHESTRATOR",
          draft: {
            sprint: "M1",
            require_verification: false,
            issues: [
              {
                title: "Auto seal test",
                goal: "Ensure autonomous kickoff seals immediately.",
                non_goals: ["No manual GitHub edits"],
                acceptance_criteria: ["Runner caches are created in one request."],
                files_likely_touched: ["apps/api/src/routes/internal-plan-apply.js"],
                definition_of_done: ["Sealed plan_version is written."],
                size: "S",
                area: "api",
                priority: "P1",
                initial_status: "Backlog",
              },
            ],
          },
        },
      },
      reply,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");

  const statePath = join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.sprint_phase, "ACTIVE");
  assert.equal(state.sealed_at, planVersion);

  const planRaw = await readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8");
  const plan = JSON.parse(planRaw);
  assert.equal(plan.plan_version, planVersion);
  assert.equal(plan.sprint, "M1");
  assert.equal(Array.isArray(plan.tasks), true);

  const ledgerRaw = await readFile(join(repoRoot, ".runner-ledger.benjaminlu34.agent-dashboard.json"), "utf8");
  const ledger = JSON.parse(ledgerRaw);
  assert.equal(ledger.plan_version, planVersion);
  assert.deepEqual(ledger.runs, {});
});

test("POST /internal/plan-apply resolves title depends_on entries into issue numbers before auto-seal", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-auto-seal-depends-on-"));
  await writeBundleFiles(repoRoot);

  const graphqlCalls = [];
  const graphqlEndpoint = "https://example.test/graphql";
  const restEndpoint = "https://example.test/rest";
  const planVersion = "2026-02-28T12:00:00.000Z";
  let issueCounter = 0;
  const createdIssues = [];
  const dependsByProjectItemId = new Map();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = typeof options.method === "string" ? options.method.toUpperCase() : "GET";
    const payload = typeof options.body === "string" ? JSON.parse(options.body) : null;

    if (href === graphqlEndpoint) {
      graphqlCalls.push(payload);
      const query = typeof payload?.query === "string" ? payload.query : "";

      if (query.includes("projectsV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                user: {
                  repository: {
                    id: "R_repo",
                    labels: { nodes: [] },
                  },
                  projectsV2: {
                    nodes: [
                      {
                        id: "PVT_project",
                        number: 1,
                        title: "Codex Task Board",
                        fields: {
                          nodes: [
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_status",
                              name: "Status",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_backlog", name: "Backlog" },
                                { id: "opt_ready", name: "Ready" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_size",
                              name: "Size",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_s", name: "S" },
                                { id: "opt_m", name: "M" },
                                { id: "opt_l", name: "L" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_area",
                              name: "Area",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_api", name: "api" },
                                { id: "opt_docs", name: "docs" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_priority",
                              name: "Priority",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_p0", name: "P0" },
                                { id: "opt_p1", name: "P1" },
                                { id: "opt_p2", name: "P2" },
                              ],
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_sprint",
                              name: "Sprint",
                              dataType: "TEXT",
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_depends",
                              name: "DependsOn",
                              dataType: "TEXT",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("createIssue")) {
        issueCounter += 1;
        const number = 900 + issueCounter;
        createdIssues.push({
          number,
          title: payload?.variables?.title ?? "",
          url: `https://github.com/benjaminlu34/agent-dashboard/issues/${number}`,
        });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                createIssue: {
                  issue: {
                    id: `I_kw_test_${number}`,
                    number,
                    url: `https://github.com/benjaminlu34/agent-dashboard/issues/${number}`,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("addProjectV2ItemById")) {
        const projectItemId = `PVTI_test_${issueCounter}`;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                addProjectV2ItemById: {
                  item: {
                    id: projectItemId,
                  },
                },
              },
            };
          },
        };
      }

      if (query.includes("updateProjectV2ItemFieldValue")) {
        const vars = payload?.variables ?? {};
        const itemId = vars.itemId;
        if (typeof itemId === "string" && itemId) {
          if (typeof vars.fieldId === "string" && vars.fieldId === "field_depends" && typeof vars.textValue === "string") {
            dependsByProjectItemId.set(itemId, vars.textValue);
          }

          for (const key of Object.keys(vars)) {
            if (!key.startsWith("fieldId")) {
              continue;
            }
            const suffix = key.slice("fieldId".length);
            if (vars[key] !== "field_depends") {
              continue;
            }
            const textKey = `textValue${suffix}`;
            if (typeof vars[textKey] === "string") {
              dependsByProjectItemId.set(itemId, vars[textKey]);
            }
          }
        }

        const data = {};
        for (const key of Object.keys(vars)) {
          if (!key.startsWith("fieldId")) {
            continue;
          }
          const suffix = key.slice("fieldId".length);
          data[`f${suffix}`] = { projectV2Item: { id: "PVTI_updated" } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { data };
          },
        };
      }

      if (query.includes("items(first: 100") && query.includes("... on ProjectV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                node: {
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: createdIssues.map((issue, index) => {
                      const projectItemId = `PVTI_test_${index + 1}`;
                      const dependsValue = dependsByProjectItemId.get(projectItemId) ?? "";
                      return {
                        id: projectItemId,
                        content: {
                          number: issue.number,
                          title: issue.title,
                          url: issue.url,
                          repository: {
                            name: "agent-dashboard",
                            owner: { login: "benjaminlu34" },
                          },
                        },
                        fieldValues: {
                          nodes: [
                            {
                              text: "M1",
                              field: { name: "Sprint" },
                            },
                            {
                              text: dependsValue,
                              field: { name: "DependsOn" },
                            },
                            {
                              name: "P1",
                              field: { name: "Priority" },
                            },
                          ],
                        },
                      };
                    }),
                  },
                },
              },
            };
          },
        };
      }

      throw new Error(`unexpected GraphQL request: ${query}`);
    }

    if (href.startsWith(restEndpoint)) {
      if (method === "PATCH" && href.includes("/issues/")) {
        const match = href.match(/\/issues\/(\d+)$/u);
        const issueNumber = match ? Number(match[1]) : 0;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              number: issueNumber,
              html_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${issueNumber}`,
              node_id: `I_kw_rest_${issueNumber}`,
            };
          },
        };
      }
      throw new Error(`unexpected REST request: ${method} ${href}`);
    }

    throw new Error(`unexpected fetch url: ${href}`);
  };

  const githubClientFactory = async ({ repoRoot: root, projectIdentity }) => {
    const client = await createGitHubPlanApplyClient({
      repoRoot: root,
      projectIdentity,
      githubToken: "test-token",
      graphqlEndpoint,
      restEndpoint,
    });

    return {
      ...client,
      async listRepoDirectory() {
        throw new Error("repo scan disabled for test");
      },
    };
  };

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
    nowIso: () => planVersion,
  });

  const reply = buildReply();
  let result;
  try {
    result = await app.handler(
      {
        body: {
          role: "ORCHESTRATOR",
          draft: {
            sprint: "M1",
            require_verification: false,
            issues: [
              {
                title: "[TASK] Base task",
                goal: "Base goal.",
                non_goals: ["None"],
                acceptance_criteria: ["Done"],
                files_likely_touched: ["apps/api/src/routes/internal-plan-apply.js"],
                definition_of_done: ["Sealed."],
                size: "S",
                area: "api",
                priority: "P1",
                initial_status: "Backlog",
              },
              {
                title: "[TASK] Dependent task",
                goal: "Dependent goal.",
                non_goals: ["None"],
                acceptance_criteria: ["Done"],
                files_likely_touched: ["apps/api/src/routes/internal-plan-apply.js"],
                definition_of_done: ["Sealed."],
                size: "S",
                area: "api",
                priority: "P1",
                initial_status: "Backlog",
                depends_on: ["[TASK] Base task"],
              },
            ],
          },
        },
      },
      reply,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");

  const updateCalls = graphqlCalls.filter(
    (entry) => typeof entry?.query === "string" && entry.query.includes("updateProjectV2ItemFieldValue"),
  );
  const dependsOnUpdates = updateCalls.filter((entry) => {
    const vars = entry?.variables ?? {};
    if (typeof vars.fieldId === "string") {
      return vars.fieldId === "field_depends";
    }
    return Object.keys(vars).some((key) => key.startsWith("fieldId") && vars[key] === "field_depends");
  });
  assert.ok(dependsOnUpdates.length >= 1);

  const dependentIssueNumber = createdIssues.find((issue) => issue.title === "[TASK] Dependent task")?.number;
  const baseIssueNumber = createdIssues.find((issue) => issue.title === "[TASK] Base task")?.number;
  assert.ok(Number.isInteger(dependentIssueNumber));
  assert.ok(Number.isInteger(baseIssueNumber));

  const planRaw = await readFile(join(repoRoot, ".runner-sprint-plan.json"), "utf8");
  const plan = JSON.parse(planRaw);
  const dependentTask = plan.tasks.find((task) => task.issue_number === dependentIssueNumber);
  const baseTask = plan.tasks.find((task) => task.issue_number === baseIssueNumber);
  assert.ok(dependentTask);
  assert.ok(baseTask);
  assert.deepEqual(dependentTask.depends_on, [baseTask.project_item_id]);
});

test("POST /internal/plan-apply returns PARTIAL_FAIL shape when a later issue fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-partial-fail-"));
  await writeBundleFiles(repoRoot);

  let issueCounter = 0;
  const githubClientFactory = async () => ({
    async listRepoDirectory({ path }) {
      if (!path) {
        return [
          { name: "apps", type: "dir" },
          { name: "policy", type: "dir" },
          { name: "docs", type: "dir" },
          { name: "agents", type: "dir" },
          { name: "package.json", type: "file" },
        ];
      }
      if (path === "apps") {
        return [{ name: "api", type: "dir" }];
      }
      if (path === "policy") {
        return [{ name: "transitions.json", type: "file" }];
      }
      return [];
    },
    async createIssue() {
      issueCounter += 1;
      return {
        issue_number: 200 + issueCounter,
        issue_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${200 + issueCounter}`,
        issue_node_id: `I_kw_test_${200 + issueCounter}`,
      };
    },
    async addIssueToProject({ issueNodeId }) {
      if (issueNodeId === "I_kw_test_202") {
        throw new Error("project add failed");
      }
      return { project_item_id: `PVTI_${issueNodeId}` };
    },
    async setProjectFields() {},
    async updateIssue() {},
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "ORCHESTRATOR",
        draft: {
          sprint: "M2",
          require_verification: true,
          issues: [
            {
              title: "Issue one",
              goal: "Goal one",
              non_goals: ["Non-goal one"],
              acceptance_criteria: ["AC one"],
              files_likely_touched: ["apps/api/src/routes/"],
              definition_of_done: ["DoD one"],
              size: "S",
              area: "api",
              priority: "P2",
              initial_status: "Ready",
            },
            {
              title: "Issue two",
              goal: "Goal two",
              non_goals: ["Non-goal two"],
              acceptance_criteria: ["AC two"],
              files_likely_touched: ["packages/domain/src/"],
              definition_of_done: ["DoD two"],
              size: "M",
              area: "web",
              priority: "P1",
              initial_status: "Backlog",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 502);
  assert.equal(result.status, "PARTIAL_FAIL");
  assert.equal(Array.isArray(result.created), true);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.created[0], {
    index: 0,
    issue_number: 201,
    issue_url: "https://github.com/benjaminlu34/agent-dashboard/issues/201",
    project_item_id: "PVTI_I_kw_test_201",
    fields_set: {
      Status: "Ready",
      Size: "S",
      Area: "api",
      Priority: "P2",
      Sprint: "M2",
      DependsOn: "",
    },
  });
  assert.deepEqual(result.failed, {
    index: 1,
    step: "add_to_project",
    error: "project add failed",
  });
});

test("POST /internal/plan-apply returns 409 with preflight payload when preflight fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-preflight-fail-"));
  await writeBundleFiles(repoRoot);

  let githubClientFactoryCalled = false;
  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: async () => ({
      role: "ORCHESTRATOR",
      bundle_hash: "bundle-hash",
      template: { path: ".github/ISSUE_TEMPLATE/milestone-task.yml", size_bytes: 0, sha256: "" },
      project_schema: { status: "FAIL", mismatches: [] },
      status: "FAIL",
      errors: [{ source: "project_schema", message: "drift detected" }],
    }),
    githubClientFactory: async () => {
      githubClientFactoryCalled = true;
      return {};
    },
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "ORCHESTRATOR",
        draft: {
          sprint: "M1",
          issues: [
            {
              title: "Issue one",
              goal: "Goal one",
              non_goals: ["Non-goal one"],
              acceptance_criteria: ["AC one"],
              files_likely_touched: ["apps/api/src/routes/"],
              definition_of_done: ["DoD one"],
              size: "S",
              area: "api",
              priority: "P2",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 409);
  assert.equal(result.status, "FAIL");
  assert.equal(result.errors[0].source, "project_schema");
  assert.equal(githubClientFactoryCalled, false);
});

test("POST /internal/plan-apply rejects legacy PLANNER role", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-legacy-planner-"));
  await writeBundleFiles(repoRoot);

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory: async () => ({}),
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "PLANNER",
        draft: {
          sprint: "M1",
          issues: [],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 400);
  assert.deepEqual(result, { error: "body.role must be ORCHESTRATOR" });
});

test("POST /internal/plan-apply preserves bracket-prefixed titles and passes labels when provided", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-labels-"));
  await writeBundleFiles(repoRoot);

  const createdIssues = [];
  const githubClientFactory = async () => ({
    async listRepoDirectory({ path }) {
      if (!path) {
        return [
          { name: "apps", type: "dir" },
          { name: "policy", type: "dir" },
          { name: "docs", type: "dir" },
          { name: "agents", type: "dir" },
          { name: "package.json", type: "file" },
        ];
      }
      if (path === "apps") {
        return [
          { name: "api", type: "dir" },
          { name: "runner", type: "dir" },
        ];
      }
      if (path === "policy") {
        return [{ name: "transitions.json", type: "file" }];
      }
      return [];
    },
    async createIssue({ title, labels }) {
      createdIssues.push({ title, labels });
      return {
        issue_number: 501 + createdIssues.length,
        issue_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${501 + createdIssues.length}`,
        issue_node_id: `I_kw_test_${501 + createdIssues.length}`,
      };
    },
    async addIssueToProject() {
      return { project_item_id: `PVTI_test_${createdIssues.length}` };
    },
    async setProjectFields() {},
    async updateIssue() {},
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "ORCHESTRATOR",
        draft: {
          sprint: "M1",
          require_verification: true,
          issues: [
            {
              title: "[SPRINT GOAL] M1: Ship kickoff",
              goal: "Define Sprint M1 scope and success criteria.",
              non_goals: ["No major refactors"],
              acceptance_criteria: ["Goal issue exists and is labeled meta:sprint-goal."],
              files_likely_touched: ["docs/"],
              definition_of_done: ["Kickoff artifacts are created and visible in project."],
              size: "S",
              area: "docs",
              priority: "P0",
              labels: ["meta:sprint-goal"],
            },
            {
              title: "[TASK] Implement kickoff validator",
              goal: "Validate kickoff JSON output schema.",
              non_goals: ["No new dependencies"],
              acceptance_criteria: ["Invalid kickoff JSON fails closed."],
              files_likely_touched: ["apps/runner/"],
              definition_of_done: ["Unit tests cover invalid shapes."],
              size: "S",
              area: "infra",
              priority: "P0",
              initial_status: "Backlog",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");
  assert.equal(createdIssues.length, 2);
  assert.equal(createdIssues[0].title, "[SPRINT GOAL] M1: Ship kickoff");
  assert.deepEqual(createdIssues[0].labels, ["meta:sprint-goal"]);
  assert.equal(createdIssues[1].title, "[TASK] Implement kickoff validator");
});

test("POST /internal/plan-apply writes orchestrator state to repo-scoped path by default", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-state-scoped-"));
  await writeBundleFiles(repoRoot);

  const scopedPath = join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json");
  const defaultPath = join(repoRoot, ".orchestrator-state.json");
  await writeFile(
    scopedPath,
    JSON.stringify(
      {
        poll_count: 9,
        items: {
          existing: { last_seen_status: "Backlog" },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  let issueCounter = 0;
  const githubClientFactory = async () => ({
    async createIssue() {
      issueCounter += 1;
      return {
        issue_number: 700 + issueCounter,
        issue_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${700 + issueCounter}`,
        issue_node_id: `I_kw_test_${700 + issueCounter}`,
      };
    },
    async addIssueToProject() {
      return { project_item_id: `PVTI_test_${issueCounter}` };
    },
    async setProjectFields() {},
    async updateIssue() {},
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {},
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "ORCHESTRATOR",
        draft: {
          sprint: "M1",
          require_verification: true,
          issues: [
            {
              title: "Scoped state write test",
              goal: "Ensure plan metadata writes to scoped state file.",
              non_goals: ["No external integrations"],
              acceptance_criteria: ["Plan apply completes successfully."],
              files_likely_touched: ["apps/api/src/routes/internal-plan-apply.js"],
              definition_of_done: ["State file includes sprint_plan metadata."],
              size: "S",
              area: "api",
              priority: "P1",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");
  const scopedState = JSON.parse(await readFile(scopedPath, "utf8"));
  assert.equal(scopedState.poll_count, 9);
  assert.deepEqual(scopedState.items, {
    existing: { last_seen_status: "Backlog" },
  });
  assert.equal(scopedState.sprint_phase, "PENDING_VERIFICATION");
  assert.equal(typeof scopedState.sprint_plan, "object");
  assert.equal(Object.keys(scopedState.sprint_plan).length, 1);
  await assert.rejects(readFile(defaultPath, "utf8"), /ENOENT/);
});

test("POST /internal/plan-apply respects ORCHESTRATOR_STATE_PATH override", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-state-override-"));
  await writeBundleFiles(repoRoot);

  const customPath = join(repoRoot, "tmp", "custom-orchestrator.json");
  const scopedPath = join(repoRoot, ".orchestrator-state.benjaminlu34.agent-dashboard.json");

  let issueCounter = 0;
  const githubClientFactory = async () => ({
    async createIssue() {
      issueCounter += 1;
      return {
        issue_number: 800 + issueCounter,
        issue_url: `https://github.com/benjaminlu34/agent-dashboard/issues/${800 + issueCounter}`,
        issue_node_id: `I_kw_test_${800 + issueCounter}`,
      };
    },
    async addIssueToProject() {
      return { project_item_id: `PVTI_test_${issueCounter}` };
    },
    async setProjectFields() {},
    async updateIssue() {},
  });

  const app = buildApp();
  await registerInternalPlanApplyRoute(app, {
    repoRoot,
    env: {
      ORCHESTRATOR_STATE_PATH: "./tmp/custom-orchestrator.json",
    },
    preflightHandler: buildPreflightPass(),
    githubClientFactory,
  });

  const reply = buildReply();
  const result = await app.handler(
    {
      body: {
        role: "ORCHESTRATOR",
        draft: {
          sprint: "M2",
          require_verification: true,
          issues: [
            {
              title: "State override write test",
              goal: "Ensure explicit env override is honored.",
              non_goals: ["No runner changes"],
              acceptance_criteria: ["Plan apply writes to the override path."],
              files_likely_touched: ["apps/api/src/routes/internal-plan-apply.js"],
              definition_of_done: ["Custom orchestrator state path contains sprint_plan."],
              size: "S",
              area: "api",
              priority: "P1",
            },
          ],
        },
      },
    },
    reply,
  );

  assert.equal(reply.statusCode, 200);
  assert.equal(result.status, "APPLIED");
  const customState = JSON.parse(await readFile(customPath, "utf8"));
  assert.equal(customState.sprint_phase, "PENDING_VERIFICATION");
  assert.equal(typeof customState.sprint_plan, "object");
  assert.equal(Object.keys(customState.sprint_plan).length, 1);
  await assert.rejects(readFile(scopedPath, "utf8"), /ENOENT/);
});

test("GitHub plan apply client batches Sprint and DependsOn text field mutations into one GraphQL request", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "internal-plan-apply-client-text-fields-"));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const body = typeof options.body === "string" ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });

    if (String(url).includes("/graphql") && typeof body?.query === "string") {
      if (body.query.includes("projectsV2")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                user: {
                  repository: {
                    id: "R_repo",
                    labels: { nodes: [] },
                  },
                  projectsV2: {
                    nodes: [
                      {
                        id: "PVT_project",
                        number: 1,
                        title: "Codex Task Board",
                        fields: {
                          nodes: [
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_status",
                              name: "Status",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_backlog", name: "Backlog" },
                                { id: "opt_ready", name: "Ready" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_size",
                              name: "Size",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_s", name: "S" },
                                { id: "opt_m", name: "M" },
                                { id: "opt_l", name: "L" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_area",
                              name: "Area",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_api", name: "api" },
                                { id: "opt_docs", name: "docs" },
                              ],
                            },
                            {
                              __typename: "ProjectV2SingleSelectField",
                              id: "field_priority",
                              name: "Priority",
                              dataType: "SINGLE_SELECT",
                              options: [
                                { id: "opt_p0", name: "P0" },
                                { id: "opt_p1", name: "P1" },
                                { id: "opt_p2", name: "P2" },
                              ],
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_sprint",
                              name: "Sprint",
                              dataType: "TEXT",
                            },
                            {
                              __typename: "ProjectV2Field",
                              id: "field_depends",
                              name: "DependsOn",
                              dataType: "TEXT",
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            };
          },
        };
      }

      if (body.query.includes("updateProjectV2ItemFieldValue")) {
        return {
          ok: true,
          status: 200,
          async json() {
            const data = {};
            for (const key of Object.keys(body?.variables ?? {})) {
              if (key.startsWith("fieldId")) {
                const suffix = key.slice("fieldId".length);
                data[`f${suffix}`] = { projectV2Item: { id: "PVTI_updated" } };
              }
            }
            return {
              data,
            };
          },
        };
      }
    }

    throw new Error(`unexpected fetch call: ${String(url)}`);
  };

  try {
    const client = await createGitHubPlanApplyClient({
      repoRoot,
      projectIdentity: {
        owner_login: "benjaminlu34",
        owner_type: "user",
        project_name: "Codex Task Board",
        repository_name: "agent-dashboard",
      },
      githubToken: "test-token",
      graphqlEndpoint: "https://example.test/graphql",
      restEndpoint: "https://example.test/rest",
    });

    await client.setProjectFields({
      projectItemId: "PVTI_test_1",
      values: {
        Sprint: "draft-2026-02-28",
        DependsOn: "42, Bootstrap infra",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const mutationCalls = calls
    .filter((call) => call.url.includes("/graphql"))
    .map((call) => call.body)
    .filter((body) => typeof body?.query === "string" && body.query.includes("updateProjectV2ItemFieldValue"));

  assert.equal(mutationCalls.length, 1);

  const mutation = mutationCalls[0];
  assert.match(mutation.query, /\bf0:\s*updateProjectV2ItemFieldValue/gu);
  const variables = mutation?.variables ?? {};

  const sprintIndex = Object.keys(variables)
    .filter((key) => key.startsWith("fieldId"))
    .map((key) => key.slice("fieldId".length))
    .find((suffix) => variables[`fieldId${suffix}`] === "field_sprint");
  assert.equal(variables[`textValue${sprintIndex}`], "draft-2026-02-28");

  const dependsIndex = Object.keys(variables)
    .filter((key) => key.startsWith("fieldId"))
    .map((key) => key.slice("fieldId".length))
    .find((suffix) => variables[`fieldId${suffix}`] === "field_depends");
  assert.equal(variables[`textValue${dependsIndex}`], "42, Bootstrap infra");
});
