import { stat } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';

/**
 * Resolve file paths (supports globs) to absolute file paths.
 * Validates that all resolved paths exist and are files.
 */
export async function resolveAttachPaths(patterns: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const pattern of patterns) {
    // Check if it's a glob or a literal path
    if (/[*?{}[\]]/.test(pattern)) {
      const matches = await fg(pattern, { absolute: true, onlyFiles: true });
      if (matches.length === 0) {
        throw new Error(`No files matched attachment pattern: ${pattern}`);
      }
      resolved.push(...matches);
    } else {
      const abs = path.resolve(pattern);
      try {
        const s = await stat(abs);
        if (s.isFile()) {
          resolved.push(abs);
        } else {
          console.warn(chalk.yellow(`Skipping directory: ${pattern}`));
        }
      } catch {
        throw new Error(`Attachment not found: ${pattern}`);
      }
    }
  }

  // Deduplicate in case overlapping globs resolved the same file
  return [...new Set(resolved)];
}
