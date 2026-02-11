const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export class ProjectSchemaReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectSchemaReadError";
  }
}

function normalizeGraphqlDataType(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

function mapProjectFields(project) {
  return (project?.fields?.nodes ?? [])
    .filter((field) => typeof field?.name === "string" && field.name.length > 0)
    .map((field) => ({
      name: field.name,
      type: normalizeGraphqlDataType(field.dataType),
      options: Array.isArray(field.options) ? field.options.map((option) => option.name) : [],
    }));
}

async function runGraphqlQuery({ endpoint, githubToken, query, variables }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${githubToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ProjectSchemaReadError(
      `failed to read GitHub Projects schema: non-JSON response (HTTP ${response.status})`,
    );
  }

  if (!response.ok) {
    const message = typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : `HTTP ${response.status}`;
    throw new ProjectSchemaReadError(`failed to read GitHub Projects schema: ${message}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = typeof payload.errors[0]?.message === "string" ? payload.errors[0].message : "GraphQL error";
    throw new ProjectSchemaReadError(`failed to read GitHub Projects schema: ${message}`);
  }

  return payload.data;
}

export async function readProjectSchemaFromGitHub({
  projectIdentity,
  githubToken = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN,
  endpoint = GITHUB_GRAPHQL_URL,
} = {}) {
  if (!githubToken) {
    throw new ProjectSchemaReadError("missing GitHub token for project schema read");
  }

  const ownerLogin = typeof projectIdentity?.owner_login === "string" ? projectIdentity.owner_login.trim() : "";
  const ownerType = typeof projectIdentity?.owner_type === "string" ? projectIdentity.owner_type.trim() : "";
  const projectName = typeof projectIdentity?.project_name === "string" ? projectIdentity.project_name.trim() : "";

  if (!ownerLogin || !projectName || (ownerType !== "user" && ownerType !== "org")) {
    throw new ProjectSchemaReadError(
      "invalid project identity: expected owner_login, owner_type (user|org), and project_name",
    );
  }

  const queryRoot =
    ownerType === "user"
      ? "user(login: $ownerLogin)"
      : "organization(login: $ownerLogin)";
  const nodeKey = ownerType === "user" ? "user" : "organization";

  const data = await runGraphqlQuery({
    endpoint,
    githubToken,
    query: `
      query($ownerLogin: String!) {
        ${queryRoot} {
          projectsV2(first: 100) {
            nodes {
              title
              fields(first: 100) {
                nodes {
                  __typename
                  ... on ProjectV2Field {
                    name
                    dataType
                  }
                  ... on ProjectV2SingleSelectField {
                    name
                    dataType
                    options {
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

  const projects = data?.[nodeKey]?.projectsV2?.nodes;
  if (!Array.isArray(projects)) {
    throw new ProjectSchemaReadError(`owner not found for project schema read: ${ownerType}/${ownerLogin}`);
  }

  const project = projects.find((entry) => entry?.title === projectName);
  if (!project) {
    throw new ProjectSchemaReadError(`project not found for owner ${ownerLogin}: ${projectName}`);
  }

  return {
    project_name: projectName,
    project_owner: ownerLogin,
    project_owner_type: ownerType,
    fields: mapProjectFields(project),
  };
}
