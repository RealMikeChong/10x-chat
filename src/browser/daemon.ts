/**
 * Browser daemon — shared long-running Chromium process.
 *
 * Persists a browser server's PID + WS endpoint to disk so that separate
 * CLI invocations can connect to the same browser instead of launching a
 * new one each time.
 *
 * Usage:
 *   const browser = await getOrLaunchBrowserDaemon(headless);
 *   // ... use browser ...
 *   // On close: call stopDaemon() only when tab count hits zero.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, chromium } from 'playwright';
import { getAppDir } from '../paths.js';

const DAEMON_FILE = 'browser-daemon.json';

const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

export interface DaemonState {
  /** PID of the Chromium server process. */
  pid: number;
  /** Playwright WS endpoint for chromium.connect(). */
  wsEndpoint: string;
  headless: boolean;
  createdAt: string;
}

export function getDaemonStatePath(): string {
  return path.join(getAppDir(), DAEMON_FILE);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDaemonState(): Promise<DaemonState | null> {
  try {
    const raw = await readFile(getDaemonStatePath(), 'utf-8');
    const state = JSON.parse(raw) as DaemonState;
    if (!state.pid || !state.wsEndpoint) return null;
    if (!isProcessAlive(state.pid)) {
      await clearDaemonState();
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function writeDaemonState(state: DaemonState): Promise<void> {
  const p = getDaemonStatePath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(state, null, 2));
}

export async function clearDaemonState(): Promise<void> {
  try {
    await rm(getDaemonStatePath(), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Stop the daemon browser by killing its server process.
 * Safe to call even if daemon is not running.
 */
export async function stopDaemon(): Promise<void> {
  const state = await readDaemonState();
  if (state) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // already dead
    }
    await clearDaemonState();
  }
}

/**
 * Get an existing browser daemon (reconnect) or launch a new one.
 * Returns a Playwright Browser connected to the shared server process.
 *
 * The returned Browser is a client connection — calling browser.close() on it
 * disconnects this client but does NOT stop the server. Call stopDaemon()
 * when you actually want to shut the server down (i.e. last tab closed).
 */
export async function getOrLaunchBrowserDaemon(headless = true): Promise<Browser> {
  const existing = await readDaemonState();

  if (existing) {
    try {
      const browser = await chromium.connect(existing.wsEndpoint, { timeout: 5_000 });
      return browser;
    } catch {
      // Server died without cleaning up state
      await clearDaemonState();
    }
  }

  // Launch a new browser server
  const server = await chromium.launchServer({
    headless,
    args: CHROMIUM_ARGS,
  });

  const pid = server.process().pid ?? -1;
  const wsEndpoint = server.wsEndpoint();

  await writeDaemonState({ pid, wsEndpoint, headless, createdAt: new Date().toISOString() });

  // Clean up state file if server exits unexpectedly
  server.process().once('exit', () => {
    void clearDaemonState();
  });

  return chromium.connect(wsEndpoint);
}
