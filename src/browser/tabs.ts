/**
 * Browser tab ref-counting via filesystem.
 *
 * Each active CLI session writes a file to ~/.10x-chat/browser-tabs/.
 * Filename: <pid>-<uuid>.tab
 *
 * On open:  registerTab()   → writes file, returns tabKey
 * On close: unregisterTab() → deletes file, returns remaining live count
 *
 * Stale tab files from crashed processes are cleaned up automatically
 * by checking PID liveness during unregister.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAppDir } from '../paths.js';

const TABS_DIR = 'browser-tabs';

function getTabsDir(): string {
  return path.join(getAppDir(), TABS_DIR);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Register a new tab. Returns a tabKey to pass to unregisterTab(). */
export async function registerTab(): Promise<string> {
  const dir = getTabsDir();
  await mkdir(dir, { recursive: true });

  const tabId = randomUUID();
  const tabKey = `${process.pid}-${tabId}`;
  const filePath = path.join(dir, `${tabKey}.tab`);

  await writeFile(filePath, JSON.stringify({ pid: process.pid, tabId, createdAt: new Date().toISOString() }));
  return tabKey;
}

/**
 * Unregister a tab and return the remaining live tab count.
 * Stale files from dead processes are cleaned up during this call.
 */
export async function unregisterTab(tabKey: string): Promise<number> {
  const dir = getTabsDir();

  // Remove this tab's file
  try {
    await rm(path.join(dir, `${tabKey}.tab`), { force: true });
  } catch {
    // already gone
  }

  // Count remaining live tabs, cleaning up stale ones
  try {
    const files = await readdir(dir);
    const tabFiles = files.filter((f) => f.endsWith('.tab'));

    let liveCount = 0;
    for (const f of tabFiles) {
      const pid = Number.parseInt(f.split('-')[0], 10);
      if (Number.isNaN(pid) || !isProcessAlive(pid)) {
        // Stale — clean up
        try {
          await rm(path.join(dir, f), { force: true });
        } catch {
          // ignore
        }
      } else {
        liveCount++;
      }
    }
    return liveCount;
  } catch {
    return 0;
  }
}

/** Get current live tab count without modifying anything. */
export async function getLiveTabCount(): Promise<number> {
  const dir = getTabsDir();
  try {
    const files = await readdir(dir);
    const tabFiles = files.filter((f) => f.endsWith('.tab'));
    let count = 0;
    for (const f of tabFiles) {
      const pid = Number.parseInt(f.split('-')[0], 10);
      if (!Number.isNaN(pid) && isProcessAlive(pid)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}
