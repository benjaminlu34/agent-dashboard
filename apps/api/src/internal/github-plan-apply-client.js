import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUIRED_PROJECT_FIELDS = ["Status", "Size", "Area", "Priority", "Sprint"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOwnerType(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "organization") {
    return "org";
  }
  return normalized;
}

function extractRepoFromGitRemoteUrl(remoteUrl) {
  if (!isNonEmptyString(remoteUrl)) {
    return "";
  }

  const normalized = remoteUrl.trim();
  const httpsMatch = normalized.match(/github\.com\/[^/]+\/([^/.]+)(?:\.git)?$/i);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = normalized.match(/github\.com:[^/]+\/([^/.]+)(?:\.git)?$/i);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  return "";
}

async function resolveRepositoryName({ repoRoot, projectIdentity }) {
  if (isNonEmptyString(projectIdentity?.repository_name)) {
    return projectIdentity.repository_name.trim();
  }
  if (isNonEmptyString(projectIdentity?.repo)) {
    return projectIdentity.repo.trim();
  }
  if (isNonEmptyString(projectIdentity?.repository)) {
    return projectIdentity.repository.trim();
  }

  if (isNonEmptyString(process.env.GITHUB_REPOSITORY)) {
    const [, repoName = ""] = process.env.GITHUB_REPOSITORY.split("/");
    if (repoName) {
      return repoName;
    }
  }

  const gitConfigPath = resolve(repoRoot, ".git/config");
  try {
    const gitConfig = await readFile(gitConfigPath, "utf8");
    const originBlockMatch = gitConfig.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/);
    const originBlock = originBlockMatch?.[1] ?? "";
    const urlMatch = originBlock.match(/^\s*url\s*=\s*(.+)\s*$/m);
    const remoteUrl = urlMatch?.[1] ?? "";
    const repoName = extractRepoFromGitRemoteUrl(remoteUrl);
    if (repoName) {
      return repoName;
    }
  } catch {
    // Fall through to explicit error below.
  }

  throw new GitHubPlanApplyError(
    "repository name could not be resolved; set policy/github-project.json.repository_name or GITHUB_REPOSITORY",
  );
}

function buildOwnerNode(ownerType) {
  if (ownerType === "user") {
    return "user";
  }
  if (ownerType === "org") {
    return "organization";
  }
  throw new GitHubPlanApplyError("owner_type must be user or org");
}

function buildSingleSelectFieldMap(project) {
  const fields = {};
  const nodes = project?.fields?.nodes ?? [];

  for (const node of nodes) {
    if (node?.__typename !== "ProjectV2SingleSelectField") {
      continue;
    }

    const optionsByName = {};
    for (const option of node.options ?? []) {
      if (isNonEmptyString(option?.name) && isNonEmptyString(option?.id)) {
        optionsByName[option.name] = option.id;
      }
    }

    fields[node.name] = {
      field_id: node.id,
      options_by_name: optionsByName,
    };
  }

  for (const requiredField of REQUIRED_PROJECT_FIELDS) {
    if (!fields[requiredField]) {
      throw new GitHubPlanApplyError(`required project field missing: ${requiredField}`);
    }
  }

  return fields;
}

async function requestJson(url, { method = "GET", token, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/vnd.github+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message ?? `HTTP ${response.status}`;
    throw new GitHubPlanApplyError(message);
  }

  return payload;
}

