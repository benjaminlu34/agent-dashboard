import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export class AgentContextBundleError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentContextBundleError";
    this.details = details;
  }
}

const POLICY_JSON_PATHS = new Set([
  "policy/github-project.json",
  "policy/project-schema.json",
  "policy/transitions.json",
  "policy/role-permissions.json",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function orderedBundlePaths(role) {
  return [
    "AGENTS.md",
    `agents/${role}.md`,
    "policy/github-project.json",
    "policy/project-schema.json",
    "policy/transitions.json",
    "policy/role-permissions.json",
  ];
}

export async function loadAgentContextBundle({ repoRoot, role }) {
  const paths = orderedBundlePaths(role);
  const files = [];

  for (const relativePath of paths) {
    const absolutePath = resolve(repoRoot, relativePath);
    let content;

    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new AgentContextBundleError("required file is missing", {
          path: relativePath,
        });
      }
      throw error;
    }

    if (POLICY_JSON_PATHS.has(relativePath)) {
      try {
        JSON.parse(content);
      } catch {
        throw new AgentContextBundleError("policy file is not valid JSON", {
          path: relativePath,
        });
      }
    }

    const sizeBytes = Buffer.byteLength(content, "utf8");
    const digest = sha256(content);

    files.push({
      path: relativePath,
      size_bytes: sizeBytes,
      sha256: digest,
      content,
    });
  }

  const hashInput = files.map((file) => `${file.path}\n${file.sha256}\n${file.size_bytes}\n`).join("");

  return {
    role,
    files,
    bundle_hash: sha256(hashInput),
  };
}
