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
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new ProjectSchemaReadError(`failed to read GitHub Projects schema: HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new ProjectSchemaReadError("failed to read GitHub Projects schema: GraphQL error");
  }

  return payload.data;
}

async function resolveOwnerLogin({ endpoint, githubToken }) {
  const data = await runGraphqlQuery({
    endpoint,
    githubToken,
    query: `
      query {
        viewer {
          login
        }
      }
    `,
  });

  const login = data?.viewer?.login;
  if (typeof login !== "string" || login.length === 0) {
    throw new ProjectSchemaReadError("failed to resolve GitHub viewer login");
  }

  return login;
}

export async function readProjectSchemaFromGitHub({
  projectName,
  projectOwner,
  githubToken = process.env.GITHUB_PAT ?? process.env.GITHUB_TOKEN,
  endpoint = GITHUB_GRAPHQL_URL,
} = {}) {
  if (!githubToken) {
    throw new ProjectSchemaReadError("missing GitHub token for project schema read");
  }

  if (typeof projectName !== "string" || projectName.trim().length === 0) {
    throw new ProjectSchemaReadError("missing project name");
  }

  const ownerLogin =
    typeof projectOwner === "string" && projectOwner.trim().length > 0
      ? projectOwner.trim()
      : await resolveOwnerLogin({ endpoint, githubToken });

  const data = await runGraphqlQuery({
    endpoint,
    githubToken,
    query: `
      query($ownerLogin: String!) {
        user(login: $ownerLogin) {
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
        organization(login: $ownerLogin) {
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

  const projects = data?.user?.projectsV2?.nodes ?? data?.organization?.projectsV2?.nodes;
  if (!Array.isArray(projects)) {
    throw new ProjectSchemaReadError(`owner not found for project schema read: ${ownerLogin}`);
  }

  const project = projects.find((entry) => entry?.title === projectName);
  if (!project) {
    throw new ProjectSchemaReadError(`project not found for owner ${ownerLogin}: ${projectName}`);
  }

  return {
    project_name: projectName,
    project_owner: ownerLogin,
    fields: mapProjectFields(project),
  };
}
