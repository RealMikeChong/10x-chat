import { mkdir } from 'node:fs/promises';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { getIsolatedProfileDir, getSharedProfileDir } from '../paths.js';
import type { ProfileMode, ProviderName } from '../types.js';
import { acquireProfileLock, type ProfileLock } from './lock.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lock: ProfileLock;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  provider: ProviderName;
  headless?: boolean;
  /** Initial URL to navigate to after launch. */
  url?: string;
  /**
   * Profile mode: 'shared' uses a single browser with multiple tabs,
   * 'isolated' uses a per-provider browser (original behavior).
   * Defaults to 'shared'.
   */
  profileMode?: ProfileMode;
}

// ── Shared Browser Singleton ────────────────────────────────────
//
// In 'shared' mode, one Chromium persistent context stays alive and
// each provider gets its own tab (page). The context closes when
// the last tab closes.

interface SharedBrowserState {
  context: BrowserContext;
  lock: ProfileLock;
  pageCount: number;
  headless: boolean;
  profileDir: string;
}

let sharedState: SharedBrowserState | null = null;
let sharedLaunchPromise: Promise<SharedBrowserState> | null = null;

async function getOrCreateSharedBrowser(
  headless: boolean,
): Promise<SharedBrowserState> {
  // If already running with matching headless mode, reuse it
  if (sharedState && sharedState.headless === headless) {
    return sharedState;
  }

  // If a launch is in progress, wait for it (prevents double-launch race)
  if (sharedLaunchPromise) {
    const state = await sharedLaunchPromise;
    if (state.headless === headless) return state;
    // Headless mode mismatch — close existing and relaunch
    await closeSharedBrowser();
  }

  const profileDir = getSharedProfileDir();
  await mkdir(profileDir, { recursive: true });

  sharedLaunchPromise = (async () => {
    const lock = await acquireProfileLock(profileDir);

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 900 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      });
    } catch (error) {
      await lock.release();
      throw error;
    }

    const state: SharedBrowserState = {
      context,
      lock,
      pageCount: 0,
      headless,
      profileDir,
    };
    sharedState = state;
    sharedLaunchPromise = null;
    return state;
  })();

  return sharedLaunchPromise;
}

async function closeSharedBrowser(): Promise<void> {
  if (!sharedState) return;
  const state = sharedState;
  sharedState = null;
  sharedLaunchPromise = null;
  try {
    await state.context.close();
  } finally {
    await state.lock.release();
  }
}

/**
 * Launch a browser session for a provider.
 *
 * In 'shared' mode (default): reuses a single Chromium instance with one tab
 * per provider. All providers share cookies/login state. Concurrent sessions
 * run as separate tabs in the same browser.
 *
 * In 'isolated' mode: each provider gets its own Chromium instance and profile
 * directory. Separate login state, separate browser process.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const { provider, headless = true, url, profileMode = 'shared' } = opts;

  if (profileMode === 'isolated') {
    return launchIsolatedBrowser(opts);
  }

  // ── Shared mode: open a new tab in the shared browser ─────
  const state = await getOrCreateSharedBrowser(headless);
  state.pageCount++;

  let page: Page;
  try {
    // First call may reuse the blank tab that launchPersistentContext creates
    const existingPages = state.context.pages();
    const blankPage = existingPages.find(
      (p) => p.url() === 'about:blank' || p.url() === 'chrome://newtab/',
    );

    if (state.pageCount === 1 && blankPage) {
      page = blankPage;
    } else {
      page = await state.context.newPage();
    }

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
  } catch (error) {
    state.pageCount--;
    if (state.pageCount <= 0) {
      await closeSharedBrowser();
    }
    throw error;
  }

  const close = async () => {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
    } finally {
      if (sharedState) {
        sharedState.pageCount--;
        if (sharedState.pageCount <= 0) {
          await closeSharedBrowser();
        }
      }
    }
  };

  return { context: state.context, page, lock: state.lock, close };
}

/**
 * Launch an isolated browser (original behavior).
 * One Chromium instance per provider, separate profile dir.
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
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
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

/**
 * Force-close the shared browser (useful for cleanup/testing).
 */
export async function shutdownSharedBrowser(): Promise<void> {
  await closeSharedBrowser();
}
