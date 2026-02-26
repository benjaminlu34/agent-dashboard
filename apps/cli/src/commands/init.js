import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { confirm, input } from "@inquirer/prompts";
import YAML from "yaml";

import { REQUIRED_TEMPLATE_CONTENT, REQUIRED_TEMPLATE_PATH } from "../constants/doctor.js";
import { DEFAULT_CONFIG_FILE } from "../config.js";
import { green, red, yellow } from "../util/colors.js";

function validateIdentifier(value, fieldName) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${fieldName} is required.`;
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(trimmed)) {
    return `${fieldName} contains invalid characters. Only alphanumeric, hyphens, and periods are allowed.`;
  }
  return true;
}

function validateProjectV2Number(value) {
  return /^[1-9]\d*$/.test(value.trim()) ? true : "GitHub Project V2 Number must be a positive integer.";
}

async function promptTrimmedInput({ message, validate }) {
  return (await input({ message, validate })).trim();
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

async function writeFileWithSuccessMessage(path, content, label) {
  await writeFile(path, content, "utf8");
  process.stdout.write(`${green("✔")} Wrote ${label}\n`);
}

export function registerInitCommand(program) {
  program
    .command("init")
    .description("Bootstrap local CLI config and required GitHub issue template.")
    .action(async () => {
      const owner = await promptTrimmedInput({
        message: "Target GitHub Owner (User/Org)",
        validate: (value) => validateIdentifier(value, "Target GitHub Owner"),
      });

      const repo = await promptTrimmedInput({
        message: "Target GitHub Repository Name",
        validate: (value) => validateIdentifier(value, "Target GitHub Repository Name"),
      });

      const projectV2Number = Number.parseInt(
        await promptTrimmedInput({
          message: "GitHub Project V2 Number",
          validate: validateProjectV2Number,
        }),
        10,
      );

      const cwd = process.cwd();
      const configPath = resolve(cwd, DEFAULT_CONFIG_FILE);
      const templatePath = resolve(cwd, REQUIRED_TEMPLATE_PATH);

      const configYaml = buildConfigYaml({ owner, repo, projectV2Number });
      const configAlreadyExists = await pathExists(configPath);
      let shouldWriteConfig = true;
      if (configAlreadyExists) {
        shouldWriteConfig = await confirm({
          message: `${DEFAULT_CONFIG_FILE} already exists. Overwrite it?`,
          default: false,
        });
      }

      if (shouldWriteConfig) {
        await writeFileWithSuccessMessage(configPath, configYaml, DEFAULT_CONFIG_FILE);
      } else {
        process.stdout.write(`${yellow("!")} Kept existing ${DEFAULT_CONFIG_FILE}\n`);
      }

      await mkdir(dirname(templatePath), { recursive: true });
      await writeFileWithSuccessMessage(templatePath, REQUIRED_TEMPLATE_CONTENT, REQUIRED_TEMPLATE_PATH);

      process.stdout.write(
        `${green("✔")} Init complete. Commit ${REQUIRED_TEMPLATE_PATH} and run pnpm doctor to verify your setup.\n`,
      );
    })
    .showHelpAfterError(red("Run with --help for usage details."));
}
