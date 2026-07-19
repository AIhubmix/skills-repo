#!/usr/bin/env node

import { addCommand } from './commands/add.mjs';
import { listCommand } from './commands/list.mjs';
import { removeCommand } from './commands/remove.mjs';
import { AGENTS } from "./lib/agents.mjs";
import { getPackageVersion } from "./lib/config.mjs";

const COMMANDS = {
  add: addCommand,
  list: listCommand,
  remove: removeCommand,
};

function printHelp() {
  const agentsList = Object.keys(AGENTS).join(", ");
  console.log(`
aiskill - AI Agent Skills Manager

Usage:
  npx aiskill <command> [options]

Commands:
  add <skill-name>     Install a skill from the registry
  list                 List all available skills
  remove <skill-name>  Remove an installed skill

Options:
  --agent <name>       Target agent (${agentsList})
                       Default: claude
  --scope <scope>      Installation scope (project, global)
                       Default: project
  --registry <url>     Custom registry URL
                       Default: $SKILL_REGISTRY_URL or package repository URL
  --ref <ref>          Git ref (branch or tag) used by some commands
                       Default: $SKILL_REGISTRY_REF or "main"
  --help, -h          Show this help message
  --version, -v       Show version

Examples:
  # Install a skill to Claude Code (project scope)
  npx aiskill add ui-ux-pro-max --agent claude --scope project

  # Install a skill to Codex globally
  npx aiskill add ui-ux-pro-max --agent codex --scope global

  # List all available skills
  npx aiskill list

  # Remove a skill
  npx aiskill remove ui-ux-pro-max --agent claude --scope project

For more information, visit: https://github.com/AIhubmix/skills-repo
`);
}

async function printVersion() {
  const version = await getPackageVersion();
  console.log(`aiskill v${version}`);
}

async function main() {
  const args = process.argv.slice(2);

  // Handle no arguments
  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = args[0];

  // Handle help flag
  if (command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  // Handle version flag
  if (command === '--version' || command === '-v') {
    await printVersion();
    process.exit(0);
  }

  // Get command handler
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Error: Unknown command "${command}"`);
    console.error('Run "npx aiskill --help" to see available commands');
    process.exit(1);
  }

  // Execute command
  try {
    await handler(args.slice(1));
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
