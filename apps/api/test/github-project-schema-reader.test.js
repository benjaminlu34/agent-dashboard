import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { ProjectSchemaReadError, readProjectSchemaFromGitHub } from "../src/internal/policy/github-project-schema-reader.js";

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolvePromise) => server.listen(0, resolvePromise));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/graphql`;

  try {
    return await callback(endpoint);
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
    });
  }
}

test("readProjectSchemaFromGitHub fails closed when GraphQL responds with non-JSON", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><html><body>not json</body></html>");
    },
    async (endpoint) => {
      await assert.rejects(
        () =>
          readProjectSchemaFromGitHub({
            projectIdentity: {
              owner_login: "owner",
              owner_type: "user",
              project_name: "Codex Task Board",
            },
            githubToken: "token",
            endpoint,
          }),
        (error) =>
          error instanceof ProjectSchemaReadError &&
          /non-JSON response/.test(error.message),
      );
    },
  );
});

test("readProjectSchemaFromGitHub surfaces GitHub message on non-OK response", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "service unavailable" }));
    },
    async (endpoint) => {
      await assert.rejects(
        () =>
          readProjectSchemaFromGitHub({
            projectIdentity: {
              owner_login: "owner",
              owner_type: "org",
              project_name: "Codex Task Board",
            },
            githubToken: "token",
            endpoint,
          }),
        (error) =>
          error instanceof ProjectSchemaReadError &&
          /service unavailable/.test(error.message),
      );
    },
  );
});

test("readProjectSchemaFromGitHub resolves project by project_v2_number", async () => {
  await withServer(
    async (request, response) => {
      let rawBody = "";
      for await (const chunk of request) {
        rawBody += chunk;
      }
      const parsedBody = JSON.parse(rawBody);
      assert.equal(typeof parsedBody.query, "string");
      assert.deepEqual(parsedBody.variables, { ownerLogin: "owner" });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            user: {
              projectsV2: {
                nodes: [
                  {
                    number: 2,
                    title: "Wrong Board",
                    fields: { nodes: [] },
                  },
                  {
                    number: 3,
                    title: "Correct Board",
                    fields: {
                      nodes: [
                        {
                          __typename: "ProjectV2SingleSelectField",
                          name: "Status",
                          dataType: "SINGLE_SELECT",
                          options: [{ name: "Backlog" }, { name: "Done" }],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }),
      );
    },
    async (endpoint) => {
      const schema = await readProjectSchemaFromGitHub({
        projectIdentity: {
          owner_login: "owner",
          owner_type: "user",
          project_v2_number: 3,
        },
        githubToken: "token",
        endpoint,
      });

      assert.equal(schema.project_name, "Correct Board");
      assert.equal(schema.project_owner, "owner");
      assert.equal(schema.project_owner_type, "user");
      assert.deepEqual(schema.fields, [{ name: "Status", type: "single_select", options: ["Backlog", "Done"] }]);
    },
  );
});
