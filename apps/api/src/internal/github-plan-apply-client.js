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

function parseProjectItemFields(fieldValuesNodes) {
  const fields = {};
  for (const node of fieldValuesNodes ?? []) {
    const fieldName = node?.field?.name;
    const optionName = node?.name;
    if (isNonEmptyString(fieldName) && isNonEmptyString(optionName)) {
      fields[fieldName] = optionName;
    }
  }
  return fields;
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
    async createIssue({ title, body, labels }) {
      if (labels !== undefined) {
        if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => isNonEmptyString(label))) {
          throw new GitHubPlanApplyError("issue labels must be a non-empty array of strings");
        }
      }
      const payload = await requestJson(`${restEndpoint}/repos/${ownerLogin}/${repositoryName}/issues`, {
        method: "POST",
        token: githubToken,
        body: {
          title,
          body,
          ...(Array.isArray(labels) ? { labels } : {}),
        },
      });
      return parseIssueResult(payload);
    },

    async updateIssue({ issueNumber, body }) {
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new GitHubPlanApplyError("issueNumber must be a positive integer");
      }
      if (!isNonEmptyString(body)) {
        throw new GitHubPlanApplyError("issue body is required");
      }

      const payload = await requestJson(`${restEndpoint}/repos/${ownerLogin}/${repositoryName}/issues/${issueNumber}`, {
        method: "PATCH",
        token: githubToken,
        body: { body },
      });

      return parseIssueResult(payload);
    },

    async listRepoDirectory({ path = "" } = {}) {
      const normalizedPath = isNonEmptyString(path)
        ? path
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+/, "")
            .replace(/\/+$/, "")
        : "";
      const encodedPath = normalizedPath
        ? normalizedPath
            .split("/")
            .filter((segment) => segment.length > 0)
            .map((segment) => encodeURIComponent(segment))
            .join("/")
        : "";

      const base = `${restEndpoint}/repos/${ownerLogin}/${repositoryName}/contents`;
      const payload = await requestJson(encodedPath ? `${base}/${encodedPath}` : base, {
        method: "GET",
        token: githubToken,
      });

      if (!Array.isArray(payload)) {
        throw new GitHubPlanApplyError("unexpected GitHub contents response (expected directory listing)");
      }

      return payload
        .map((entry) => ({
          name: typeof entry?.name === "string" ? entry.name : "",
          type: typeof entry?.type === "string" ? entry.type : "",
          path: typeof entry?.path === "string" ? entry.path : "",
        }))
        .filter((entry) => isNonEmptyString(entry.name) && isNonEmptyString(entry.type));
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

    async listProjectItems() {
      const items = [];
      let cursor = null;

      do {
        const data = await requestGraphql({
          token: githubToken,
          endpoint: graphqlEndpoint,
          query: `
            query($projectId: ID!, $cursor: String) {
              node(id: $projectId) {
                ... on ProjectV2 {
                  items(first: 100, after: $cursor) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      id
                      content {
                        ... on Issue {
                          number
                          url
                          repository {
                            name
                            owner {
                              login
                            }
                          }
                        }
                      }
                      fieldValues(first: 50) {
                        nodes {
                          ... on ProjectV2ItemFieldSingleSelectValue {
                            name
                            field {
                              ... on ProjectV2SingleSelectField {
                                name
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            projectId: project.id,
            cursor,
          },
        });

        const connection = data?.node?.items;
        const nodes = connection?.nodes ?? [];

        for (const node of nodes) {
          const issueNumber = node?.content?.number;
          const issueUrl = node?.content?.url;
          if (!Number.isInteger(issueNumber) || !isNonEmptyString(issueUrl)) {
            continue;
          }

          items.push({
            project_item_id: node.id,
            issue_number: issueNumber,
            issue_url: issueUrl,
            fields: parseProjectItemFields(node?.fieldValues?.nodes),
          });
        }

        if (!connection?.pageInfo?.hasNextPage) {
          break;
        }

        cursor = connection.pageInfo.endCursor;
      } while (cursor);

      return items;
    },

	    async listPullRequests({ state = "all" } = {}) {
	      const allowedState = state === "open" || state === "closed" || state === "all" ? state : "all";
	      const all = [];
	      let page = 1;

      while (true) {
        const payload = await requestJson(
          `${restEndpoint}/repos/${ownerLogin}/${repositoryName}/pulls?state=${allowedState}&per_page=100&page=${page}`,
          {
            method: "GET",
            token: githubToken,
          },
        );

        if (!Array.isArray(payload) || payload.length === 0) {
          break;
        }

	        for (const pr of payload) {
	          if (!Number.isInteger(pr?.number)) {
	            continue;
	          }
	          all.push({
	            number: pr.number,
	            html_url: pr?.html_url ?? "",
	            body: typeof pr?.body === "string" ? pr.body : "",
	            head_ref: typeof pr?.head?.ref === "string" ? pr.head.ref : "",
	            head_sha: typeof pr?.head?.sha === "string" ? pr.head.sha : "",
	            state: typeof pr?.state === "string" ? pr.state : "",
	          });
	        }

        if (payload.length < 100) {
          break;
        }

        page += 1;
      }

      all.sort((left, right) => left.number - right.number);
      return all;
    },

	    async getPullRequest({ prNumber }) {
	      if (!Number.isInteger(prNumber) || prNumber <= 0) {
	        throw new GitHubPlanApplyError("prNumber must be a positive integer");
	      }

      const payload = await requestJson(`${restEndpoint}/repos/${ownerLogin}/${repositoryName}/pulls/${prNumber}`, {
        method: "GET",
        token: githubToken,
      });

      if (!Number.isInteger(payload?.number)) {
        throw new GitHubPlanApplyError("unexpected pull request response");
      }

	      return {
	        number: payload.number,
	        html_url: typeof payload?.html_url === "string" ? payload.html_url : "",
	        body: typeof payload?.body === "string" ? payload.body : "",
	        head_ref: typeof payload?.head?.ref === "string" ? payload.head.ref : "",
	        head_sha: typeof payload?.head?.sha === "string" ? payload.head.sha : "",
	        state: typeof payload?.state === "string" ? payload.state : "",
	      };
	    },

    async listIssueComments({ issueNumber }) {
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new GitHubPlanApplyError("issueNumber must be a positive integer");
      }

      const comments = [];
      let page = 1;

      while (true) {
        const payload = await requestJson(
          `${restEndpoint}/repos/${ownerLogin}/${repositoryName}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
          {
            method: "GET",
            token: githubToken,
          },
        );

        if (!Array.isArray(payload) || payload.length === 0) {
          break;
        }

        for (const comment of payload) {
          if (!Number.isInteger(comment?.id)) {
            continue;
          }
          comments.push({
            id: comment.id,
            body: typeof comment?.body === "string" ? comment.body : "",
            created_at: typeof comment?.created_at === "string" ? comment.created_at : "",
            html_url: typeof comment?.html_url === "string" ? comment.html_url : "",
          });
        }

        if (payload.length < 100) {
          break;
        }

        page += 1;
      }

      comments.sort((left, right) => left.id - right.id);
      return comments;
    },

    async createIssueComment({ issueNumber, body }) {
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new GitHubPlanApplyError("issueNumber must be a positive integer");
      }
      if (!isNonEmptyString(body)) {
        throw new GitHubPlanApplyError("comment body is required");
      }

      const payload = await requestJson(
        `${restEndpoint}/repos/${ownerLogin}/${repositoryName}/issues/${issueNumber}/comments`,
        {
          method: "POST",
          token: githubToken,
          body: {
            body,
          },
        },
      );

      if (!Number.isInteger(payload?.id)) {
        throw new GitHubPlanApplyError("unexpected issue comment response");
      }

      return {
        id: payload.id,
        body: typeof payload?.body === "string" ? payload.body : "",
        created_at: typeof payload?.created_at === "string" ? payload.created_at : "",
        html_url: typeof payload?.html_url === "string" ? payload.html_url : "",
      };
    },
  };
}
