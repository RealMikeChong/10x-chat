#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command } from 'commander';
import { createChatCommand } from '../cli/chat.js';
import { createConfigCommand } from '../cli/config.js';
import { createLoginCommand } from '../cli/login.js';
import { createMigrateCommand } from '../cli/migrate.js';
import { createNotebookLMCommand } from '../cli/notebooklm.js';
import { createSkillCommand } from '../cli/skill.js';
import { createSessionCommand, createStatusCommand } from '../cli/status.js';
import { createVideoCommand } from '../cli/video.js';

// Read version from package.json at runtime (works for both src and dist)
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('10x-chat')
  .description('Chat with web AI agents (ChatGPT, Gemini, Claude) via browser automation')
  .version(pkg.version);

program.addCommand(createLoginCommand());
program.addCommand(createChatCommand());
program.addCommand(createVideoCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSkillCommand());
program.addCommand(createNotebookLMCommand());
program.addCommand(createMigrateCommand());

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
