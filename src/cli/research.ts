import chalk from 'chalk';
import { Command } from 'commander';
import { runResearch } from '../core/research-orchestrator.js';
import { isValidProvider } from '../providers/index.js';
import type { ProviderName, ResearchResult } from '../types.js';

const RESEARCH_PROVIDERS: ProviderName[] = ['chatgpt', 'gemini', 'perplexity'];

export function createResearchCommand(): Command {
  const cmd = new Command('research')
    .description(
      'Deep research via ChatGPT, Gemini, or Perplexity — non-blocking with progress polling',
    )
    .requiredOption('-p, --prompt <text>', 'The research query')
    .option('--provider <name>', `Provider (${RESEARCH_PROVIDERS.join(', ')})`, 'gemini')
    .option('--model <name>', 'Model/mode to select before starting research')
    .option('--headed', 'Show browser window')
    .option('--timeout <ms>', 'Total timeout in milliseconds', '600000')
    .option('--poll-interval <ms>', 'Progress check interval in milliseconds', '5000')
    .option('--save-dir <dir>', 'Directory to save the research report')
    .option('--isolated-profile', 'Use per-provider browser profiles')
    .action(async (options) => {
      const provider = (options.provider as string) ?? 'gemini';
      if (!isValidProvider(provider)) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        process.exit(1);
      }
      if (!RESEARCH_PROVIDERS.includes(provider as ProviderName)) {
        console.error(
          chalk.red(
            `Provider "${provider}" does not support deep research. Use: ${RESEARCH_PROVIDERS.join(', ')}`,
          ),
        );
        process.exit(1);
      }

      const timeoutMs = (() => {
        const t = Number.parseInt(options.timeout, 10);
        return Number.isFinite(t) && t > 0 ? t : 600_000;
      })();

      const pollIntervalMs = (() => {
        const t = Number.parseInt(options.pollInterval, 10);
        return Number.isFinite(t) && t > 0 ? t : 5_000;
      })();

      try {
        console.log(chalk.bold.blue('🔬 Deep Research\n'));

        const result = await runResearch({
          prompt: options.prompt,
          provider: provider as ProviderName,
          headed: options.headed,
          timeoutMs,
          pollIntervalMs,
          model: options.model,
          saveDir: options.saveDir,
          isolatedProfile: options.isolatedProfile,
        });

        renderResearchResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  return cmd;
}

function renderResearchResult(result: ResearchResult): void {
  console.log('');
  console.log(chalk.bold.green('--- Research Report ---\n'));
  console.log(result.report);
  console.log('');

  if (result.savedPath) {
    console.log(chalk.green(`📄 Saved: ${result.savedPath}`));
  }
  console.log(chalk.dim(`Session: ${result.sessionId}`));
  console.log(chalk.dim(`Provider: ${result.provider}`));
  console.log(chalk.dim(`Duration: ${Math.round(result.durationMs / 1000)}s`));
  if (result.truncated) {
    console.log(chalk.yellow('⚠ Report may be incomplete (timeout reached)'));
  }
}
