import chalk from 'chalk';
import { Command } from 'commander';
import { buildBundle } from '../core/bundle.js';
import { runChat } from '../core/index.js';
import { isValidProvider } from '../providers/index.js';
import type { ProviderName } from '../types.js';

export function createChatCommand(): Command {
  const cmd = new Command('chat')
    .description('Chat with an AI provider via browser automation')
    .requiredOption('-p, --prompt <text>', 'The prompt to send')
    .option('--provider <name>', 'Provider to use (chatgpt, gemini, claude, grok)')
    .option('--model <name>', 'Model to select')
    .option('-f, --file <paths...>', 'Files/globs to include as context')
    .option('--copy', 'Copy the bundle to clipboard instead of sending')
    .option('--dry-run', 'Preview the bundle without sending')
    .option('--headed', 'Show browser window during chat')
    .option('--timeout <ms>', 'Response timeout in milliseconds', '300000')
    .action(async (options) => {
      const provider = options.provider as string | undefined;
      if (provider && !isValidProvider(provider)) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        process.exit(1);
      }

      // Dry run: just show the bundle
      if (options.dryRun) {
        const bundle = await buildBundle({
          prompt: options.prompt,
          files: options.file,
        });
        console.log(chalk.bold('--- Bundle Preview ---\n'));
        console.log(bundle);
        console.log(chalk.bold('\n--- End Preview ---'));
        return;
      }

      // Copy to clipboard
      if (options.copy) {
        const bundle = await buildBundle({
          prompt: options.prompt,
          files: options.file,
        });
        const { default: clipboardy } = await import('clipboardy');
        await clipboardy.write(bundle);
        console.log(chalk.green('✓ Bundle copied to clipboard'));
        console.log(chalk.dim(`${bundle.length} characters`));
        return;
      }

      // Run the chat
      try {
        const result = await runChat({
          prompt: options.prompt,
          provider: provider as ProviderName | undefined,
          model: options.model,
          file: options.file,
          headed: options.headed,
          timeoutMs: Number.parseInt(options.timeout, 10),
        });

        console.log('');
        console.log(chalk.bold.green('--- Response ---\n'));
        console.log(result.response);
        console.log('');
        console.log(chalk.dim(`Session: ${result.sessionId}`));
        console.log(chalk.dim(`Duration: ${Math.round(result.durationMs / 1000)}s`));
        if (result.truncated) {
          console.log(chalk.yellow('⚠ Response may be truncated (timeout reached)'));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  return cmd;
}