async function requestGraphql({ token, endpoint, query, variables }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new GitHubPlanApplyError(`GitHub GraphQL request failed: HTTP ${response.status}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors[0]?.message ?? "GitHub GraphQL error";
    throw new GitHubPlanApplyError(message);
  }

  return payload.data;
}

function parseIssueResult(payload) {
  const issueNumber = payload?.number;
  const issueUrl = payload?.html_url;
  const issueNodeId = payload?.node_id;

  if (!Number.isInteger(issueNumber) || !isNonEmptyString(issueUrl) || !isNonEmptyString(issueNodeId)) {
    throw new GitHubPlanApplyError("unexpected GitHub issue response");
  }

  return {
    issue_number: issueNumber,
    issue_url: issueUrl,
    issue_node_id: issueNodeId,
  };
}

function requireOptionId(fieldsByName, fieldName, optionName) {
  const field = fieldsByName[fieldName];
  const optionId = field?.options_by_name?.[optionName];
  if (!isNonEmptyString(optionId)) {
    throw new GitHubPlanApplyError(`project option not found: ${fieldName}=${optionName}`);
  }
  return {
    field_id: field.field_id,
    option_id: optionId,
  };
}

export class GitHubPlanApplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubPlanApplyError";
  }
}

export async function createGitHubPlanApplyClient({
  repoRoot,
  projectIdentity,
  githubToken = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN,
  restEndpoint = GITHUB_API_BASE_URL,
  graphqlEndpoint = GITHUB_GRAPHQL_URL,
} = {}) {
  if (!isNonEmptyString(githubToken)) {
    throw new GitHubPlanApplyError("missing GitHub token");
  }

  const ownerLogin = projectIdentity?.owner_login;
  const ownerType = normalizeOwnerType(projectIdentity?.owner_type);
  const projectName = projectIdentity?.project_name;

  if (!isNonEmptyString(ownerLogin) || !isNonEmptyString(projectName) || (ownerType !== "user" && ownerType !== "org")) {
    throw new GitHubPlanApplyError("invalid project identity");
  }

  const repositoryName = await resolveRepositoryName({ repoRoot, projectIdentity });
  const ownerNode = buildOwnerNode(ownerType);

  const projectData = await requestGraphql({
    token: githubToken,
    endpoint: graphqlEndpoint,
    query: `
      query($ownerLogin: String!) {
        ${ownerNode}(login: $ownerLogin) {
          projectsV2(first: 100) {
            nodes {
              id
              title
              fields(first: 100) {
                nodes {
                  __typename
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    variables: { ownerLogin },
  });

  const projects = projectData?.[ownerNode]?.projectsV2?.nodes;
  if (!Array.isArray(projects)) {
    throw new GitHubPlanApplyError("project owner not found");
  }

  const project = projects.find((entry) => entry?.title === projectName);
  if (!project) {
    throw new GitHubPlanApplyError(`project not found: ${projectName}`);
  }

  const fieldsByName = buildSingleSelectFieldMap(project);

  async function updateProjectItemSingleSelectField({ projectItemId, fieldName, optionName }) {
    const { field_id: fieldId, option_id: optionId } = requireOptionId(fieldsByName, fieldName, optionName);

    await requestGraphql({
      token: githubToken,
      endpoint: graphqlEndpoint,
      query: `
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(
            input: {
              projectId: $projectId
              itemId: $itemId
              fieldId: $fieldId
              value: { singleSelectOptionId: $optionId }
            }
          ) {
            projectV2Item {
              id
            }
          }
        }
      `,
      variables: {
        projectId: project.id,
        itemId: projectItemId,
        fieldId,
        optionId,
      },
    });
  }

  return {
    async createIssue({ title, body }) {
      const payload = await requestJson(`${restEndpoint}/repos/${ownerLogin}/${repositoryName}/issues`, {
        method: "POST",
        token: githubToken,
        body: {
          title,
          body,
        },
      });
      return parseIssueResult(payload);
    },

    async addIssueToProject({ issueNodeId }) {
      const data = await requestGraphql({
        token: githubToken,
        endpoint: graphqlEndpoint,
        query: `
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item {
                id
              }
            }
          }
        `,
        variables: {
          projectId: project.id,
          contentId: issueNodeId,
        },
      });

      const itemId = data?.addProjectV2ItemById?.item?.id;
      if (!isNonEmptyString(itemId)) {
        throw new GitHubPlanApplyError("failed to add issue to project");
      }

      return { project_item_id: itemId };
    },

    async setProjectFields({ projectItemId, values }) {
      for (const [fieldName, optionName] of Object.entries(values)) {
        await updateProjectItemSingleSelectField({ projectItemId, fieldName, optionName });
      }
    },

    async updateProjectItemField({ projectItemId, field, value }) {
      await updateProjectItemSingleSelectField({
        projectItemId,
        fieldName: field,
        optionName: value,
      });
    },

    async getProjectItemFieldValue({ projectItemId, field }) {
      const data = await requestGraphql({
        token: githubToken,
        endpoint: graphqlEndpoint,
        query: `
          query($itemId: ID!, $fieldName: String!) {
            node(id: $itemId) {
              ... on ProjectV2Item {
                fieldValueByName(name: $fieldName) {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                  }
                }
              }
            }
          }
        `,
        variables: {
          itemId: projectItemId,
          fieldName: field,
        },
      });

      const fieldName = data?.node?.fieldValueByName?.name;
      return isNonEmptyString(fieldName) ? fieldName : "";
    },
  };
}
