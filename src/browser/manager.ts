import { mkdir } from 'node:fs/promises';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { getIsolatedProfileDir, getSharedProfileDir } from '../paths.js';
import type { ProfileMode, ProviderName } from '../types.js';
import { acquireProfileLock, type ProfileLock } from './lock.js';
import { clearDaemonState, getOrLaunchBrowserDaemon, stopDaemon } from './daemon.js';
import { registerTab, unregisterTab } from './tabs.js';
import { loadStorageState, saveStorageState } from './state.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /** Profile lock (only set in isolated mode; null in shared mode). */
  lock: ProfileLock | null;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  provider: ProviderName;
  headless?: boolean;
  /** Initial URL to navigate to after launch. */
  url?: string;
  /**
   * Profile mode:
   * - 'shared': each process launches its own browser but loads shared
   *   cookies/storage from a common state file. Truly parallel across
   *   processes — no locks, no conflicts.
   * - 'isolated': per-provider persistent context with profile lock
   *   (original behavior).
   * Defaults to 'shared'.
   */
  profileMode?: ProfileMode;
  /**
   * If true, use a persistent context even in shared mode.
   * Used by `login` command which needs the user to interact and have
   * state auto-persisted to disk. After login, storage state is exported
   * for use by regular (non-persistent) shared sessions.
   */
  persistent?: boolean;
}

/** Chromium launch args shared by persistent/isolated modes. */
const CHROMIUM_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Launch a browser session for a provider.
 *
 * **Shared mode (default):** Each process gets its own Chromium instance
 * loaded with shared cookies from `~/.10x-chat/profiles/default/storage-state.json`.
 * Multiple `npx 10x-chat` processes can run truly in parallel — no locks.
 * On close, updated cookies are saved back.
 *
 * **Shared + persistent** (login only): Uses `launchPersistentContext` on the
 * shared profile dir so the user can interact and cookies auto-persist.
 * Requires profile lock (only one login at a time).
 *
 * **Isolated mode:** Each provider gets its own persistent Chromium context
 * and profile directory. Original behavior with profile lock.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { profileMode = 'shared', persistent = false } = opts;

  if (profileMode === 'isolated') {
    return launchIsolatedBrowser(opts);
  }

  if (persistent) {
    return launchSharedPersistentBrowser(opts);
  }

  return launchSharedBrowser(opts);
}

/**
 * Shared mode (non-persistent): connects to or launches a shared browser daemon.
 * Multiple CLI invocations share the same Chromium process. Browser is only
 * stopped when the last tab (across all invocations) is closed.
 */
async function launchSharedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;

  // Connect to or launch the shared browser daemon
  const browser = await getOrLaunchBrowserDaemon(headless);

  // Register this tab in the disk-persisted ref count
  const tabKey = await registerTab();

  let context: BrowserContext;
  let page: Page;
  try {
    // Load shared cookies/storage if available
    const statePath = await loadStorageState();
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(statePath ? { storageState: statePath } : {}),
    });

    page = await context.newPage();

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    // Unregister tab on failure
    await unregisterTab(tabKey);
    throw error;
  }

  const close = async () => {
    // Save updated cookies/storage back to shared state
    try {
      await saveStorageState(context);
    } catch {
      // best effort
    }

    // Close just this page and context (not the whole browser)
    try {
      await page.close();
    } catch {
      // already closed
    }
    try {
      await context.close();
    } catch {
      // already closed
    }

    // Unregister tab and check if we're the last one
    const remaining = await unregisterTab(tabKey);
    if (remaining === 0) {
      // Last tab — stop the browser daemon entirely
      await stopDaemon();
    }
    // else: other tabs still open — leave daemon running
  };

  return { context, page, lock: null, close };
}

/**
 * Shared mode (persistent): for login command.
 * Uses persistent context so cookies auto-save to disk.
 * Requires lock since persistent contexts can't share a profile dir.
 */
async function launchSharedPersistentBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { headless = true, url } = opts;
  const profileDir = getSharedProfileDir();
  await mkdir(profileDir, { recursive: true });

  const lock = await acquireProfileLock(profileDir);

  let context: BrowserContext;
  let page: Page;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: CHROMIUM_ARGS,
    });

    page = context.pages()[0] ?? (await context.newPage());

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  const close = async () => {
    try {
      // Export storage state for non-persistent sessions to use
      await saveStorageState(context);
    } catch {
      // best effort
    }
    try {
      await context.close();
    } finally {
      await lock.release();
    }
  };

  return { context, page, lock, close };
}

/**
 * Isolated mode (original behavior).
 * Per-provider persistent context with profile lock.
 */
async function launchIsolatedBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { provider, headless = true, url } = opts;
  const profileDir = getIsolatedProfileDir(provider);
  await mkdir(profileDir, { recursive: true });

  const lock = await acquireProfileLock(profileDir);

  let context: BrowserContext;
  let page: Page;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: CHROMIUM_ARGS,
    });

    page = context.pages()[0] ?? (await context.newPage());

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    await lock.release();
    throw error;
  }

  const close = async () => {
    try {
      await context.close();
    } finally {
      await lock.release();
    }
  };

  return { context, page, lock, close };
}
