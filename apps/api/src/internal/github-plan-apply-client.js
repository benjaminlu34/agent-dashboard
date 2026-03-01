import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { readAgentSwarmTarget } from "./agent-swarm-config.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUIRED_SINGLE_SELECT_FIELDS = ["Status", "Size", "Area", "Priority"];
const REQUIRED_TEXT_FIELDS = ["DependsOn"];
const REQUIRED_FLEX_FIELDS = ["Sprint"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeGraphqlDataType(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
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

function toPositiveInteger(value) {
  if (Number.isInteger(value) && value > 0) {
    return value;
  }

  if (isNonEmptyString(value)) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
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

function buildProjectFieldMap(project) {
  const fields = {};
  const nodes = project?.fields?.nodes ?? [];

  for (const node of nodes) {
    if (!isNonEmptyString(node?.name) || !isNonEmptyString(node?.id)) {
      continue;
    }

    if (node.__typename === "ProjectV2SingleSelectField") {
      const optionsByName = {};
      for (const option of node.options ?? []) {
        if (isNonEmptyString(option?.name) && isNonEmptyString(option?.id)) {
          optionsByName[option.name] = option.id;
        }
      }

      fields[node.name] = {
        field_id: node.id,
        data_type: normalizeGraphqlDataType(node.dataType),
        options_by_name: optionsByName,
      };
      continue;
    }

    if (node.__typename === "ProjectV2Field") {
      fields[node.name] = {
        field_id: node.id,
        data_type: normalizeGraphqlDataType(node.dataType),
      };
      continue;
    }
  }

  for (const requiredField of REQUIRED_SINGLE_SELECT_FIELDS) {
    const field = fields[requiredField];
    if (!field) {
      throw new GitHubPlanApplyError(`required project field missing: ${requiredField}`);
    }
    if (field.data_type !== "single_select" || !field.options_by_name) {
      throw new GitHubPlanApplyError(`required project field must be single_select: ${requiredField}`);
    }
  }

  for (const requiredField of REQUIRED_TEXT_FIELDS) {
    const field = fields[requiredField];
    if (!field) {
      throw new GitHubPlanApplyError(`required project field missing: ${requiredField}`);
    }
    if (field.data_type !== "text") {
      throw new GitHubPlanApplyError(`required project field must be text: ${requiredField}`);
    }
  }

  for (const requiredField of REQUIRED_FLEX_FIELDS) {
    const field = fields[requiredField];
    if (!field) {
      throw new GitHubPlanApplyError(`required project field missing: ${requiredField}`);
    }
    if (field.data_type !== "text" && field.data_type !== "single_select") {
      throw new GitHubPlanApplyError(`required project field must be text or single_select: ${requiredField}`);
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
    if (response.ok) {
      throw new GitHubPlanApplyError(`GitHub REST API returned non-JSON response (HTTP ${response.status})`);
    }
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

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new GitHubPlanApplyError(`GitHub GraphQL API returned non-JSON response (HTTP ${response.status})`);
  }
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
    if (!isNonEmptyString(fieldName)) {
      continue;
    }

    const optionName = node?.name;
    if (isNonEmptyString(optionName)) {
      fields[fieldName] = optionName;
      continue;
    }

    if (typeof node?.text === "string") {
      fields[fieldName] = node.text;
    }
  }
  return fields;
}

function requireOptionId(fieldsByName, fieldName, optionName) {
  const field = fieldsByName[fieldName];
  if (!field) {
    throw new GitHubPlanApplyError(`project field not found: ${fieldName}`);
  }
  if (field.data_type !== "single_select" || !field.options_by_name) {
    throw new GitHubPlanApplyError(`project field is not single_select: ${fieldName}`);
  }
  const optionId = field.options_by_name[optionName];
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

  const agentSwarmTarget = await readAgentSwarmTarget({ repoRoot });

  const ownerLogin = isNonEmptyString(agentSwarmTarget?.owner)
    ? agentSwarmTarget.owner
    : projectIdentity?.owner_login;
  const ownerType = normalizeOwnerType(projectIdentity?.owner_type);
  const projectName = isNonEmptyString(agentSwarmTarget?.project_name)
    ? agentSwarmTarget.project_name
    : projectIdentity?.project_name;
  const projectNumber = toPositiveInteger(agentSwarmTarget?.project_v2_number ?? projectIdentity?.project_v2_number);

  if (!isNonEmptyString(ownerLogin) || (!isNonEmptyString(projectName) && projectNumber === null) || (ownerType !== "user" && ownerType !== "org")) {
    throw new GitHubPlanApplyError("invalid project identity");
  }

  const repositoryName = await resolveRepositoryName({
    repoRoot,
    projectIdentity: {
      ...projectIdentity,
      repository_name: isNonEmptyString(agentSwarmTarget?.repo) ? agentSwarmTarget.repo : projectIdentity?.repository_name,
      repo: isNonEmptyString(agentSwarmTarget?.repo) ? agentSwarmTarget.repo : projectIdentity?.repo,
    },
  });
  const ownerNode = buildOwnerNode(ownerType);

  const projectData = await requestGraphql({
    token: githubToken,
    endpoint: graphqlEndpoint,
    query: `
      query($ownerLogin: String!, $repoName: String!) {
        ${ownerNode}(login: $ownerLogin) {
          repository(name: $repoName) {
            id
            labels(first: 100) {
              nodes {
                id
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          projectsV2(first: 100) {
            nodes {
              id
              number
              title
              fields(first: 100) {
                nodes {
                  __typename
                  ... on ProjectV2Field {
                    id
                    name
                    dataType
                  }
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    dataType
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
    variables: { ownerLogin, repoName: repositoryName },
  });

  const ownerData = projectData?.[ownerNode];
  const projects = ownerData?.projectsV2?.nodes;
  if (!Array.isArray(projects)) {
    throw new GitHubPlanApplyError("project owner not found");
  }

  const repositoryId = ownerData?.repository?.id;
  if (!isNonEmptyString(repositoryId)) {
    throw new GitHubPlanApplyError("repository not found for project identity");
  }

  const allLabelNodes = [];
  const firstLabelConnection = ownerData?.repository?.labels;
  const firstLabelNodes = firstLabelConnection?.nodes ?? [];
  if (Array.isArray(firstLabelNodes) && firstLabelNodes.length > 0) {
    allLabelNodes.push(...firstLabelNodes);
  }

  let labelsCursor = firstLabelConnection?.pageInfo?.hasNextPage ? firstLabelConnection.pageInfo.endCursor : null;

  while (isNonEmptyString(labelsCursor)) {
    const pageData = await requestGraphql({
      token: githubToken,
      endpoint: graphqlEndpoint,
      query: `
        query($ownerLogin: String!, $repoName: String!, $cursor: String) {
          ${ownerNode}(login: $ownerLogin) {
            repository(name: $repoName) {
              labels(first: 100, after: $cursor) {
                nodes {
                  id
                  name
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      variables: { ownerLogin, repoName: repositoryName, cursor: labelsCursor },
    });

    const nextConnection = pageData?.[ownerNode]?.repository?.labels;
    const nextNodes = nextConnection?.nodes ?? [];
    if (Array.isArray(nextNodes) && nextNodes.length > 0) {
      allLabelNodes.push(...nextNodes);
    }

    if (!nextConnection?.pageInfo?.hasNextPage) {
      break;
    }

    labelsCursor = nextConnection.pageInfo.endCursor;
  }

  const labelIdByName = {};
  for (const node of allLabelNodes) {
    if (!isNonEmptyString(node?.name) || !isNonEmptyString(node?.id)) {
      continue;
    }
    labelIdByName[node.name] = node.id;
    const lower = node.name.trim().toLowerCase();
    if (lower && !labelIdByName[lower]) {
      labelIdByName[lower] = node.id;
    }
  }

  const project = projectNumber !== null
    ? projects.find((entry) => entry?.number === projectNumber)
    : projects.find((entry) => entry?.title === projectName);
  if (!project) {
    if (projectNumber !== null) {
      throw new GitHubPlanApplyError(`project not found: number ${projectNumber}`);
    }
    throw new GitHubPlanApplyError(`project not found: ${projectName}`);
  }

  const fieldsByName = buildProjectFieldMap(project);

  function buildProjectItemFieldUpdateRequest({ projectItemId, values }) {
    const entries = Object.entries(values ?? {}).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      return null;
    }

    const variableFragments = ["$projectId: ID!", "$itemId: ID!"];
    const variables = {
      projectId: project.id,
      itemId: projectItemId,
    };

    const mutationLines = [];

    for (let index = 0; index < entries.length; index += 1) {
      const [fieldName, value] = entries[index];
      const field = fieldsByName[fieldName];
      if (!field) {
        throw new GitHubPlanApplyError(`project field not found: ${fieldName}`);
      }

      const alias = `f${index}`;
      const fieldIdKey = `fieldId${index}`;
      variableFragments.push(`$${fieldIdKey}: ID!`);
      variables[fieldIdKey] = field.field_id;

      if (field.data_type === "single_select") {
        const { option_id: optionId } = requireOptionId(fieldsByName, fieldName, value);
        const optionKey = `optionId${index}`;
        variableFragments.push(`$${optionKey}: String!`);
        variables[optionKey] = optionId;
        mutationLines.push(
          `${alias}: updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$${fieldIdKey},value:{singleSelectOptionId:$${optionKey}}}){projectV2Item{id}}`,
        );
        continue;
      }

      if (field.data_type === "text") {
        if (typeof value !== "string") {
          throw new GitHubPlanApplyError(`project text field value must be a string: ${fieldName}`);
        }
        const textKey = `textValue${index}`;
        variableFragments.push(`$${textKey}: String!`);
        variables[textKey] = value;
        mutationLines.push(
          `${alias}: updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$${fieldIdKey},value:{text:$${textKey}}}){projectV2Item{id}}`,
        );
        continue;
      }

      throw new GitHubPlanApplyError(`unsupported project field type: ${fieldName}=${field.data_type || "unknown"}`);
    }

    return {
      query: `mutation(${variableFragments.join(",")}){${mutationLines.join("")}}`,
      variables,
    };
  }

  async function updateProjectItemFieldValue({ projectItemId, fieldName, value }) {
    const field = fieldsByName[fieldName];
    if (!field) {
      throw new GitHubPlanApplyError(`project field not found: ${fieldName}`);
    }

    if (field.data_type === "single_select") {
      const { field_id: fieldId, option_id: optionId } = requireOptionId(fieldsByName, fieldName, value);

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
      return;
    }

    if (field.data_type === "text") {
      if (typeof value !== "string") {
        throw new GitHubPlanApplyError(`project text field value must be a string: ${fieldName}`);
      }

      await requestGraphql({
        token: githubToken,
        endpoint: graphqlEndpoint,
        query: `
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $textValue: String!) {
            updateProjectV2ItemFieldValue(
              input: {
                projectId: $projectId
                itemId: $itemId
                fieldId: $fieldId
                value: { text: $textValue }
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
          fieldId: field.field_id,
          textValue: value,
        },
      });
      return;
    }

    throw new GitHubPlanApplyError(`unsupported project field type: ${fieldName}=${field.data_type || "unknown"}`);
  }

  return {
    async createIssue({ title, body, labels }) {
      if (labels !== undefined) {
        if (!Array.isArray(labels) || labels.length === 0 || !labels.every((label) => isNonEmptyString(label))) {
          throw new GitHubPlanApplyError("issue labels must be a non-empty array of strings");
        }
      }
      if (!isNonEmptyString(title)) {
        throw new GitHubPlanApplyError("issue title is required");
      }
      if (!isNonEmptyString(body)) {
        throw new GitHubPlanApplyError("issue body is required");
      }

      const labelIds = [];
      for (const label of Array.isArray(labels) ? labels : []) {
        const key = label.trim();
        const id = labelIdByName[key] ?? labelIdByName[key.toLowerCase()];
        if (!isNonEmptyString(id)) {
          throw new GitHubPlanApplyError(`label not found: ${key}`);
        }
        if (!labelIds.includes(id)) {
          labelIds.push(id);
        }
      }

      const data = await requestGraphql({
        token: githubToken,
        endpoint: graphqlEndpoint,
        query: `
          mutation($repositoryId: ID!, $title: String!, $body: String!, $labelIds: [ID!]) {
            createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, labelIds: $labelIds }) {
              issue {
                id
                number
                url
              }
            }
          }
        `,
        variables: {
          repositoryId,
          title,
          body,
          labelIds,
        },
      });

      const issue = data?.createIssue?.issue;
      const issueNumber = issue?.number;
      const issueUrl = issue?.url;
      const issueNodeId = issue?.id;
      if (!Number.isInteger(issueNumber) || !isNonEmptyString(issueUrl) || !isNonEmptyString(issueNodeId)) {
        throw new GitHubPlanApplyError("unexpected GitHub createIssue response");
      }
      return {
        issue_number: issueNumber,
        issue_url: issueUrl,
        issue_node_id: issueNodeId,
      };
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
      const request = buildProjectItemFieldUpdateRequest({ projectItemId, values });
      if (!request) {
        return;
      }

      await requestGraphql({
        token: githubToken,
        endpoint: graphqlEndpoint,
        query: request.query,
        variables: request.variables,
      });
    },

    async updateProjectItemField({ projectItemId, field, value }) {
      await updateProjectItemFieldValue({ projectItemId, fieldName: field, value });
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
                  ... on ProjectV2ItemFieldTextValue {
                    text
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

      const value = data?.node?.fieldValueByName;
      const singleSelect = value?.name;
      if (isNonEmptyString(singleSelect)) {
        return singleSelect;
      }
      return typeof value?.text === "string" ? value.text : "";
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
	                          title
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
                          ... on ProjectV2ItemFieldTextValue {
                            text
                            field {
                              ... on ProjectV2Field {
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
	            issue_title: isNonEmptyString(node?.content?.title) ? node.content.title.trim() : "",
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
