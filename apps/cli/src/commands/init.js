import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { confirm, input } from "@inquirer/prompts";
import YAML from "yaml";

import { REQUIRED_TEMPLATE_CONTENT, REQUIRED_TEMPLATE_PATH } from "../constants/doctor.js";
import { DEFAULT_CONFIG_FILE } from "../config.js";

function green(text) {
  return `\u001b[32m${text}\u001b[0m`;
}

function red(text) {
  return `\u001b[31m${text}\u001b[0m`;
}

function yellow(text) {
  return `\u001b[33m${text}\u001b[0m`;
}

function validateIdentifier(value, fieldName) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${fieldName} is required.`;
  }
  if (/\s/.test(trimmed)) {
    return `${fieldName} cannot contain spaces.`;
  }
  return true;
}

function validateProjectV2Number(value) {
  return /^[1-9]\d*$/.test(value.trim()) ? true : "GitHub Project V2 Number must be a positive integer.";
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildConfigYaml({ owner, repo, projectV2Number }) {
  return YAML.stringify({
    target: {
      owner,
      repo,
      project_v2_number: projectV2Number,
    },
    auth: {
      github_token_env: "GITHUB_TOKEN",
    },
  });
}

export function registerInitCommand(program) {
  program
    .command("init")
    .description("Bootstrap local CLI config and required GitHub issue template.")
    .action(async () => {
      const owner = (
        await input({
          message: "Target GitHub Owner (User/Org)",
          validate: (value) => validateIdentifier(value, "Target GitHub Owner"),
        })
      ).trim();

      const repo = (
        await input({
          message: "Target GitHub Repository Name",
          validate: (value) => validateIdentifier(value, "Target GitHub Repository Name"),
        })
      ).trim();

      const projectV2Number = Number.parseInt(
        (
          await input({
            message: "GitHub Project V2 Number",
            validate: validateProjectV2Number,
          })
        ).trim(),
        10,
      );

      const cwd = process.cwd();
      const configPath = resolve(cwd, DEFAULT_CONFIG_FILE);
      const templatePath = resolve(cwd, REQUIRED_TEMPLATE_PATH);

      const configYaml = buildConfigYaml({ owner, repo, projectV2Number });
      const configAlreadyExists = await pathExists(configPath);

      if (configAlreadyExists) {
        const shouldOverwriteConfig = await confirm({
          message: `${DEFAULT_CONFIG_FILE} already exists. Overwrite it?`,
          default: false,
        });

        if (shouldOverwriteConfig) {
          await writeFile(configPath, configYaml, "utf8");
          process.stdout.write(`${green("✔")} Wrote ${DEFAULT_CONFIG_FILE}\n`);
        } else {
          process.stdout.write(`${yellow("!")} Kept existing ${DEFAULT_CONFIG_FILE}\n`);
        }
      } else {
        await writeFile(configPath, configYaml, "utf8");
        process.stdout.write(`${green("✔")} Wrote ${DEFAULT_CONFIG_FILE}\n`);
      }

      await mkdir(dirname(templatePath), { recursive: true });
      await writeFile(templatePath, REQUIRED_TEMPLATE_CONTENT, "utf8");
      process.stdout.write(`${green("✔")} Wrote ${REQUIRED_TEMPLATE_PATH}\n`);

      process.stdout.write(
        `${green("✔")} Init complete. Commit ${REQUIRED_TEMPLATE_PATH} and run pnpm doctor to verify your setup.\n`,
      );
    })
    .showHelpAfterError(red("Run with --help for usage details."));
}
