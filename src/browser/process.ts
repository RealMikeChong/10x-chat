/**
 * Shared browser process utilities.
 *
 * Extracted from daemon.ts, lock.ts, tabs.ts, and manager.ts to eliminate
 * duplication of isProcessAlive() and CHROMIUM_ARGS.
 */

/** Check if a process is still alive by sending signal 0. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Chromium launch args shared by all browser modes. */
export const CHROMIUM_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];
