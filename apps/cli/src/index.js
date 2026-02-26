#!/usr/bin/env node
import process from "node:process";

import { Command } from "commander";

import { registerDoctorCommand } from "./commands/doctor.js";

function red(text) {
  return `\u001b[31m${text}\u001b[0m`;
}

const program = new Command();

program.name("agent-swarm").description("CLI wrapper for AI orchestration control plane").version("0.1.0");

registerDoctorCommand(program);

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`${red("X")} ${error.message}\n`);
  process.exitCode = 1;
});
