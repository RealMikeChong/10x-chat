import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { getSharedProfileDir } from '../paths.js';

const STATE_FILENAME = 'storage-state.json';

/** Path to the shared storage state file. */
export function getStorageStatePath(): string {
  return path.join(getSharedProfileDir(), STATE_FILENAME);
}

/**
 * Load storage state for shared mode.
 * Returns the path if it exists, undefined otherwise.
 * Playwright's `newContext({ storageState })` accepts a path string.
 */
export async function loadStorageState(): Promise<string | undefined> {
  const statePath = getStorageStatePath();
  try {
    const raw = await readFile(statePath, 'utf-8');
    // Validate it's parseable JSON with the expected shape
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.cookies) || Array.isArray(parsed.origins)) {
      return statePath;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save storage state from a browser context.
 * Uses atomic write (temp file + rename) to prevent corruption
 * if multiple processes save concurrently.
 */
export async function saveStorageState(context: BrowserContext): Promise<void> {
  const statePath = getStorageStatePath();
  const dir = path.dirname(statePath);
  await mkdir(dir, { recursive: true });

  // Atomic write: save to temp file, then rename
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  try {
    await context.storageState({ path: tmpPath });
    await rename(tmpPath, statePath);
  } catch {
    // Best effort — don't crash if save fails
    try {
      const { rm } = await import('node:fs/promises');
      await rm(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }
}
