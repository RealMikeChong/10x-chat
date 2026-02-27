import chalk from 'chalk';
import { Command } from 'commander';
import { runVideo } from '../core/video-orchestrator.js';
import type { VideoMode, VideoModel, VideoOrientation } from '../types.js';

const VALID_MODES = ['ingredients', 'frames'] as const;
const VALID_MODELS = [
  'Veo 3.1 - Fast',
  'Veo 3.1 - Fast [Lower Priority]',
  'Veo 3.1 - Quality',
  'Veo 2 - Fast',
  'Veo 2 - Quality',
] as const;
const VALID_ORIENTATIONS = ['landscape', 'portrait'] as const;

export function createVideoCommand(): Command {
  const cmd = new Command('video')
    .description('Generate video with Google Flow (Veo 3.1) via browser automation')
    .requiredOption('-p, --prompt <text>', 'The video generation prompt')
    .option('--mode <mode>', 'Video mode: ingredients (default) or frames', 'ingredients')
    .option('--model <name>', 'Veo model name', 'Veo 3.1 - Fast')
    .option('--orientation <dir>', 'landscape (default) or portrait', 'landscape')
    .option('--count <n>', 'Number of simultaneous generations (1-4)', '1')
    .option('--start-frame <path>', 'Path to first keyframe image (frames mode)')
    .option('--end-frame <path>', 'Path to last keyframe image (frames mode)')
    .option('--headed', 'Show browser window during generation')
    .option('--timeout <ms>', 'Generation timeout in milliseconds', '600000')
    .option('--save-dir <dir>', 'Directory to save generated videos')
    .option('--isolated-profile', 'Use per-provider browser profiles')
    .action(async (options) => {
      // Validate mode
      const mode = options.mode as string;
      if (!VALID_MODES.includes(mode as VideoMode)) {
        console.error(
          chalk.red(`Invalid mode: ${mode}. Must be one of: ${VALID_MODES.join(', ')}`),
        );
        process.exit(1);
      }

      // Validate model
      const model = options.model as string;
      if (!VALID_MODELS.includes(model as VideoModel)) {
        console.error(
          chalk.red(`Invalid model: ${model}. Must be one of:\n  ${VALID_MODELS.join('\n  ')}`),
        );
        process.exit(1);
      }

      // Validate orientation
      const orientation = options.orientation as string;
      if (!VALID_ORIENTATIONS.includes(orientation as VideoOrientation)) {
        console.error(
          chalk.red(`Invalid orientation: ${orientation}. Must be: landscape or portrait`),
        );
        process.exit(1);
      }

      // Validate count
      const count = Number.parseInt(options.count, 10);
      if (![1, 2, 3, 4].includes(count)) {
        console.error(chalk.red('Count must be 1, 2, 3, or 4'));
        process.exit(1);
      }

      // Validate frames mode requires at least one keyframe
      if (mode === 'frames' && !options.startFrame && !options.endFrame) {
        console.error(chalk.red('Frames mode requires --start-frame and/or --end-frame'));
        process.exit(1);
      }

      try {
        console.log(chalk.bold.blue('🎬 Google Flow Video Generation\n'));

        const result = await runVideo({
          prompt: options.prompt,
          mode: mode as VideoMode,
          model: model as VideoModel,
          orientation: orientation as VideoOrientation,
          count: count as 1 | 2 | 3 | 4,
          startFrame: options.startFrame,
          endFrame: options.endFrame,
          headed: options.headed,
          timeoutMs: (() => {
            const t = Number.parseInt(options.timeout, 10);
            return Number.isFinite(t) && t > 0 ? t : 600_000;
          })(),
          saveDir: options.saveDir,
          isolatedProfile: options.isolatedProfile,
        });

        console.log('');
        console.log(chalk.bold.green(`--- ${result.message} ---\n`));

        if (result.videos.length > 0) {
          for (const vid of result.videos) {
            if (vid.localPath) {
              console.log(chalk.green(`  🎬 ${vid.localPath}`));
            }
          }
        }

        console.log('');
        console.log(chalk.dim(`Session: ${result.sessionId}`));
        console.log(chalk.dim(`Duration: ${Math.round(result.durationMs / 1000)}s`));
        if (result.truncated) {
          console.log(chalk.yellow('⚠ Generation may not be complete (timeout reached)'));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    });

  return cmd;
}
