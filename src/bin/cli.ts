#!/usr/bin/env node

import chalk from 'chalk';
import { Command } from 'commander';
import { createChatCommand } from '../cli/chat.js';
import { createConfigCommand } from '../cli/config.js';
import { createLoginCommand } from '../cli/login.js';
import { createNotebookLMCommand } from '../cli/notebooklm.js';
import { createSkillCommand } from '../cli/skill.js';
import { createSessionCommand, createStatusCommand } from '../cli/status.js';

const program = new Command();

program
  .name('10x-chat')
  .description('Chat with web AI agents (ChatGPT, Gemini, Claude) via browser automation')
  .version('0.1.0');

program.addCommand(createLoginCommand());
program.addCommand(createChatCommand());
program.addCommand(createStatusCommand());
program.addCommand(createSessionCommand());
program.addCommand(createConfigCommand());
program.addCommand(createSkillCommand());
program.addCommand(createNotebookLMCommand());

program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
