import { mkdir } from 'node:fs/promises';
import chalk from 'chalk';
import { Command } from 'commander';
import { chromium } from 'playwright';
import { acquireProfileLock } from '../browser/index.js';
import { launchBrowser } from '../browser/index.js';
import { saveStorageState } from '../browser/state.js';
import { loadConfig } from '../config.js';
import { getSharedProfileDir } from '../paths.js';
import { getProvider, isValidProvider, listProviders } from '../providers/index.js';
import type { ProfileMode, ProviderName } from '../types.js';

export function createLoginCommand(): Command {
  const cmd = new Command('login')
    .description('Login to an AI provider (opens browser for authentication)')
    .argument('[provider]', 'Provider to login to (chatgpt, gemini, claude, grok)')
    .option('--all', 'Login to all providers')
    .option('--tabs', 'Open all providers as tabs in one browser window (use with --all)')
    .option('--status', 'Check login status for all providers')
    .option('--isolated-profile', 'Use per-provider browser profiles (backward compat)')
    .action(
      async (
        providerArg?: string,
        options?: { all?: boolean; tabs?: boolean; status?: boolean; isolatedProfile?: boolean },
      ) => {
        const config = await loadConfig();
        const profileMode: ProfileMode = options?.isolatedProfile ? 'isolated' : config.profileMode;

        if (options?.status) {
          await checkLoginStatus(profileMode);
          return;
        }

        if (profileMode === 'shared') {
          console.log(
            chalk.dim(
              'Using shared profile (all providers share one browser profile). Use --isolated-profile for per-provider.',
            ),
          );
        }

        if (options?.all) {
          if (options?.tabs) {
            await loginAllWithTabs(listProviders(), profileMode);
          } else {
            for (const name of listProviders()) {
              await loginToProvider(name, profileMode);
            }
          }
          return;
        }

        if (!providerArg) {
          console.log(chalk.yellow('Usage: 10x-chat login <provider>'));
          console.log(chalk.dim(`Available providers: ${listProviders().join(', ')}`));
          if (profileMode === 'shared') {
            console.log(
              chalk.dim('Tip: In shared mode, login to one provider and all share the session.'),
            );
          }
          return;
        }

        if (!isValidProvider(providerArg)) {
          console.log(chalk.red(`Unknown provider: ${providerArg}`));
          console.log(chalk.dim(`Available: ${listProviders().join(', ')}`));
          process.exit(1);
        }

        await loginToProvider(providerArg, profileMode);
      },
    );

  return cmd;
}

async function loginToProvider(
  providerName: ProviderName,
  profileMode: ProfileMode = 'shared',
): Promise<void> {
  const provider = getProvider(providerName);
  console.log(chalk.blue(`Opening ${provider.config.displayName} for login...`));
  console.log(chalk.dim('Please login in the browser window. The session will be saved.'));

  const browser = await launchBrowser({
    provider: providerName,
    headless: false, // Always headed for login
    url: provider.config.loginUrl,
    profileMode,
    persistent: true, // Login needs persistent context to auto-save cookies
  });

  try {
    // Wait for the user to login — poll until logged in or timeout
    const timeoutMs = 5 * 60 * 1000; // 5 minutes to login
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const loggedIn = await provider.actions.isLoggedIn(browser.page);
      if (loggedIn) {
        console.log(chalk.green(`✓ Logged in to ${provider.config.displayName}`));
        return;
      }
      await browser.page.waitForTimeout(2000);
    }

    console.log(chalk.yellow('Login timed out. You can try again.'));
  } finally {
    await browser.close();
  }
}

/**
 * Open all providers as tabs in a single browser window.
 * User can switch between tabs to login to each provider.
 * Waits until all are logged in (or timeout), then saves and closes.
 */
async function loginAllWithTabs(
  providers: ProviderName[],
  profileMode: ProfileMode = 'shared',
): Promise<void> {
  console.log(chalk.blue(`Opening ${providers.length} providers as tabs in one browser window...`));
  console.log(chalk.dim('Login to each tab. Window will close automatically when all are done.\n'));

  const CHROMIUM_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  const profileDir = getSharedProfileDir();
  await mkdir(profileDir, { recursive: true });
  const lock = await acquireProfileLock(profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: CHROMIUM_ARGS,
  });

  try {
    // Open first provider in the default page, rest in new tabs
    const pages: Array<{ name: ProviderName; page: Awaited<ReturnType<typeof context.newPage>> }> =
      [];

    const firstPage = context.pages()[0] ?? (await context.newPage());
    const [firstProvider, ...restProviders] = providers;

    if (firstProvider) {
      const provider = getProvider(firstProvider);
      await firstPage.goto(provider.config.loginUrl, { waitUntil: 'domcontentloaded' });
      pages.push({ name: firstProvider, page: firstPage });
    }

    for (const name of restProviders) {
      const provider = getProvider(name);
      const tab = await context.newPage();
      await tab.goto(provider.config.loginUrl, { waitUntil: 'domcontentloaded' });
      pages.push({ name, page: tab });
    }

    console.log(
      chalk.dim(`Tabs open: ${providers.map((p) => getProvider(p).config.displayName).join(', ')}`),
    );
    console.log(chalk.dim('Waiting for all logins... (5 min timeout)\n'));

    const timeoutMs = 5 * 60 * 1000;
    const startTime = Date.now();
    const done = new Set<ProviderName>();

    while (Date.now() - startTime < timeoutMs && done.size < pages.length) {
      for (const { name, page } of pages) {
        if (done.has(name)) continue;
        try {
          const provider = getProvider(name);
          const loggedIn = await provider.actions.isLoggedIn(page);
          if (loggedIn) {
            done.add(name);
            console.log(chalk.green(`✓ Logged in to ${provider.config.displayName}`));
          }
        } catch {
          // page may have navigated; skip this tick
        }
      }
      if (done.size < pages.length) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (done.size < pages.length) {
      const pending = pages
        .filter((p) => !done.has(p.name))
        .map((p) => getProvider(p.name).config.displayName);
      console.log(chalk.yellow(`\nTimeout — still not logged in: ${pending.join(', ')}`));
    } else {
      console.log(chalk.green('\n✓ All providers logged in! Saving session...'));
    }

    await saveStorageState(context);
  } finally {
    try {
      await context.close();
    } catch {
      // ignore
    }
    await lock.release();
  }
}

async function checkLoginStatus(profileMode: ProfileMode = 'shared'): Promise<void> {
  console.log(chalk.bold('Login Status\n'));
  if (profileMode === 'shared') {
    console.log(chalk.dim('(shared profile mode — all providers use the same browser profile)\n'));
  }

  for (const name of listProviders()) {
    const provider = getProvider(name);
    try {
      const browser = await launchBrowser({
        provider: name,
        headless: true,
        url: provider.config.url,
        profileMode,
      });

      try {
        // Give the page a moment to load
        await browser.page.waitForTimeout(3000);
        const loggedIn = await provider.actions.isLoggedIn(browser.page);
        const status = loggedIn ? chalk.green('✓ logged in') : chalk.red('✗ not logged in');
        console.log(`  ${provider.config.displayName}: ${status}`);
      } finally {
        await browser.close();
      }
    } catch {
      console.log(`  ${provider.config.displayName}: ${chalk.dim('unable to check')}`);
    }
  }
}
